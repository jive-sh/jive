import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { Cli, OSPlatform, OSPlatformImpl } from "jive-abstract-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BadArgumentError, BadPreconditionsError, UsageError } from "@/errors";
import { AccountKeyImpl } from "@/modules/account-key/impl";
import type { AccountKey } from "@/modules/account-key/interface";
import { GitHubImpl } from "@/modules/github/impl";
import { GitHubUnanswered } from "@/modules/github/interface";
import { TerminalPromptImpl } from "@/modules/prompt/impl";
import { NoTerminalToAsk } from "@/modules/prompt/interface";
import { ProvisioningImpl } from "@/modules/provisioning/impl";
import { ModulesLayer } from "@/modules/runtime";
import { jive } from "@/program";

/**
 * Runs `jive load`, `on` and `unload` against a scratch workspace. Nothing reaches GitHub: a git config the test
 * owns (GIT_CONFIG_GLOBAL) rewrites https://github.com/ and git@github.com: to a directory of local bare repos, GitHub's
 * API is a fake knowing only the acme account, and sign-in is a fake user. HOME, which every tool jive starts reads, is a scratch directory too, and so is BUN_INSTALL, where `bun link`
 * registers packages.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "jive-program-test-")));
const remotes = path.join(scratch, "remotes");
const workspace = path.join(scratch, "workspace");
const bunHome = path.join(scratch, "bun-home");
const home = path.join(scratch, "home");
const originalDirectory = process.cwd();
const originalEnv = { ...process.env };
/** The workspace root's package.json; nothing in it says it is the workspace, which is the git repository itself. */
const rootManifest = `${JSON.stringify({ private: true })}\n`;

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
    `[url "file://${remotes}/acme/"]`, `\tinsteadOf = https://github.com/acme/`, `\tinsteadOf = git@github.com:acme/`,
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
  /** Every line jive logged, in order. */
  readonly logs: ReadonlyArray<string>;
  readonly exit: e.Exit.Exit<void, unknown>;
}

/** GitHub's API as these tests see it: only acme has an account, and the name "unanswered" gets no answer. */
const fakeGitHub = GitHubImpl.mockLayer({
  *accountExists(name: string) {
    if (name === "unanswered") return yield* new GitHubUnanswered({ reason: "no answer within 5s" });
    return name === "acme";
  },
});

/** Runs jive in this process on `args`, the way the entrypoint does, with sign-in replaced by the fake user. */
const runJive = (args: ReadonlyArray<string>): Promise<Outcome> => runJiveWithPrompt({ args, prompt: e.Layer.empty });

/** `runJive`, with `prompt` answering every question jive asks in place of the terminal. */
async function runJiveWithPrompt({ args, prompt }: { readonly args: ReadonlyArray<string>; readonly prompt: e.Layer.Layer<never> | ReturnType<typeof TerminalPromptImpl.mockLayer> }): Promise<Outcome> {
  const stdout: Array<string> = [];
  const logs: Array<string> = [];
  const exit = await e.Effect.runPromise(e.pipe(
    Cli.run(jive, { version: "0.0.0-test" }),
    e.Effect.provide(e.Logger.layer([e.Logger.make(({ message }) => {
      logs.push((Array.isArray(message) ? message : [message]).map(String).join(" "));
    })])),
    e.Effect.provide(prompt),
    e.Effect.provide(fakeGitHub),
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
  return { stdout: stdout.join(""), logs, exit };
}

const provisioned: Array<{ kind: string; instance: unknown }> = [];

const errorOf = (exit: e.Exit.Exit<void, unknown>) => e.Option.getOrUndefined(e.Exit.findErrorOption(exit));
const widget = () => path.join(workspace, "packages", "@acme", "widget");
const gitConfigIn = (directory: string, key: string) => sh(["git", "config", "--local", "--get", key], directory);

describe("jive in a workspace", () => {
  test("load clones the repo as a submodule, configures it to sign and push through jive, and installs it", async () => {
    const { exit, logs } = await runJive(["load", "acme", "widget"]);
    expect(exit).toEqual(e.Exit.void);
    expect(logs).toContain(`Loading acme/widget into ${widget()}, in the workspace at ${workspace}`);

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
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ jive: { resources: { "connector-package-registry": { "@acme/gadget": { packageName: "@acme/gadget" } } } } }));
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
      expect(error).toEqual(new BadPreconditionsError({
        cause: `${scratch} is in no git repository, and a jive workspace is the nearest git repository from where it runs`,
        fix: "Run this inside the repository, or `jive init` to make this folder one",
      }));
    } finally {
      process.chdir(workspace);
    }
  });
});


