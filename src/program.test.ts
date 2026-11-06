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
const widget = () => path.join(workspace, "@acme", "widget");
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
    expect(gitConfigIn(widget(), "gpg.ssh.program")).toEndWith("jive-ssh-keygen");
    expect(gitConfigIn(widget(), "core.sshCommand")).toContain(`IdentityAgent=${JSON.stringify(path.join(home, ".jive", "signing-agent.sock"))}`);
    // The widget's own submodule is fetched and configured too; .gitmodules records only https URLs.
    expect(readFileSync(path.join(widget(), "gadget", "gadget.txt"), "utf8")).toBe("gadget\n");
    expect(gitConfigIn(path.join(widget(), "gadget"), "gpg.ssh.program")).toEndWith("jive-ssh-keygen");
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
    expect(existsSync(path.join(workspace, ".git", "modules", "@acme", "widget"))).toBe(false);
  });

  test("provision sends the kind and the instance --instance gives, or the one package.json declares", async () => {
    provisioned.length = 0;
    expect((await runJive(["provision", "connector-package-registry", "@acme/widget", "--instance", '{"packageName":"@acme/widget"}'])).exit).toEqual(e.Exit.void);
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ jive: { resources: { "connector-package-registry": { "@acme/gadget": { packageName: "@acme/gadget" } } } } }));
    expect((await runJive(["provision", "connector-package-registry", "@acme/gadget"])).exit).toEqual(e.Exit.void);
    const undeclared = await runJive(["provision", "connector-package-registry", "@acme/missing"]);
    expect(errorOf(undeclared.exit)).toBeInstanceOf(BadArgumentError);
    rmSync(path.join(workspace, "package.json"));
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
      expect(error instanceof BadPreconditionsError && error.cause).toBe(`${scratch} is not within a jive workspace.`);
    } finally {
      process.chdir(workspace);
    }
  });
});
