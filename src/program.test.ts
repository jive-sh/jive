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
async function runJive(args: ReadonlyArray<string>): Promise<Outcome> {
  const stdout: Array<string> = [];
  const exit = await e.Effect.runPromise(e.pipe(
    Cli.run(jive, { version: "0.0.0-test" }),
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
    // The widget's own submodule is fetched and configured too; .gitmodules records only https URLs.
    expect(readFileSync(path.join(widget(), "gadget", "gadget.txt"), "utf8")).toBe("gadget\n");
    expect(gitConfigIn(path.join(widget(), "gadget"), "gpg.ssh.program")).toEndWith("/jive-ssh-sign");
    expect(gitConfigIn(path.join(widget(), "gadget"), "core.sshCommand")).toEndWith("/jive-ssh");
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

  /** A monorepo with the given submodules committed, and the root mark or the 0.8.0 `.jive` directory. */
  function monorepo({ name, mark, submodules }: {
    readonly name: string;
    readonly mark: "package.json" | ".jive" | "none";
    readonly submodules: ReadonlyArray<{ readonly repo: string; readonly path: string }>;
  }): string {
    const root = path.join(scratch, "monorepos", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "README.md"), `${name}\n`);
    if (mark === "package.json") writeFileSync(path.join(root, "package.json"), rootManifest);
    if (mark === ".jive") mkdirSync(path.join(root, ".jive"));
    sh(["git", "init", "-q"], root);
    for (const submodule of submodules) sh(["git", "submodule", "add", "-q", `https://github.com/acme/${submodule.repo}`, submodule.path], root);
    sh(["git", "add", "."], root);
    sh(["git", "commit", "-qm", name], root);
    return root;
  }

  async function runJiveIn(directory: string, args: ReadonlyArray<string>): Promise<Outcome> {
    process.chdir(directory);
    try {
      return await runJive(args);
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

  test("load refuses a checkout of the repo that isn't at packages/<package name>, naming where it belongs", async () => {
    const root = monorepo({ name: "misplaced", mark: "package.json", submodules: [] });
    sh(["git", "clone", "-q", "https://github.com/acme/server-repo", path.join(root, "packages", "server")], root);
    const error = errorOf((await runJiveIn(root, ["load", "acme", "server-repo"])).exit);
    expect(error instanceof BadPreconditionsError && error.cause)
      .toBe("acme/server-repo is at packages/server, but jive keeps the package @jive-sh/server at packages/@jive-sh/server");
  }, 30_000);
});