/**
 * `jive load` and `jive init` in monorepos shaped like the two jive serves: open-empires (its submodules at
 * `packages/<repo>`, whose package names are scoped) and chaine (at `packages/<package name>`, scoped and not), and in
 * repositories nested inside others. Each monorepo is a fresh git repository whose submodules come from the local bare
 * repos, as `git submodule add` records them. None has a package.json saying it is a workspace: the workspace is the
 * nearest git repository from where jive runs.
 */
describe("jive in the nearest git repository", () => {
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

  /** A monorepo with the given submodules committed, and `persona` as its root's git identity unless `identity` is "none". */
  function monorepo({ name, submodules, identity = "persona" }: {
    readonly name: string;
    readonly submodules: ReadonlyArray<{ readonly url: string; readonly path: string }>;
    readonly identity?: "persona" | "none";
  }): string {
    const root = path.join(scratch, "monorepos", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "README.md"), `${name}\n`);
    sh(["git", "init", "-q"], root);
    if (identity === "persona") setWorkspaceIdentity(root);
    for (const submodule of submodules) sh(["git", "submodule", "add", "-q", submodule.url, submodule.path], root);
    sh(["git", "add", "."], root);
    sh(["git", "commit", "-qm", name], root);
    return root;
  }
  const acme = (repo: string) => `https://github.com/acme/${repo}`;

  async function runJiveIn(directory: string, args: ReadonlyArray<string>, prompt: Parameters<typeof runJiveWithPrompt>[0]["prompt"] = e.Layer.empty): Promise<Outcome> {
    process.chdir(directory);
    try {
      return await runJiveWithPrompt({ args, prompt });
    } finally {
      process.chdir(workspace);
    }
  }

  const succeeded = (outcome: Outcome): Outcome => {
    if (e.Exit.isFailure(outcome.exit)) throw new Error(`jive failed: ${JSON.stringify(e.Cause.squash(outcome.exit.cause))}`);
    return outcome;
  };
  const loaded = async (directory: string, repo: string, prompt?: Parameters<typeof runJiveWithPrompt>[0]["prompt"]) =>
    succeeded(await runJiveIn(directory, ["load", "acme", repo], prompt));

  /** Whether every file `repository` tracks is as committed and nothing untracked appeared: `git status` shows nothing. */
  const status = (repository: string) => sh(["git", "status", "--porcelain", "--ignore-submodules=none"], repository);

  /**
   * A prompt that records each question and answers it, as a person at a terminal would; or, with `terminal: false`,
   * one that fails every question as jive's real prompt does when its input is not a terminal.
   */
  function prompting({ terminal, identity = typed }: { readonly terminal: boolean; readonly identity?: { readonly name: string; readonly email: string } }) {
    const asked: Array<string> = [];
    const prompt = TerminalPromptImpl.mockLayer({
      *ask(question: string) {
        asked.push(question);
        if (!terminal) return yield* new NoTerminalToAsk();
        return question === "Name:" ? identity.name : identity.email;
      },
    });
    return { asked, prompt };
  }
  const typed = { name: "  Łukasz O'Brien-Müller ", email: " lukasz@example.com " };

  beforeAll(() => {
    publish({ repo: "aoe2-in-browser", packageName: "@acme/aoe2-in-browser" });
    publish({ repo: "open-empires-web", packageName: "@acme/open-empires-web" });
    publish({ repo: "decomp-project-image", packageName: "decomp-project-image" });
    publish({ repo: "jive", packageName: "@jive-sh/jive" });
    publish({ repo: "jive-abstract-library", packageName: "jive-abstract-library" });
    // A repo whose package name is not its repo name: its place follows the package name.
    publish({ repo: "server-repo", packageName: "@jive-sh/server" });
    publish({ repo: "inner", packageName: "@acme/inner" });
  });

  test("load from inside a submodule lands in that submodule's packages/, and from the outer repository in the outer one's, naming the folder and the workspace", async () => {
    const outer = monorepo({ name: "nested", submodules: [{ url: acme("inner"), path: "packages/@acme/inner" }] });
    const inner = path.join(outer, "packages", "@acme", "inner");
    setWorkspaceIdentity(inner);
    const below = path.join(outer, "docs");
    mkdirSync(below);

    const fromInner = await loaded(inner, "decomp-project-image");
    expect(fromInner.logs).toContain(`Loading acme/decomp-project-image into ${inner}/packages/decomp-project-image, in the workspace at ${inner}`);
    expect(JSON.parse(readFileSync(path.join(inner, "packages", "decomp-project-image", "package.json"), "utf8")).name).toBe("decomp-project-image");
    expect(sh(["git", "ls-files", "--stage", "--", "packages/decomp-project-image"], inner)).toStartWith("160000 ");
    expect(sh(["git", "config", "-f", ".gitmodules", "submodule.packages/decomp-project-image.url"], inner)).toBe(acme("decomp-project-image"));
    // The outer repository gains nothing of it: its .gitmodules and index are as committed, apart from the submodule's new commit state.
    expect(readFileSync(path.join(outer, ".gitmodules"), "utf8")).not.toContain("decomp-project-image");
    expect(existsSync(path.join(outer, "packages", "decomp-project-image"))).toBe(false);

    const fromOuter = await loaded(below, "jive-abstract-library");
    expect(fromOuter.logs).toContain(`Loading acme/jive-abstract-library into ${outer}/packages/jive-abstract-library, in the workspace at ${outer}`);
    expect(sh(["git", "ls-files", "--stage", "--", "packages/jive-abstract-library"], outer)).toStartWith("160000 ");
    expect(existsSync(path.join(inner, "packages", "jive-abstract-library"))).toBe(false);
    // Both loaded repos were set up by jive init, run in them as the load's last step.
    for (const repository of [path.join(inner, "packages", "decomp-project-image"), path.join(outer, "packages", "jive-abstract-library")]) {
      expect(gitConfigIn(repository, "gpg.format")).toBe("ssh");
      expect(gitConfigIn(repository, "core.sshCommand")).toEndWith("/jive-ssh");
      expect(gitConfigIn(repository, "user.email")).toBe(persona.email);
    }
    expect(fromInner.logs).toContain(`Setting up the workspace at ${inner}/packages/decomp-project-image`);
    expect(fromOuter.logs).toContain(`Setting up the workspace at ${outer}/packages/jive-abstract-library`);

    // Tab answers from the same repository: the inner one lists its own loaded org.
    expect((await runJiveIn(inner, ["--compgen", "on", ""])).stdout).toBe("acme\n");
    expect((await runJiveIn(inner, ["--compgen", "on", "acme", ""])).stdout).toBe("decomp-project-image\n");
    expect((await runJiveIn(below, ["--compgen", "on", "acme", ""])).stdout).toBe("inner\njive-abstract-library\n");
    // `on` and `unload` find the repo in the nearest repository too.
    expect((await runJiveIn(inner, ["on", "acme", "decomp-project-image", "--", "sh", "-c", "pwd > ran-here.txt"])).exit).toEqual(e.Exit.void);
    expect(readFileSync(path.join(inner, "packages", "decomp-project-image", "ran-here.txt"), "utf8").trim()).toBe(path.join(inner, "packages", "decomp-project-image"));
    expect((await runJiveIn(inner, ["unload", "acme", "decomp-project-image"])).exit).toEqual(e.Exit.void);
    expect(existsSync(path.join(inner, "packages", "decomp-project-image"))).toBe(false);
    expect(existsSync(path.join(outer, "packages", "jive-abstract-library"))).toBe(true);
  }, 60_000);

  test("load in no repository clones into ./<repo>, saying so, and runs jive init there", async () => {
    const folder = path.join(scratch, "no-repository");
    mkdirSync(folder);
    const { asked, prompt } = prompting({ terminal: true });
    const { logs } = await loaded(folder, "decomp-project-image", prompt);
    const clone = path.join(folder, "decomp-project-image");
    expect(logs[0]).toBe(`Not in a workspace: cloning acme/decomp-project-image into ${clone}`);
    expect(sh(["git", "rev-parse", "--show-toplevel"], clone)).toBe(clone);
    expect(gitConfigIn(clone, "remote.origin.url")).toBe(acme("decomp-project-image"));
    expect(existsSync(path.join(folder, ".git"))).toBe(false);
    // jive init in the clone: it has no git identity of its own yet, so init asks for one as it does in any such repository.
    expect(asked).toEqual(["Name:", "Email:"]);
    expect(logs).toContain(`Setting up the workspace at ${clone}`);
    expect(gitConfigIn(clone, "user.name")).toBe("Łukasz O'Brien-Müller");
    expect(gitConfigIn(clone, "gpg.format")).toBe("ssh");
    expect(gitConfigIn(clone, "core.sshCommand")).toEndWith("/jive-ssh");
    expect(gitConfigIn(clone, "url.git@github.com:.insteadOf")).toBe("https://github.com/");
    expect(status(clone)).toBe("");
  }, 30_000);

  test("init in an existing repository with no package.json moves its .gitmodules to https, changes no other file, and sets the git config it sets", async () => {
    // A submodule .gitmodules names over SSH, as a repository cloned with `gh` has it: init fetches it as it is.
    const root = monorepo({ name: "untouched", submodules: [] });
    sh(["git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", "git@github.com:acme/aoe2-in-browser", "packages/aoe2-in-browser"], root);
    sh(["git", "commit", "-qm", "submodule"], root);
    sh(["git", "submodule", "deinit", "-q", "--all"], root);
    const gitmodules = readFileSync(path.join(root, ".gitmodules"), "utf8");
    const { asked, prompt } = prompting({ terminal: false });

    expect(gitmodules).toContain("url = git@github.com:acme/aoe2-in-browser\n");
    const { logs } = succeeded(await runJiveIn(root, ["init"], prompt));
    expect(asked).toEqual([]);
    expect(logs).toContain(`Setting up the workspace at ${root}`);
    expect(logs).toContain(`1 submodule URL moved to https; 1 submodule checked out; 2 repositories commit as ${persona.name} <${persona.email}>, sign with your Jive account key and fetch and push over SSH through jive's agent`);
    // .gitmodules is the one file that changes, in the working tree only: its URL now https.
    expect(status(root)).toBe("M .gitmodules");
    expect(readFileSync(path.join(root, ".gitmodules"), "utf8")).toBe(gitmodules.replace("git@github.com:acme/aoe2-in-browser", "https://github.com/acme/aoe2-in-browser"));
    expect(sh(["git", "show", ":.gitmodules"], root)).toBe(gitmodules.trim());
    expect(existsSync(path.join(root, "package.json"))).toBe(false);
    expect(readFileSync(path.join(root, "packages", "aoe2-in-browser", "package.json"), "utf8")).toContain("@acme/aoe2-in-browser");
    for (const repository of [root, path.join(root, "packages", "aoe2-in-browser")]) {
      expect(gitConfigIn(repository, "user.name")).toBe(persona.name);
      expect(gitConfigIn(repository, "user.email")).toBe(persona.email);
      expect(gitConfigIn(repository, "gpg.format")).toBe("ssh");
      expect(gitConfigIn(repository, "user.signingKey")).toBe(path.join(scratch, "account.pub"));
      expect(gitConfigIn(repository, "commit.gpgSign")).toBe("true");
      expect(gitConfigIn(repository, "gpg.ssh.program")).toEndWith("/jive-ssh-sign");
      expect(gitConfigIn(repository, "core.sshCommand")).toEndWith("/jive-ssh");
      expect(gitConfigIn(repository, "ssh.variant")).toBe("ssh");
      expect(gitConfigIn(repository, "url.git@github.com:.insteadOf")).toBe("https://github.com/");
    }
  }, 30_000);

  test("init in a repository with no .gitmodules makes none, changing no file", async () => {
    const root = monorepo({ name: "no-gitmodules", submodules: [] });
    const { logs } = succeeded(await runJiveIn(root, ["init"]));
    expect(logs).toContain(`0 submodule URLs moved to https; 0 submodules checked out; 1 repository commits as ${persona.name} <${persona.email}>, signs with your Jive account key and fetch and push over SSH through jive's agent`);
    expect(existsSync(path.join(root, ".gitmodules"))).toBe(false);
    expect(status(root)).toBe("");
  }, 30_000);

  test("load moves the workspace's other .gitmodules URLs and the loaded repo's own to https, staging neither", async () => {
    // A repo on "GitHub" whose own .gitmodules names its submodule over SSH.
    const source = path.join(scratch, "sources", "ssh-submodules");
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "@acme/ssh-submodules", version: "0.0.0" }));
    sh(["git", "init", "-q"], source);
    sh(["git", "submodule", "add", "-q", "git@github.com:acme/aoe2-in-browser", "vendor/aoe2"], source);
    sh(["git", "add", "."], source);
    sh(["git", "commit", "-qm", "ssh-submodules"], source);
    sh(["git", "clone", "-q", "--bare", source, path.join(remotes, "acme", "ssh-submodules.git")], scratch);

    const root = monorepo({ name: "load-to-https", submodules: [{ url: "git@github.com:acme/open-empires-web", path: "packages/open-empires-web" }] });
    const { logs } = await loaded(root, "ssh-submodules");
    expect(logs).toContain(`Moved 1 other submodule URL in ${root}/.gitmodules to https`);
    const workingTree = readFileSync(path.join(root, ".gitmodules"), "utf8");
    expect(workingTree).toContain("url = https://github.com/acme/open-empires-web\n");
    expect(workingTree).not.toContain("git@");
    // The index has the old URL as committed, plus only the new entry.
    expect(sh(["git", "show", ":.gitmodules"], root)).toContain("url = git@github.com:acme/open-empires-web");
    expect(sh(["git", "diff", "--cached", "--name-only"], root).split("\n")).toEqual([".gitmodules", "packages/@acme/ssh-submodules"]);
    // jive init, run in the loaded repo, moved its own .gitmodules to https and checked out its submodule.
    const loadedRepo = path.join(root, "packages", "@acme", "ssh-submodules");
    expect(readFileSync(path.join(loadedRepo, ".gitmodules"), "utf8")).toContain("url = https://github.com/acme/aoe2-in-browser\n");
    expect(readFileSync(path.join(loadedRepo, "vendor", "aoe2", "package.json"), "utf8")).toContain("@acme/aoe2-in-browser");
  }, 30_000);

  test("init below a repository's root, or inside one of its submodules, sets up that nearest repository and asks nothing, with or without a terminal", async () => {
    for (const terminal of [true, false]) {
      const outer = monorepo({ name: `below-${terminal}`, submodules: [{ url: acme("inner"), path: "packages/@acme/inner" }] });
      const inner = path.join(outer, "packages", "@acme", "inner");
      setWorkspaceIdentity(inner);
      const below = path.join(outer, "docs");
      mkdirSync(below);
      const { asked, prompt } = prompting({ terminal });
      expect(succeeded(await runJiveIn(below, ["init"], prompt)).logs).toContain(`Setting up the workspace at ${outer}`);
      expect(existsSync(path.join(below, ".git"))).toBe(false);
      expect(gitConfigIn(outer, "gpg.format")).toBe("ssh");
      const insideInner = path.join(inner, "notes");
      mkdirSync(insideInner);
      expect(succeeded(await runJiveIn(insideInner, ["init"], prompt)).logs).toContain(`Setting up the workspace at ${inner}`);
      expect(existsSync(path.join(insideInner, ".git"))).toBe(false);
      expect(asked).toEqual([]);
      expect(status(outer)).toBe("");
    }
  }, 60_000);

  test("load in a repository asks nothing, with or without a terminal", async () => {
    for (const terminal of [true, false]) {
      const root = monorepo({ name: `load-asks-nothing-${terminal}`, submodules: [] });
      const { asked, prompt } = prompting({ terminal });
      await loaded(root, "server-repo", prompt);
      expect(asked).toEqual([]);
      expect(gitConfigIn(path.join(root, "packages", "@jive-sh", "server"), "commit.gpgSign")).toBe("true");
    }
  }, 60_000);

  test("load with words other than an org and one repo is refused with load's help, saying when GitHub has no such org", async () => {
    const root = monorepo({ name: "wrong-words", submodules: [] });
    const refusal = async (args: ReadonlyArray<string>) => errorOf((await runJiveIn(root, args)).exit);
    expect(await refusal(["load", "ozyman42/workspace"])).toEqual(new UsageError({ command: ["load"], problems: ["No access to an org named ozyman42/workspace"] }));
    expect(await refusal(["load", "no-such-org"])).toEqual(new UsageError({ command: ["load"], problems: ["No access to an org named no-such-org"] }));
    expect(await refusal(["load", "acme"])).toEqual(new UsageError({ command: ["load"], problems: [] }));
    expect(await refusal(["load", "acme", "decomp-project-image", "extra"])).toEqual(new UsageError({ command: ["load"], problems: [] }));
    // GitHub not answering is no proof the org is out of reach, so only the help is shown.
    expect(await refusal(["load", "unanswered"])).toEqual(new UsageError({ command: ["load"], problems: [] }));
    expect(existsSync(path.join(root, "packages"))).toBe(false);
  }, 30_000);

  test("in a monorepo shaped like open-empires, load puts the repo at packages/<package name>", async () => {
    const root = monorepo({ name: "open-empires", submodules: [
      { url: acme("aoe2-in-browser"), path: "packages/aoe2-in-browser" },
      { url: acme("open-empires-web"), path: "packages/open-empires-web" },
    ] });
    await loaded(root, "decomp-project-image");
    expect(existsSync(path.join(root, "packages", "decomp-project-image", "package.json"))).toBe(true);
    expect(sh(["git", "config", "-f", ".gitmodules", "submodule.packages/decomp-project-image.url"], root)).toBe(acme("decomp-project-image"));
    expect(sh(["git", "ls-files", "--stage", "--", "packages/decomp-project-image"], root)).toStartWith("160000 ");
    expect(gitConfigIn(path.join(root, "packages", "decomp-project-image"), "gpg.format")).toBe("ssh");
    expect(gitConfigIn(path.join(root, "packages", "decomp-project-image"), "core.sshCommand")).toEndWith("/jive-ssh");
  }, 30_000);

  test("in a monorepo shaped like chaine, load puts a scoped package at packages/@scope/name, by its package name", async () => {
    const root = monorepo({ name: "chaine", submodules: [
      { url: acme("jive"), path: "packages/@jive-sh/jive" },
      { url: acme("jive-abstract-library"), path: "packages/jive-abstract-library" },
    ] });
    await loaded(root, "server-repo");
    expect(JSON.parse(readFileSync(path.join(root, "packages", "@jive-sh", "server", "package.json"), "utf8")).name).toBe("@jive-sh/server");
    expect(sh(["git", "config", "-f", ".gitmodules", "submodule.packages/@jive-sh/server.url"], root)).toBe(acme("server-repo"));
    // The clone that told jive the package name is gone from the git directory.
    expect(existsSync(path.join(root, ".git", "jive-load"))).toBe(false);
    // Running it again changes nothing and says it is loaded.
    const again = await loaded(root, "server-repo");
    expect(again.logs).toContain("acme/server-repo is already the submodule there");
    expect(sh(["git", "config", "-f", ".gitmodules", "--get-all", "submodule.packages/@jive-sh/server.path"], root)).toBe("packages/@jive-sh/server");
  }, 30_000);

  test("load stages only its own .gitmodules entry and gitlink, leaving others' uncommitted .gitmodules edits unstaged", async () => {
    const root = monorepo({ name: "busy", submodules: [{ url: acme("aoe2-in-browser"), path: "packages/aoe2-in-browser" }] });
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
    const root = monorepo({ name: "adopting", submodules: [{ url: acme("aoe2-in-browser"), path: "packages/aoe2-in-browser" }] });
    const checkout = path.join(root, "packages", "decomp-project-image");
    sh(["git", "clone", "-q", acme("decomp-project-image"), checkout], root);
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
    expect(gitConfigIn(checkout, "remote.origin.url")).toBe("git@github.com:acme/decomp-project-image");
    expect(gitConfigIn(checkout, "commit.gpgSign")).toBe("true");
  }, 30_000);

  test("init in a folder in no repository makes it a repository on main, asks for its git identity and configures it, writing no file", async () => {
    const folder = path.join(scratch, "monorepos", "fresh");
    mkdirSync(folder, { recursive: true });
    const { asked, prompt } = prompting({ terminal: true });
    succeeded(await runJiveIn(folder, ["init"], prompt));
    expect(asked).toEqual(["Name:", "Email:"]);
    expect(gitConfigIn(folder, "user.name")).toBe("Łukasz O'Brien-Müller");
    expect(gitConfigIn(folder, "user.email")).toBe("lukasz@example.com");
    expect(sh(["git", "rev-parse", "--show-toplevel"], folder)).toBe(folder);
    expect(sh(["git", "symbolic-ref", "HEAD"], folder)).toBe("refs/heads/main");
    expect(status(folder)).toBe("");
    expect(gitConfigIn(folder, "gpg.format")).toBe("ssh");
    expect(gitConfigIn(folder, "core.sshCommand")).toEndWith("/jive-ssh");
  }, 30_000);

  test("init in a repository with no git identity asks for one and writes it into the root and every submodule", async () => {
    const root = monorepo({ name: "no-identity", submodules: [{ url: acme("aoe2-in-browser"), path: "packages/aoe2-in-browser" }], identity: "none" });
    const { asked, prompt } = prompting({ terminal: true });
    succeeded(await runJiveIn(root, ["init"], prompt));
    expect(asked).toEqual(["Name:", "Email:"]);
    for (const repository of [root, path.join(root, "packages", "aoe2-in-browser")]) {
      expect(gitConfigIn(repository, "user.name")).toBe("Łukasz O'Brien-Müller");
      expect(gitConfigIn(repository, "user.email")).toBe("lukasz@example.com");
      expect(gitConfigIn(repository, "gpg.format")).toBe("ssh");
    }
  }, 30_000);

  test("init with no git identity and no terminal to ask fails before changing anything, saying to run jive init in a terminal", async () => {
    const root = monorepo({ name: "no-identity-no-terminal", submodules: [], identity: "none" });
    const { exit } = await runJiveIn(root, ["init"], prompting({ terminal: false }).prompt);
    expect(errorOf(exit)).toEqual(new BadPreconditionsError({
      cause: `${root} has no git identity: its own git config sets no user.name and user.email, and there is no terminal to ask for one`,
      fix: `Run \`jive init\` in ${root} in a terminal: it asks for the name and email this workspace's commits carry`,
    }));
    expect(Bun.spawnSync(["git", "config", "--local", "--get", "gpg.format"], { cwd: root, env: process.env }).exitCode).toBe(1);
  }, 30_000);

  test("init refuses a name or email git couldn't put in a commit, changing nothing", async () => {
    const root = monorepo({ name: "bad-identity", submodules: [], identity: "none" });
    const { exit } = await runJiveIn(root, ["init"], prompting({ terminal: true, identity: { name: "Zoë", email: "not an email" } }).prompt);
    expect(errorOf(exit)).toEqual(new BadArgumentError({ argument: "git identity", reason: "a git email has an @ and holds no spaces, <, > or line break" }));
    expect(Bun.spawnSync(["git", "config", "--local", "--get", "user.name"], { cwd: root, env: process.env }).exitCode).toBe(1);
  }, 30_000);

  test("load refuses in a workspace whose root has no git identity, saying to run jive init", async () => {
    const root = monorepo({ name: "load-no-identity", submodules: [], identity: "none" });
    const { exit } = await runJiveIn(root, ["load", "acme", "decomp-project-image"]);
    expect(errorOf(exit)).toEqual(new BadPreconditionsError({
      cause: `${root} has no git identity: its own git config sets no user.name and user.email`,
      fix: `Run \`jive init\` in ${root} in a terminal: it asks for the name and email this workspace's commits carry`,
    }));
    expect(existsSync(path.join(root, "packages", "decomp-project-image"))).toBe(false);
  }, 30_000);

  test("load refuses a checkout of the repo that isn't at packages/<package name>, naming where it belongs", async () => {
    const root = monorepo({ name: "misplaced", submodules: [] });
    sh(["git", "clone", "-q", acme("server-repo"), path.join(root, "packages", "server")], root);
    const error = errorOf((await runJiveIn(root, ["load", "acme", "server-repo"])).exit);
    expect(error instanceof BadPreconditionsError && error.cause)
      .toBe("acme/server-repo is at packages/server, but jive keeps the package @jive-sh/server at packages/@jive-sh/server");
  }, 30_000);
});
