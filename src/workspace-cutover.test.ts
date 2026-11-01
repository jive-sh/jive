import { afterAll, beforeAll, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { Cli, OSPlatform, OSPlatformImpl } from "jive-abstract-library";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { AccountKeyImpl } from "@/modules/account-key/impl";
import { AuthImpl } from "@/modules/auth/impl";
import type { CurrentUser } from "@/modules/auth/interface";
import { GithubAccessTokenType } from "@/modules/github/interface";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import type { Session } from "@/modules/jive-server/interface";
import { ModulesLayer } from "@/modules/runtime";
import { SessionImpl } from "@/modules/session/impl";
import { SigningAgentImpl } from "@/modules/signing-agent/impl";
import { sshString } from "@/modules/signing-agent/protocol";
import { serveSigningAgent } from "@/modules/signing-agent/socket-server";
import { jive } from "@/program";

/**
 * The cutover from ozy to jive, on a scratch copy of a workspace shaped like Alex's: a root repository whose submodule
 * has a submodule of its own, every .gitmodules naming `git@github.com:` URLs, the nested one not checked out yet.
 * `jive init` runs as the CLI does. Then a commit in the nested submodule is signed through the real `jive-ssh-keygen`
 * entrypoint and the signing agent, `ssh-keygen -Y verify` accepts it, and it is pushed over SSH, through the agent,
 * to an sshd on this machine that accepts only the account key.
 *
 * Nothing reaches GitHub or Jive: https://github.com/ resolves to local bare repositories, git@github.com: to the
 * local sshd serving them, the Jive server is a fake that signs with a key made here, and the GitHub sign-in is a
 * fake user. HOME, the agent's socket and jive's installed commands all live in the scratch directory.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "jc-")));
const home = path.join(scratch, "h");
const installedBin = path.join(scratch, "bin");
const remotes = path.join(scratch, "remotes");
const checkout = path.join(scratch, "chaine");
const sshdDir = path.join(scratch, "sshd");
const paths = jiveHomePaths(home);
const originalEnv = { ...process.env };
const originalDirectory = process.cwd();
const user = userInfo().username;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const encoder = new TextEncoder();
const keyBlob = new Uint8Array([
  ...sshString(encoder.encode("ssh-ed25519")),
  ...sshString(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")),
]);
const publicKeyLine = `ssh-ed25519 ${Buffer.from(keyBlob).toString("base64")} tester@jive.sh`;

function sh(command: ReadonlyArray<string>, cwd: string): string {
  const result = Bun.spawnSync([...command], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Async: the signing agent answering these commands runs on this process's event loop. */
async function run(command: ReadonlyArray<string>, cwd: string, stdin?: string) {
  const child = Bun.spawn([...command], {
    cwd, env: process.env, stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout: stdout.trim(), stderr };
}

const gitConfigIn = (directory: string, key: string) => sh(["git", "config", "--local", "--get", key], directory);

/** The host as jive sees it, with its home and its install directory in the scratch directory. */
const scratchHost = e.Layer.effect(OSPlatform, e.Effect.gen(function* () {
  const real = yield* OSPlatform;
  return Object.assign(Object.create(real), {
    *getHomeDirectory() { return home; },
    *getExecutablePath() { return path.join(installedBin, "jive"); },
  });
})).pipe(e.Layer.provide(OSPlatformImpl.Layer));

/** The Jive server, signing with the key made here as the server signs with the account's sealed key. */
const fakeServer = JiveServerImpl.mockLayer({
  *signWithSshKey(_session: Session, data: Uint8Array) {
    return new Uint8Array([...sshString(encoder.encode("ssh-ed25519")), ...sshString(sign(null, data, privateKey))]);
  },
});
const signedIn = SessionImpl.mockLayer({
  *ensureSignedIn() { return { sessionToken: "jive_session", expiresAt: Date.now() + 3_600_000 }; },
});

const accountKey = { publicKey: publicKeyLine, publicKeyFile: paths.accountPublicKeyFile };
const githubUser: CurrentUser = {
  username: "tester",
  email: "tester@example.com",
  githubAccessToken: { accessToken: "not-a-token", tokenType: GithubAccessTokenType.OAuthApp() },
  accountKey,
};

let closeAgent: () => Promise<void> = async () => {};
let sshdPid: number | undefined;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

beforeAll(async () => {
  mkdirSync(path.dirname(paths.accountPublicKeyFile), { recursive: true });
  writeFileSync(paths.accountPublicKeyFile, `${publicKeyLine}\n`);

  // jive's installed jive-ssh-keygen, run from source with the scratch home.
  mkdirSync(installedBin);
  const keygen = path.join(installedBin, "jive-ssh-keygen");
  const entrypoint = path.join(import.meta.dir, "entrypoints", "jive-ssh-keygen.ts");
  writeFileSync(keygen, `#!/bin/sh\nexec env HOME=${JSON.stringify(home)} ${JSON.stringify(process.execPath)} ${JSON.stringify(entrypoint)} "$@"\n`);
  chmodSync(keygen, 0o755);

  // An sshd on this machine serving the bare repositories, accepting only the account key.
  mkdirSync(sshdDir);
  const port = freePort();
  sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path.join(sshdDir, "host_key")], scratch);
  writeFileSync(path.join(sshdDir, "authorized_keys"), `${publicKeyLine}\n`);
  writeFileSync(path.join(sshdDir, "sshd_config"), [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${path.join(sshdDir, "host_key")}`,
    `AuthorizedKeysFile ${path.join(sshdDir, "authorized_keys")}`, `PidFile ${path.join(sshdDir, "sshd.pid")}`,
    "StrictModes no", "UsePAM no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "",
  ].join("\n"));
  sh(["/usr/sbin/sshd", "-f", path.join(sshdDir, "sshd_config"), "-E", path.join(sshdDir, "sshd.log")], scratch);
  for (let attempt = 0; attempt < 50 && !existsSync(path.join(sshdDir, "sshd.pid")); attempt += 1) await Bun.sleep(100);
  sshdPid = Number.parseInt(readFileSync(path.join(sshdDir, "sshd.pid"), "utf8"), 10);

  // https://github.com/ is the local bare repositories; git@github.com: is them through the sshd.
  const gitConfig = path.join(scratch, "gitconfig");
  writeFileSync(gitConfig, [
    `[url "file://${remotes}/"]`, "\tinsteadOf = https://github.com/",
    `[url "ssh://${user}@127.0.0.1:${port}${remotes}/"]`, "\tinsteadOf = git@github.com:",
    `[protocol "file"]`, "\tallow = always",
    "[init]", "\tdefaultBranch = main",
    "[user]", "\tname = Seed", "\temail = seed@example.com",
    "[commit]", "\tgpgSign = false",
  ].join("\n"));
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" });

  // gadget, inside widget, inside the root; each .gitmodules names the git@github.com: URL, as Alex's do.
  mkdirSync(path.join(remotes, "acme"), { recursive: true });
  const seed = (name: string, build: (dir: string) => void) => {
    const dir = path.join(scratch, `${name}-source`);
    mkdirSync(dir);
    sh(["git", "init", "-q"], dir);
    build(dir);
    sh(["git", "add", "."], dir);
    sh(["git", "commit", "-qm", name], dir);
    sh(["git", "clone", "-q", "--bare", dir, path.join(remotes, "acme", `${name}.git`)], scratch);
  };
  // Seeding fetches git@ URLs from the files directly, as Alex's clones once did over SSH.
  const viaFiles = ["-c", `url.file://${remotes}/.insteadOf=git@github.com:`];
  seed("gadget", (dir) => writeFileSync(path.join(dir, "gadget.txt"), "gadget\n"));
  seed("loose", (dir) => writeFileSync(path.join(dir, "loose.txt"), "loose\n"));
  seed("widget", (dir) => sh(["git", ...viaFiles, "submodule", "add", "-q", "git@github.com:acme/gadget.git", "gadget"], dir));
  seed("chaine", (dir) => {
    // A committed .gitignore, as Alex's root has.
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
    sh(["git", ...viaFiles, "submodule", "add", "-q", "git@github.com:acme/widget.git", "packages/@acme/widget"], dir);
  });
  sh(["git", ...viaFiles, "clone", "-q", "git@github.com:acme/chaine.git", checkout], scratch);
  // widget checked out, gadget not: init has a missing nested submodule to fetch.
  sh(["git", ...viaFiles, "submodule", "update", "--init", "-q"], checkout);
  // A repository cloned into the workspace and never added as a submodule, as @jive-sh/server is in Alex's checkout.
  sh(["git", ...viaFiles, "clone", "-q", "git@github.com:acme/loose.git", path.join(checkout, "packages", "loose")], scratch);

  const agentLayer = e.pipe(
    SigningAgentImpl.Layer,
    e.Layer.provideMerge(AccountKeyImpl.Layer),
    e.Layer.provideMerge(signedIn),
    e.Layer.provideMerge(fakeServer),
    e.Layer.provideMerge(scratchHost),
    e.Layer.provideMerge(BunServices.layer),
  );
  const scope = await e.Effect.runPromise(e.Scope.make());
  await e.Effect.runPromise(e.pipe(serveSigningAgent(paths.agentSocket), e.Scope.provide(scope), e.Effect.provide(agentLayer)));
  closeAgent = () => e.Effect.runPromise(e.Scope.close(scope, e.Exit.void));
});

afterAll(async () => {
  await closeAgent();
  if (sshdPid !== undefined) process.kill(sshdPid, "SIGTERM");
  process.chdir(originalDirectory);
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnv)) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const widget = () => path.join(checkout, "packages", "@acme", "widget");
const gadget = () => path.join(widget(), "gadget");

test("jive init moves every .gitmodules to https, checks out the nested submodule, and points every repository at jive, untracked ones included", async () => {
  process.chdir(checkout);
  const exit = await e.Effect.runPromise(e.pipe(
    Cli.run(jive, { version: "0.0.0-test" }),
    e.Effect.provide(AuthImpl.mockLayer({ *ensureLoggedIn() { return githubUser; } })),
    e.Effect.provide(ModulesLayer),
    e.Effect.provide(scratchHost),
    e.Effect.provide(e.Stdio.layerTest({ args: e.Effect.succeed(["init"]) })),
    e.Effect.provide(BunServices.layer),
    e.Effect.exit,
  ));
  if (e.Exit.isFailure(exit)) throw new Error(`jive init failed: ${JSON.stringify(e.Cause.squash(exit.cause))}`);

  expect(readFileSync(path.join(checkout, ".gitmodules"), "utf8")).toContain("url = https://github.com/acme/widget.git");
  expect(readFileSync(path.join(widget(), ".gitmodules"), "utf8")).toContain("url = https://github.com/acme/gadget.git");
  expect(readFileSync(path.join(checkout, ".gitmodules"), "utf8") + readFileSync(path.join(widget(), ".gitmodules"), "utf8")).not.toContain("git@");
  expect(readFileSync(path.join(gadget(), "gadget.txt"), "utf8")).toBe("gadget\n");
  expect(readFileSync(path.join(checkout, ".gitignore"), "utf8")).toContain("/.jive/");

  for (const [repository, name] of [[checkout, "chaine"], [widget(), "widget"], [gadget(), "gadget"], [path.join(checkout, "packages", "loose"), "loose"]] as const) {
    expect(gitConfigIn(repository, "gpg.format")).toBe("ssh");
    expect(gitConfigIn(repository, "gpg.ssh.program")).toBe(path.join(installedBin, "jive-ssh-keygen"));
    expect(gitConfigIn(repository, "user.signingKey")).toBe(paths.accountPublicKeyFile);
    expect(gitConfigIn(repository, "commit.gpgSign")).toBe("true");
    expect(gitConfigIn(repository, "core.sshCommand")).toContain(`IdentityAgent=${JSON.stringify(paths.agentSocket)}`);
    expect(gitConfigIn(repository, "remote.origin.url")).toBe(`https://github.com/acme/${name}.git`);
    expect(gitConfigIn(repository, "remote.origin.pushurl")).toBe(`git@github.com:acme/${name}.git`);
  }
}, 60_000);

test("a commit in the nested submodule is signed through jive, ssh-keygen -Y verify accepts it, and it pushes over jive's SSH connection", async () => {
  writeFileSync(path.join(gadget(), "signed.txt"), "signed by jive\n");
  sh(["git", "add", "signed.txt"], gadget());
  const committed = await run(["git", "commit", "-m", "signed by jive"], gadget());
  expect(committed.stderr).not.toContain("error");
  expect(committed.exitCode).toBe(0);

  const allowedSigners = path.join(scratch, "allowed_signers");
  writeFileSync(allowedSigners, `tester@example.com ${publicKeyLine}\n`);
  const commit = sh(["git", "cat-file", "commit", "HEAD"], gadget());
  const signature = commit.slice(commit.indexOf("-----BEGIN SSH SIGNATURE-----"), commit.indexOf("-----END SSH SIGNATURE-----") + "-----END SSH SIGNATURE-----".length)
    .split("\n").map((line) => line.replace(/^ /, "")).join("\n");
  const signatureFile = path.join(scratch, "commit.sig");
  writeFileSync(signatureFile, `${signature}\n`);
  const payload = commit.replace(/^gpgsig [\s\S]*?-----END SSH SIGNATURE-----\n/m, "");
  const verified = await run(
    ["ssh-keygen", "-Y", "verify", "-f", allowedSigners, "-I", "tester@example.com", "-n", "git", "-s", signatureFile],
    gadget(),
    `${payload}\n`,
  );
  expect(verified.stdout).toContain('Good "git" signature for tester@example.com');

  // The sshd's host key is new to this machine: accept it, keeping the command jive configured.
  const sshCommand = `${gitConfigIn(gadget(), "core.sshCommand")} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  const pushed = await run(["git", "-c", `core.sshCommand=${sshCommand}`, "push", "origin", "HEAD:refs/heads/signed"], gadget());
  expect(pushed.stderr).not.toContain("Permission denied");
  expect(pushed.exitCode).toBe(0);
  const head = sh(["git", "rev-parse", "HEAD"], gadget());
  expect(sh(["git", "--git-dir", path.join(remotes, "acme", "gadget.git"), "rev-parse", "refs/heads/signed"], scratch)).toBe(head);
  expect(readFileSync(path.join(sshdDir, "sshd.log"), "utf8")).toContain("Accepted publickey");
}, 60_000);

/** The repository check and the rollback handed over in docs/ozy-cli-migration.md, step 4 and step 5, as written there. */
const everyRepository = `for d in . $(git submodule foreach --quiet --recursive pwd) $(git ls-files --others --exclude-standard --directory | sed -n 's#/$##p'); do [ -e "$d/.git" ] || continue;`;

test("the handed-over repository check finds every repository on jive, and the rollback puts each back on ozy", async () => {
  const check = await run(["sh", "-c", `${everyRepository} p=$(git -C "$d" config gpg.ssh.program); s=$(git -C "$d" config core.sshCommand); u=$(git -C "$d" config remote.origin.pushurl); case "$p$s$u" in *jive-ssh-keygen*signing-agent.sock*git@github.com:*) ;; *) echo "NOT ON JIVE: $d";; esac; done; echo "repo check done"`], checkout);
  expect(check.stdout).toBe("repo check done");
  const modules = await run(["sh", "-c", `for f in .gitmodules $(git submodule foreach --quiet --recursive 'test -f .gitmodules && echo "$toplevel/$sm_path/.gitmodules"'); do grep -H "url = git@" "$f"; done; echo ".gitmodules check done"`], checkout);
  expect(modules.stdout).toBe(".gitmodules check done");

  const ozyKeygen = path.join(scratch, "ozy-ssh-keygen");
  const ozyKey = path.join(scratch, "ozy-key.pub");
  const rollback = await run(["sh", "-c", [
    `${everyRepository} [ -f "$d/.gitmodules" ] && git -C "$d" restore --worktree .gitmodules; done`,
    "git restore --worktree .gitignore && git submodule sync --recursive",
    `${everyRepository}`,
    `  git -C "$d" config gpg.ssh.program ${ozyKeygen}`,
    `  git -C "$d" config user.signingkey ${ozyKey}`,
    `  git -C "$d" config --unset core.sshCommand; git -C "$d" config --unset remote.origin.pushurl`,
    `  url=$(git -C "$d" config remote.origin.url) && git -C "$d" remote set-url origin "$(echo "$url" | sed 's#^https://github.com/#git@github.com:#')"`,
    "done",
  ].join("\n")], checkout);
  expect(rollback.stderr).toBe("");
  expect(rollback.exitCode).toBe(0);
  for (const [repository, name] of [[checkout, "chaine"], [widget(), "widget"], [gadget(), "gadget"], [path.join(checkout, "packages", "loose"), "loose"]] as const) {
    expect(gitConfigIn(repository, "gpg.ssh.program")).toBe(ozyKeygen);
    expect(gitConfigIn(repository, "user.signingkey")).toBe(ozyKey);
    expect(gitConfigIn(repository, "remote.origin.url")).toBe(`git@github.com:acme/${name}.git`);
    expect(Bun.spawnSync(["git", "config", "--local", "--get", "core.sshCommand"], { cwd: repository }).exitCode).toBe(1);
  }
  expect(readFileSync(path.join(checkout, ".gitmodules"), "utf8")).toContain("url = git@github.com:acme/widget.git");
}, 60_000);
