import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { Cli, OSPlatform, OSPlatformImpl } from "jive-abstract-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { AccountKeyImpl } from "@/modules/account-key/impl";
import type { AccountKey } from "@/modules/account-key/interface";
import { TerminalPromptImpl } from "@/modules/prompt/impl";
import { NoTerminalToAsk } from "@/modules/prompt/interface";
import { ProvisioningImpl } from "@/modules/provisioning/impl";
import { ModulesLayer } from "@/modules/runtime";
import { jive } from "@/program";

/**
 * Runs `jive load`, `on` and `unload` against a scratch workspace. Nothing reaches GitHub: a git config the test
 * owns (GIT_CONFIG_GLOBAL) rewrites https://github.com/ to a directory of local bare repos, and sign-in is a fake
 * user. HOME, which every tool jive starts reads, is a scratch directory too, and so is BUN_INSTALL, where `bun link`
 * registers packages.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "jive-program-test-")));
const remotes = path.join(scratch, "remotes");
const workspace = path.join(scratch, "workspace");
const bunHome = path.join(scratch, "bun-home");
const home = path.join(scratch, "home");
const originalDirectory = process.cwd();
const originalEnv = { ...process.env };
/** The workspace root's package.json, which marks it the workspace. */
const rootManifest = `${JSON.stringify({ private: true, jive: { root: true } })}\n`;

