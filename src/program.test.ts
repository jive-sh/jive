import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { Cli } from "jive-abstract-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { AccountKeyImpl } from "@/modules/account-key/impl";
import { AccountKeyError } from "@/modules/account-key/interface";
import { AuthImpl } from "@/modules/auth/impl";
import type { CurrentUser } from "@/modules/auth/interface";
import { GithubAccessTokenType } from "@/modules/github/interface";
import { ModulesLayer } from "@/modules/runtime";
import { jive } from "@/program";

/**
 * Runs `jive load`, `on` and `unload` against a scratch workspace. Nothing reaches GitHub: a git config the test
 * owns (GIT_CONFIG_GLOBAL) rewrites https://github.com/ to a directory of local bare repos, and sign-in is a fake
 * user. `bun link` writes under a scratch BUN_INSTALL instead of the real global link directory.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "jive-program-test-")));
const remotes = path.join(scratch, "remotes");
const workspace = path.join(scratch, "workspace");
const bunHome = path.join(scratch, "bun-home");
const originalDirectory = process.cwd();
const originalEnv = { ...process.env };

function sh(command: ReadonlyArray<string>, cwd: string): string {
  // Bun.spawnSync without env passes the environment the test started with, not the scratch git config.
  const result = Bun.spawnSync([...command], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

beforeAll(() => {
  mkdirSync(remotes, { recursive: true });
  const gitConfig = path.join(scratch, "gitconfig");
  writeFileSync(gitConfig, [
    `[url "file://${remotes}/"]`, `\tinsteadOf = https://github.com/`,
    `[protocol "file"]`, `\tallow = always`,
    `[user]`, `\tname = Jive Test`, `\temail = test@example.com`,
    `[init]`, `\tdefaultBranch = main`,
    `[commit]`, `\tgpgSign = false`,
  ].join("\n"));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", BUN_INSTALL: bunHome });

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

  mkdirSync(path.join(workspace, ".jive"), { recursive: true });
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
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "BUN_INSTALL"]) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const fakeUser = e.Effect.sync(() => {
  const publicKeyFile = path.join(scratch, "account.pub");
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl jive-test@jive.sh";
  writeFileSync(publicKeyFile, `${publicKey}\n`);
  const user: CurrentUser = {
    username: "jive-test",
    email: "test@example.com",
    githubAccessToken: { accessToken: "not-a-token", tokenType: GithubAccessTokenType.OAuthApp() },
    accountKey: { publicKey, publicKeyFile },
  };
  return user;
});

interface Outcome {
  readonly stdout: string;
  readonly exit: e.Exit.Exit<void, unknown>;
}

/** Runs jive in this process on `args`, the way the entrypoint does, with sign-in replaced by the fake user. */
async function runJive(args: ReadonlyArray<string>): Promise<Outcome> {
  const stdout: Array<string> = [];
  const user = await e.Effect.runPromise(e.pipe(fakeUser, e.Effect.provide(BunServices.layer)));
  const exit = await e.Effect.runPromise(e.pipe(
    Cli.run(jive, { version: "0.0.0-test" }),
    e.Effect.provide(AuthImpl.mockLayer({ *ensureLoggedIn() { return user; } })),
    // No test signs in to Jive: one that reaches the account key would open a sign-in page in the browser.
    e.Effect.provide(AccountKeyImpl.mockLayer({ *ensure() { return yield* new AccountKeyError({ reason: "tests do not sign in" }); } })),
    e.Effect.provide(ModulesLayer),
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

const errorOf = (exit: e.Exit.Exit<void, unknown>) => e.Option.getOrUndefined(e.Exit.findErrorOption(exit));
const widget = () => path.join(workspace, "@acme", "widget");
const gitConfigIn = (directory: string, key: string) => sh(["git", "config", "--local", "--get", key], directory);

describe("jive in a workspace", () => {
  test("load clones the repo as a submodule, configures it for the user, installs and links it", async () => {
    const { exit } = await runJive(["load", "acme", "widget"]);
    expect(exit).toEqual(e.Exit.void);

    expect(JSON.parse(readFileSync(path.join(widget(), "package.json"), "utf8")).name).toBe("@acme/widget");
    expect(readFileSync(path.join(workspace, ".gitmodules"), "utf8")).toContain("url = https://github.com/acme/widget.git");
    expect(gitConfigIn(widget(), "remote.origin.url")).toBe("https://github.com/acme/widget.git");
    expect(gitConfigIn(widget(), "remote.origin.pushurl")).toBe("git@github.com:acme/widget.git");
    expect(gitConfigIn(widget(), "user.email")).toBe("test@example.com");
    expect(gitConfigIn(widget(), "user.signingKey")).toBe(path.join(scratch, "account.pub"));
    expect(gitConfigIn(widget(), "gpg.ssh.program")).toEndWith("jive-ssh-keygen");
    expect(gitConfigIn(widget(), "tag.gpgSign")).toBe("true");
    expect(gitConfigIn(widget(), "core.sshCommand")).toContain(`IdentityAgent=${JSON.stringify(path.join(homedir(), ".jive", "signing-agent.sock"))}`);
    // The widget's own submodule is fetched and configured too; .gitmodules records only https URLs.
    expect(readFileSync(path.join(widget(), "gadget", "gadget.txt"), "utf8")).toBe("gadget\n");
    expect(gitConfigIn(path.join(widget(), "gadget"), "gpg.ssh.program")).toEndWith("jive-ssh-keygen");
    expect(readFileSync(path.join(workspace, ".gitmodules"), "utf8")).not.toContain("git@");
    expect(readFileSync(path.join(widget(), "installed-here.txt"), "utf8").trim()).toBe(widget());
    expect(existsSync(path.join(bunHome, "install", "global", "node_modules", "@acme", "widget"))).toBe(true);
  });

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
    expect(existsSync(path.join(workspace, ".git", "modules", "@acme", "widget"))).toBe(false);
  });

  test("outside a workspace, a command says so", async () => {
    process.chdir(scratch);
    try {
      const error = errorOf((await runJive(["unload", "acme", "widget"])).exit);
      expect(error).toBeInstanceOf(BadPreconditionsError);
      expect(error instanceof BadPreconditionsError && error.cause).toBe(`${scratch} is not within a jive workspace.`);
    } finally {
      process.chdir(workspace);
    }
  });
});