function sh(command: ReadonlyArray<string>, cwd: string): string {
  // Bun.spawnSync without env passes the environment the test started with, not the scratch git config.
  const result = Bun.spawnSync([...command], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

beforeAll(() => {
  mkdirSync(remotes, { recursive: true });
  mkdirSync(home);
  const gitConfig = path.join(scratch, "gitconfig");
  writeFileSync(gitConfig, [
    // The acme repos only: longer than jive's own https://github.com/ rewrite to SSH, so git takes this one.
    `[url "file://${remotes}/acme/"]`, `\tinsteadOf = https://github.com/acme/`,
    `[protocol "file"]`, `\tallow = always`,
    `[user]`, `\tname = Jive Test`, `\temail = test@example.com`,
    `[init]`, `\tdefaultBranch = main`,
    `[commit]`, `\tgpgSign = false`,
  ].join("\n"));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", BUN_INSTALL: bunHome, HOME: home });

  // The repo `jive load acme widget` clones: no dependencies, so `bun install` stays offline, and a postinstall
  // script that marks the directory `bun install` ran in.
  const widgetSource = path.join(scratch, "widget-source");
  mkdirSync(widgetSource);
  writeFileSync(path.join(widgetSource, "package.json"), JSON.stringify({ name: "@acme/widget", version: "0.0.0", scripts: { postinstall: "pwd > installed-here.txt" } }));
  mkdirSync(path.join(remotes, "acme"));
  // A submodule of the widget, so `load` has a nested one to fetch. Its https URL resolves to a local bare repo too.
  const gadgetSource = path.join(scratch, "gadget-source");
  mkdirSync(gadgetSource);
  writeFileSync(path.join(gadgetSource, "gadget.txt"), "gadget\n");
  sh(["git", "init", "-q"], gadgetSource);
  sh(["git", "add", "."], gadgetSource);
  sh(["git", "commit", "-qm", "gadget"], gadgetSource);
  sh(["git", "clone", "-q", "--bare", gadgetSource, path.join(remotes, "acme", "gadget.git")], scratch);
  sh(["git", "init", "-q"], widgetSource);
  sh(["git", "submodule", "add", "-q", "https://github.com/acme/gadget.git", "gadget"], widgetSource);
  sh(["git", "add", "."], widgetSource);
  sh(["git", "commit", "-qm", "widget"], widgetSource);
  sh(["git", "clone", "-q", "--bare", widgetSource, path.join(remotes, "acme", "widget.git")], scratch);

  mkdirSync(workspace);
  writeFileSync(path.join(workspace, "package.json"), rootManifest);
  writeFileSync(path.join(workspace, "README.md"), "workspace\n");
  sh(["git", "init", "-q"], workspace);
  setWorkspaceIdentity(workspace);
  sh(["git", "add", "."], workspace);
  sh(["git", "commit", "-qm", "workspace"], workspace);

  // Proof, before anything writes, that a clone of the GitHub URL jive uses resolves to the local bare repo.
  expect(sh(["git", "ls-remote", "--get-url", "https://github.com/acme/widget.git"], workspace))
    .toBe(`file://${remotes}/acme/widget.git`);
  process.chdir(workspace);
});

afterAll(() => {
  process.chdir(originalDirectory);
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "BUN_INSTALL", "HOME"]) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** The persona every workspace these tests make commits as, unlike the global config's "Jive Test", so a copy shows. */
const persona = { name: "Zoë Ångström", email: "zoe@example.com" };
function setWorkspaceIdentity(root: string) {
  sh(["git", "config", "--local", "user.name", persona.name], root);
  sh(["git", "config", "--local", "user.email", persona.email], root);
}

const fakeAccountKey = (): AccountKey => {
  const publicKeyFile = path.join(scratch, "account.pub");
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl jive-test@jive.sh";
  writeFileSync(publicKeyFile, `${publicKey}\n`);
  return { publicKey, publicKeyFile };
};

/** The host as jive sees it, with its home in the scratch directory: Bun reads HOME once, at startup. */
const scratchHost = e.Layer.effect(OSPlatform, e.Effect.gen(function* () {
  const real = yield* OSPlatform;
  return Object.assign(Object.create(real), { *getHomeDirectory() { return home; } });
})).pipe(e.Layer.provide(OSPlatformImpl.Layer));

interface Outcome {
  readonly stdout: string;
  readonly exit: e.Exit.Exit<void, unknown>;
}

/** Runs jive in this process on `args`, the way the entrypoint does, with sign-in replaced by the fake user. */
const runJive = (args: ReadonlyArray<string>): Promise<Outcome> => runJiveWithPrompt({ args, prompt: e.Layer.empty });

/** `runJive`, with `prompt` answering every question jive asks in place of the terminal. */
async function runJiveWithPrompt({ args, prompt }: { readonly args: ReadonlyArray<string>; readonly prompt: e.Layer.Layer<never> | ReturnType<typeof TerminalPromptImpl.mockLayer> }): Promise<Outcome> {
  const stdout: Array<string> = [];
  const exit = await e.Effect.runPromise(e.pipe(
    Cli.run(jive, { version: "0.0.0-test" }),
    e.Effect.provide(prompt),
    // No test signs in to Jive: the account key is a fake, so nothing opens a sign-in page in the browser.
    e.Effect.provide(AccountKeyImpl.mockLayer({ *ensure() { return fakeAccountKey(); } })),
    e.Effect.provide(ProvisioningImpl.mockLayer({ *ensure(input: { kind: string; instance: unknown }) { provisioned.push(input); return { instanceId: "fake-instance" }; } })),
    e.Effect.provide(ModulesLayer),
    e.Effect.provide(scratchHost),
    e.Effect.provide(e.Stdio.layerTest({
      args: e.Effect.succeed(args),
      stdout: () => e.Sink.forEach((chunk: string | Uint8Array) => e.Effect.sync(() => {
        stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      })),
    })),
    e.Effect.provide(BunServices.layer),
    e.Effect.exit,
  ));
  return { stdout: stdout.join(""), exit };
}

const provisioned: Array<{ kind: string; instance: unknown }> = [];

const errorOf = (exit: e.Exit.Exit<void, unknown>) => e.Option.getOrUndefined(e.Exit.findErrorOption(exit));
const widget = () => path.join(workspace, "packages", "@acme", "widget");
const gitConfigIn = (directory: string, key: string) => sh(["git", "config", "--local", "--get", key], directory);

describe("jive in a workspace", () => {
  test("load clones the repo as a submodule, configures it to sign and push through jive, and installs it", async () => {
    const { exit } = await runJive(["load", "acme", "widget"]);
    expect(exit).toEqual(e.Exit.void);

    expect(JSON.parse(readFileSync(path.join(widget(), "package.json"), "utf8")).name).toBe("@acme/widget");
    expect(readFileSync(path.join(workspace, ".gitmodules"), "utf8")).toContain("url = https://github.com/acme/widget\n");
    expect(gitConfigIn(widget(), "url.git@github.com:.insteadOf")).toBe("https://github.com/");
    expect(gitConfigIn(widget(), "gpg.format")).toBe("ssh");
    expect(gitConfigIn(widget(), "commit.gpgSign")).toBe("true");
    expect(gitConfigIn(widget(), "user.signingKey")).toBe(path.join(scratch, "account.pub"));
    expect(gitConfigIn(widget(), "gpg.ssh.program")).toEndWith("/jive-ssh-sign");
    expect(gitConfigIn(widget(), "core.sshCommand")).toEndWith("/jive-ssh");
    expect(gitConfigIn(widget(), "ssh.variant")).toBe("ssh");
    expect(gitConfigIn(widget(), "user.name")).toBe(persona.name);
    expect(gitConfigIn(widget(), "user.email")).toBe(persona.email);
    // The widget's own submodule is fetched and configured too; .gitmodules records only https URLs.
    expect(readFileSync(path.join(widget(), "gadget", "gadget.txt"), "utf8")).toBe("gadget\n");
    expect(gitConfigIn(path.join(widget(), "gadget"), "gpg.ssh.program")).toEndWith("/jive-ssh-sign");
    expect(gitConfigIn(path.join(widget(), "gadget"), "core.sshCommand")).toEndWith("/jive-ssh");
    expect(gitConfigIn(path.join(widget(), "gadget"), "user.email")).toBe(persona.email);
    expect(readFileSync(path.join(workspace, ".gitmodules"), "utf8")).not.toContain("git@");
    expect(readFileSync(path.join(widget(), "installed-here.txt"), "utf8").trim()).toBe(widget());
    // Nothing registers in bun's global folder, where a registration would shadow a global install of the same name.
    expect(existsSync(path.join(bunHome, "install", "global", "node_modules", "@acme", "widget"))).toBe(false);
  }, 30_000);

  test("Tab lists the workspace's orgs, then the repos loaded under one", async () => {
    expect((await runJive(["--compgen", "on", ""])).stdout).toBe("acme\n");
    expect((await runJive(["--compgen", "unload", "acme", ""])).stdout).toBe("widget\n");
  });

  test("on runs the command in the repo's directory and passes its exit code on", async () => {
    expect((await runJive(["on", "acme", "widget", "--", "sh", "-c", "pwd > ran-here.txt"])).exit).toEqual(e.Exit.void);
    expect(readFileSync(path.join(widget(), "ran-here.txt"), "utf8").trim()).toBe(widget());

    const failing = errorOf((await runJive(["on", "acme", "widget", "--", "sh", "-c", "exit 3"])).exit);
    expect(failing instanceof Cli.CliError && failing.exitCode).toBe(3);
  });

  test("on refuses a command that is not installed, and a repo that is not loaded", async () => {
    const missing = errorOf((await runJive(["on", "acme", "widget", "--", "no-such-command-anywhere"])).exit);
    expect(missing).toBeInstanceOf(BadPreconditionsError);
    expect(missing instanceof BadPreconditionsError && missing.cause).toBe("Command `no-such-command-anywhere` is required but was not found");

    const notLoaded = errorOf((await runJive(["on", "acme", "gadget", "--", "ls"])).exit);
    expect(notLoaded).toEqual(new BadArgumentError({ argument: "repo", reason: `There is no repo "@acme/gadget" in this workspace` }));
  });

  test("unload removes the submodule, its entry and its git directory", async () => {
    expect((await runJive(["unload", "acme", "widget"])).exit).toEqual(e.Exit.void);
    expect(existsSync(widget())).toBe(false);
    expect(readFileSync(path.join(workspace, ".gitmodules"), "utf8")).not.toContain("acme/widget");
    expect(existsSync(path.join(workspace, ".git", "modules", "packages", "@acme", "widget"))).toBe(false);
  });

  test("provision sends the kind and the instance --instance gives, or the one package.json declares", async () => {
    provisioned.length = 0;
    expect((await runJive(["provision", "connector-package-registry", "@acme/widget", "--instance", '{"packageName":"@acme/widget"}'])).exit).toEqual(e.Exit.void);
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ jive: { root: true, resources: { "connector-package-registry": { "@acme/gadget": { packageName: "@acme/gadget" } } } } }));
    expect((await runJive(["provision", "connector-package-registry", "@acme/gadget"])).exit).toEqual(e.Exit.void);
    const undeclared = await runJive(["provision", "connector-package-registry", "@acme/missing"]);
    expect(errorOf(undeclared.exit)).toBeInstanceOf(BadArgumentError);
    writeFileSync(path.join(workspace, "package.json"), rootManifest);
    expect(provisioned).toEqual([
      { kind: "connector-package-registry", instance: { packageName: "@acme/widget" } },
      { kind: "connector-package-registry", instance: { packageName: "@acme/gadget" } },
    ]);
  });

  test("outside a workspace, a command says so", async () => {
    process.chdir(scratch);
    try {
      const error = errorOf((await runJive(["unload", "acme", "widget"])).exit);
      expect(error).toBeInstanceOf(BadPreconditionsError);
      expect(error instanceof BadPreconditionsError && error.cause).toBe(`${scratch} is not within a jive workspace: no package.json from here up says "jive": { "root": true }.`);
    } finally {
      process.chdir(workspace);
    }
  });
});

/**
 * `jive load` in monorepos shaped like the two it serves: open-empires (its submodules at `packages/<repo>`, whose
 * package names are scoped) and chaine (at `packages/<package name>`, scoped and not). Each monorepo is a fresh git
 * repository whose submodules come from the local bare repos, as `git submodule add` records them. The ones testing
 * placement, staging and adoption also hold an empty `.jive` directory, the mark jive 0.8.0 looked for, so on 0.8.0
 * each of them fails on the defect it tests rather than on finding the root.
 */
describe("jive load in a monorepo", () => {
  /** A repo on "GitHub" (a local bare repo) whose package.json names `packageName`. */
  function publish({ repo, packageName }: { readonly repo: string; readonly packageName: string }) {
    const source = path.join(scratch, "sources", repo);
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: packageName, version: "0.0.0" }));
    sh(["git", "init", "-q"], source);
    sh(["git", "add", "."], source);
    sh(["git", "commit", "-qm", repo], source);
    sh(["git", "clone", "-q", "--bare", source, path.join(remotes, "acme", `${repo}.git`)], scratch);
  }

  /**
   * A monorepo with the given submodules committed, the root mark or the 0.8.0 `.jive` directory, and `persona` as
   * its root's git identity unless `identity` is "none".
   */
  function monorepo({ name, mark, submodules, identity = "persona" }: {
    readonly name: string;
    readonly mark: "package.json" | ".jive" | "none";
    readonly submodules: ReadonlyArray<{ readonly repo: string; readonly path: string }>;
    readonly identity?: "persona" | "none";
  }): string {
    const root = path.join(scratch, "monorepos", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "README.md"), `${name}\n`);
    if (mark === "package.json") writeFileSync(path.join(root, "package.json"), rootManifest);
    if (mark === ".jive") mkdirSync(path.join(root, ".jive"));
    sh(["git", "init", "-q"], root);
    if (identity === "persona") setWorkspaceIdentity(root);
    for (const submodule of submodules) sh(["git", "submodule", "add", "-q", `https://github.com/acme/${submodule.repo}`, submodule.path], root);
    sh(["git", "add", "."], root);
    sh(["git", "commit", "-qm", name], root);
    return root;
  }

  async function runJiveIn(directory: string, args: ReadonlyArray<string>, prompt: Parameters<typeof runJiveWithPrompt>[0]["prompt"] = e.Layer.empty): Promise<Outcome> {
    process.chdir(directory);
    try {
      return await runJiveWithPrompt({ args, prompt });
    } finally {
      process.chdir(workspace);
    }
  }

  const loaded = async (root: string, repo: string) => {
    const { exit } = await runJiveIn(root, ["load", "acme", repo]);
    if (e.Exit.isFailure(exit)) throw new Error(`jive load acme ${repo} failed: ${JSON.stringify(e.Cause.squash(exit.cause))}`);
  };

  beforeAll(() => {
    publish({ repo: "aoe2-in-browser", packageName: "@acme/aoe2-in-browser" });
    publish({ repo: "open-empires-web", packageName: "@acme/open-empires-web" });
    publish({ repo: "decomp-project-image", packageName: "decomp-project-image" });
    publish({ repo: "jive", packageName: "@jive-sh/jive" });
    publish({ repo: "jive-abstract-library", packageName: "jive-abstract-library" });
    // A repo whose package name is not its repo name: its place follows the package name.
    publish({ repo: "server-repo", packageName: "@jive-sh/server" });
  });

  test("after jive init marks a plain monorepo's root package.json, jive load works in it", async () => {
    const root = monorepo({ name: "plain", mark: "none", submodules: [] });
    expect((await runJiveIn(root, ["init"])).exit).toEqual(e.Exit.void);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))).toEqual({ jive: { root: true } });
    await loaded(root, "decomp-project-image");
    expect(JSON.parse(readFileSync(path.join(root, "packages", "decomp-project-image", "package.json"), "utf8")).name).toBe("decomp-project-image");
  }, 30_000);

  test("init keeps every other field of an existing root package.json, and its indentation", async () => {
    const root = monorepo({ name: "with-manifest", mark: "none", submodules: [] });
    writeFileSync(path.join(root, "package.json"), `{\n    "name": "monorepo",\n    "jive": { "other": 1 }\n}\n`);
    expect((await runJiveIn(root, ["init"])).exit).toEqual(e.Exit.void);
    expect(readFileSync(path.join(root, "package.json"), "utf8"))
      .toBe(`{\n    "name": "monorepo",\n    "jive": {\n        "other": 1,\n        "root": true\n    }\n}\n`);
  }, 30_000);

  test("in a monorepo shaped like open-empires, load puts the repo at packages/<package name>", async () => {
    const root = monorepo({ name: "open-empires", mark: ".jive", submodules: [
      { repo: "aoe2-in-browser", path: "packages/aoe2-in-browser" },
      { repo: "open-empires-web", path: "packages/open-empires-web" },
    ] });
    writeFileSync(path.join(root, "package.json"), rootManifest);
    await loaded(root, "decomp-project-image");
    expect(existsSync(path.join(root, "packages", "decomp-project-image", "package.json"))).toBe(true);
    expect(sh(["git", "config", "-f", ".gitmodules", "submodule.packages/decomp-project-image.url"], root)).toBe("https://github.com/acme/decomp-project-image");
    expect(sh(["git", "ls-files", "--stage", "--", "packages/decomp-project-image"], root)).toStartWith("160000 ");
    expect(gitConfigIn(path.join(root, "packages", "decomp-project-image"), "gpg.format")).toBe("ssh");
    expect(gitConfigIn(path.join(root, "packages", "decomp-project-image"), "core.sshCommand")).toEndWith("/jive-ssh");
  }, 30_000);

  test("in a monorepo shaped like chaine, load puts a scoped package at packages/@scope/name, by its package name", async () => {
    const root = monorepo({ name: "chaine", mark: ".jive", submodules: [
      { repo: "jive", path: "packages/@jive-sh/jive" },
      { repo: "jive-abstract-library", path: "packages/jive-abstract-library" },
    ] });
    writeFileSync(path.join(root, "package.json"), rootManifest);
    await loaded(root, "server-repo");
    expect(JSON.parse(readFileSync(path.join(root, "packages", "@jive-sh", "server", "package.json"), "utf8")).name).toBe("@jive-sh/server");
    expect(sh(["git", "config", "-f", ".gitmodules", "submodule.packages/@jive-sh/server.url"], root)).toBe("https://github.com/acme/server-repo");
    // The clone that told jive the package name is gone from the git directory.
    expect(existsSync(path.join(root, ".git", "jive-load"))).toBe(false);
    // Running it again changes nothing and says it is loaded.
    await loaded(root, "server-repo");
    expect(sh(["git", "config", "-f", ".gitmodules", "--get-all", "submodule.packages/@jive-sh/server.path"], root)).toBe("packages/@jive-sh/server");
  }, 30_000);

  test("load stages only its own .gitmodules entry and gitlink, leaving others' uncommitted .gitmodules edits unstaged", async () => {
    const root = monorepo({ name: "busy", mark: ".jive", submodules: [{ repo: "aoe2-in-browser", path: "packages/aoe2-in-browser" }] });
    writeFileSync(path.join(root, "package.json"), rootManifest);
    sh(["git", "add", "package.json"], root);
    sh(["git", "commit", "-qm", "mark"], root);
    // Another agent's edit, not staged: a URL rewritten in the working tree's .gitmodules.
    sh(["git", "config", "-f", ".gitmodules", "submodule.packages/aoe2-in-browser.url", "https://github.com/acme/edited-by-someone-else"], root);
    await loaded(root, "decomp-project-image");

    // The other agent's edit is still only in the working tree.
    expect(sh(["git", "show", ":.gitmodules"], root)).not.toContain("edited-by-someone-else");
    expect(sh(["git", "diff", "--", ".gitmodules"], root)).toContain("+\turl = https://github.com/acme/edited-by-someone-else");
    // The index gained exactly the new entry and its gitlink.
    expect(sh(["git", "diff", "--cached", "--name-only"], root).split("\n")).toEqual([".gitmodules", "packages/decomp-project-image"]);
    expect(sh(["git", "diff", "--cached", "--", ".gitmodules"], root).split("\n").filter(line => /^[+-][^+-]/.test(line))).toEqual([
      `+[submodule "packages/decomp-project-image"]`,
      "+\tpath = packages/decomp-project-image",
      "+\turl = https://github.com/acme/decomp-project-image",
    ]);
  }, 30_000);

  test("load adopts a checkout already at packages/<package name>, keeping its uncommitted work", async () => {
    const root = monorepo({ name: "adopting", mark: ".jive", submodules: [{ repo: "aoe2-in-browser", path: "packages/aoe2-in-browser" }] });
    writeFileSync(path.join(root, "package.json"), rootManifest);
    const checkout = path.join(root, "packages", "decomp-project-image");
    sh(["git", "clone", "-q", "https://github.com/acme/decomp-project-image", checkout], root);
    // Its remote as `gh repo clone` leaves it, over SSH; jive recognises the repo either way.
    sh(["git", "remote", "set-url", "origin", "git@github.com:acme/decomp-project-image"], checkout);
    writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "decomp-project-image", version: "0.0.1" }));
    writeFileSync(path.join(checkout, "work-in-progress.txt"), "not committed\n");
    const head = sh(["git", "rev-parse", "HEAD"], checkout);

    await loaded(root, "decomp-project-image");

    expect(readFileSync(path.join(checkout, "work-in-progress.txt"), "utf8")).toBe("not committed\n");
    expect(JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf8")).version).toBe("0.0.1");
    expect(sh(["git", "ls-files", "--stage", "--", "packages/decomp-project-image"], root)).toStartWith(`160000 ${head} `);
    // Its git directory moved under the monorepo's, as for every submodule `git submodule add` clones.
    expect(readFileSync(path.join(checkout, ".git"), "utf8").trim()).toBe("gitdir: ../../.git/modules/packages/decomp-project-image");
    expect(sh(["git", "remote", "get-url", "origin"], checkout)).toBe("git@github.com:acme/decomp-project-image");
    expect(gitConfigIn(checkout, "commit.gpgSign")).toBe("true");
  }, 30_000);

  /** A prompt answering the yes-or-no question with `confirm` and the name and email questions with `identity`, recording what it was asked. */
  function answering({ confirm, identity }: { readonly confirm: boolean; readonly identity: { readonly name: string; readonly email: string } }) {
    const asked: Array<string> = [];
    const prompt = TerminalPromptImpl.mockLayer({
      *confirm(question: string) { asked.push(question); return confirm; },
      *ask(question: string) { asked.push(question); return question === "Name:" ? identity.name : identity.email; },
    });
    return { asked, prompt };
  }
  const typed = { name: "  Łukasz O'Brien-Müller ", email: " lukasz@example.com " };

  test("init in a folder in no repository and no workspace makes it a repository on main, asks for its git identity, marks it the root and configures it", async () => {
    const folder = path.join(scratch, "monorepos", "fresh");
    mkdirSync(folder, { recursive: true });
    const { asked, prompt } = answering({ confirm: false, identity: typed });
    const { exit } = await runJiveIn(folder, ["init"], prompt);
    expect(exit).toEqual(e.Exit.void);
    expect(asked).toEqual(["Name:", "Email:"]);
    expect(gitConfigIn(folder, "user.name")).toBe("Łukasz O'Brien-Müller");
    expect(gitConfigIn(folder, "user.email")).toBe("lukasz@example.com");
    expect(sh(["git", "rev-parse", "--show-toplevel"], folder)).toBe(folder);
    expect(sh(["git", "symbolic-ref", "HEAD"], folder)).toBe("refs/heads/main");
    expect(JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"))).toEqual({ jive: { root: true } });
    expect(gitConfigIn(folder, "gpg.format")).toBe("ssh");
    expect(gitConfigIn(folder, "core.sshCommand")).toEndWith("/jive-ssh");
  }, 30_000);

  test("init in a repository that is no workspace yet marks that repository's root, making no new repository", async () => {
    const root = monorepo({ name: "existing-repository", mark: "none", submodules: [] });
    const below = path.join(root, "docs");
    mkdirSync(below);
    expect((await runJiveIn(below, ["init"])).exit).toEqual(e.Exit.void);
    expect(existsSync(path.join(below, ".git"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))).toEqual({ jive: { root: true } });
    expect(gitConfigIn(root, "gpg.format")).toBe("ssh");
  }, 30_000);

  /** A workspace, and a folder inside it that is no repository, as a person's new project folder would be. */
  function folderInsideWorkspace(name: string) {
    const root = monorepo({ name, mark: "package.json", submodules: [] });
    const folder = path.join(root, "new-project");
    mkdirSync(folder);
    return { root, folder };
  }

  /** Nothing init writes is in `root` or `folder`: no repository made, no root marked, no config set. */
  function expectUnchanged({ root, folder }: { readonly root: string; readonly folder: string }) {
    expect(existsSync(path.join(folder, ".git"))).toBe(false);
    expect(existsSync(path.join(folder, "package.json"))).toBe(false);
    expect(Bun.spawnSync(["git", "config", "--local", "--get", "gpg.format"], { cwd: root, env: process.env }).exitCode).toBe(1);
  }

  test("init inside a workspace asks, and on yes configures that workspace without a new repository", async () => {
    const { root, folder } = folderInsideWorkspace("asked-yes");
    const asked: Array<string> = [];
    const { exit } = await runJiveIn(folder, ["init"], TerminalPromptImpl.mockLayer({ *confirm(question: string) { asked.push(question); return true; } }));
    expect(exit).toEqual(e.Exit.void);
    expect(asked).toEqual(["Are you sure you want to continue?"]);
    expect(existsSync(path.join(folder, ".git"))).toBe(false);
    expect(gitConfigIn(root, "gpg.format")).toBe("ssh");
    expect(gitConfigIn(root, "core.sshCommand")).toEndWith("/jive-ssh");
  }, 30_000);

  test("init inside a workspace, answered no, changes nothing", async () => {
    const workspaceAndFolder = folderInsideWorkspace("asked-no");
    const { exit } = await runJiveIn(workspaceAndFolder.folder, ["init"], TerminalPromptImpl.mockLayer({ *confirm() { return false; } }));
    expect(exit).toEqual(e.Exit.void);
    expectUnchanged(workspaceAndFolder);
  }, 30_000);

  test("init inside a workspace with no terminal to ask fails, naming the workspace, and changes nothing", async () => {
    const workspaceAndFolder = folderInsideWorkspace("no-terminal");
    const { exit } = await runJiveIn(workspaceAndFolder.folder, ["init"], TerminalPromptImpl.mockLayer({ *confirm() { return yield* new NoTerminalToAsk(); } }));
    expect(errorOf(exit)).toEqual(new BadPreconditionsError({
      cause: `Not configuring ${workspaceAndFolder.root}: there is no terminal to ask whether to`,
      fix: `Run \`jive init\` in ${workspaceAndFolder.root}`,
    }));
    expectUnchanged(workspaceAndFolder);
  }, 30_000);

  test("init at the workspace's root asks nothing", async () => {
    const { root } = folderInsideWorkspace("at-root");
    const asked: Array<string> = [];
    expect((await runJiveIn(root, ["init"], TerminalPromptImpl.mockLayer({ *confirm(question: string) { asked.push(question); return false; } }))).exit).toEqual(e.Exit.void);
    expect(asked).toEqual([]);
    expect(gitConfigIn(root, "gpg.format")).toBe("ssh");
  }, 30_000);

  test("init in a repository with no git identity asks for one and writes it into the root and every submodule", async () => {
    const root = monorepo({ name: "no-identity", mark: "none", submodules: [{ repo: "aoe2-in-browser", path: "packages/aoe2-in-browser" }], identity: "none" });
    const { asked, prompt } = answering({ confirm: false, identity: typed });
    expect((await runJiveIn(root, ["init"], prompt)).exit).toEqual(e.Exit.void);
    expect(asked).toEqual(["Name:", "Email:"]);
    for (const repository of [root, path.join(root, "packages", "aoe2-in-browser")]) {
      expect(gitConfigIn(repository, "user.name")).toBe("Łukasz O'Brien-Müller");
      expect(gitConfigIn(repository, "user.email")).toBe("lukasz@example.com");
      expect(gitConfigIn(repository, "gpg.format")).toBe("ssh");
    }
  }, 30_000);

  test("init with the root's git identity already set uses it without asking", async () => {
    const root = monorepo({ name: "has-identity", mark: "none", submodules: [{ repo: "aoe2-in-browser", path: "packages/aoe2-in-browser" }] });
    const { asked, prompt } = answering({ confirm: false, identity: typed });
    expect((await runJiveIn(root, ["init"], prompt)).exit).toEqual(e.Exit.void);
    expect(asked).toEqual([]);
    expect(gitConfigIn(path.join(root, "packages", "aoe2-in-browser"), "user.name")).toBe(persona.name);
    expect(gitConfigIn(root, "user.email")).toBe(persona.email);
  }, 30_000);

  test("init with no git identity and no terminal to ask fails before changing anything, saying to run jive init in a terminal", async () => {
    const root = monorepo({ name: "no-identity-no-terminal", mark: "none", submodules: [], identity: "none" });
    const prompt = TerminalPromptImpl.mockLayer({ *ask() { return yield* new NoTerminalToAsk(); } });
    const { exit } = await runJiveIn(root, ["init"], prompt);
    expect(errorOf(exit)).toEqual(new BadPreconditionsError({
      cause: `${root} has no git identity: its own git config sets no user.name and user.email, and there is no terminal to ask for one`,
      fix: `Run \`jive init\` in ${root} in a terminal: it asks for the name and email this workspace's commits carry`,
    }));
    expect(existsSync(path.join(root, "package.json"))).toBe(false);
    expect(Bun.spawnSync(["git", "config", "--local", "--get", "gpg.format"], { cwd: root, env: process.env }).exitCode).toBe(1);
  }, 30_000);

  test("init refuses a name or email git couldn't put in a commit, changing nothing", async () => {
    const root = monorepo({ name: "bad-identity", mark: "none", submodules: [], identity: "none" });
    const { prompt } = answering({ confirm: false, identity: { name: "Zoë", email: "not an email" } });
    const { exit } = await runJiveIn(root, ["init"], prompt);
    expect(errorOf(exit)).toEqual(new BadArgumentError({ argument: "git identity", reason: "a git email has an @ and holds no spaces, <, > or line break" }));
    expect(Bun.spawnSync(["git", "config", "--local", "--get", "user.name"], { cwd: root, env: process.env }).exitCode).toBe(1);
  }, 30_000);

  test("load refuses in a workspace whose root has no git identity, saying to run jive init", async () => {
    const root = monorepo({ name: "load-no-identity", mark: "package.json", submodules: [], identity: "none" });
    const { exit } = await runJiveIn(root, ["load", "acme", "decomp-project-image"]);
    expect(errorOf(exit)).toEqual(new BadPreconditionsError({
      cause: `${root} has no git identity: its own git config sets no user.name and user.email`,
      fix: `Run \`jive init\` in ${root} in a terminal: it asks for the name and email this workspace's commits carry`,
    }));
    expect(existsSync(path.join(root, "packages", "decomp-project-image"))).toBe(false);
  }, 30_000);

  test("load refuses a checkout of the repo that isn't at packages/<package name>, naming where it belongs", async () => {
    const root = monorepo({ name: "misplaced", mark: "package.json", submodules: [] });
    sh(["git", "clone", "-q", "https://github.com/acme/server-repo", path.join(root, "packages", "server")], root);
    const error = errorOf((await runJiveIn(root, ["load", "acme", "server-repo"])).exit);
    expect(error instanceof BadPreconditionsError && error.cause)
      .toBe("acme/server-repo is at packages/server, but jive keeps the package @jive-sh/server at packages/@jive-sh/server");
  }, 30_000);
});
