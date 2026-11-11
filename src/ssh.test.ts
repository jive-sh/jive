import { afterAll, beforeAll, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { Cli, OSPlatform, OSPlatformImpl } from "jive-abstract-library";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { AccountKeyImpl } from "@/modules/account-key/impl";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import type { Session } from "@/modules/jive-server/interface";
import { ModulesLayer } from "@/modules/runtime";
import { SessionImpl } from "@/modules/session/impl";
import { SigningAgentImpl } from "@/modules/signing-agent/impl";
import { sshString } from "@/modules/signing-agent/protocol";
import { serveSigningAgent } from "@/modules/signing-agent/socket-server";
import { sshArgumentsThroughAgent, sshCommandLineThroughAgent } from "@/modules/signing-agent/ssh-clients";
import { jive } from "@/program";

/**
 * `jive ssh connect` and `jive ssh sign` as the CLI runs them, against the real signing agent on a scratch socket, a
 * fake Jive server that signs with a key made here, and an sshd on this machine that accepts only that key. The
 * scratch home starts with no account.pub, so the first command fetches it. No ~/.ssh is read: every ssh run passes
 * `-F /dev/null` and `UserKnownHostsFile=/dev/null` through jive.
 */

// Short: the agent's socket path must stay under macOS's 104-byte limit.
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "js-")));
const home = path.join(scratch, "h");
const sshdDir = path.join(scratch, "sshd");
const paths = jiveHomePaths(home);
const user = userInfo().username;
const originalAgentSocket = process.env["SSH_AUTH_SOCK"];

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const encoder = new TextEncoder();
const keyBlob = new Uint8Array([
  ...sshString(encoder.encode("ssh-ed25519")),
  ...sshString(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")),
]);
const publicKeyLine = `ssh-ed25519 ${Buffer.from(keyBlob).toString("base64")} tester@jive.sh`;

/** What the fake server was asked. */
const server = { publicKeyFetches: 0, signatures: 0 };
const fakeServer = JiveServerImpl.mockLayer({
  *sshPublicKey() {
    server.publicKeyFetches += 1;
    return publicKeyLine;
  },
  *signWithSshKey(_session: Session, data: Uint8Array) {
    server.signatures += 1;
    return new Uint8Array([...sshString(encoder.encode("ssh-ed25519")), ...sshString(sign(null, data, privateKey))]);
  },
});
// A live session, so nothing opens a sign-in page.
const signedIn = SessionImpl.mockLayer({
  *ensureSignedIn() { return { sessionToken: "jive_session", expiresAt: Date.now() + 3_600_000 }; },
});

/** The host as jive sees it, with its home in the scratch directory: Bun reads HOME once, at startup. */
const scratchHost = e.Layer.effect(OSPlatform, e.Effect.gen(function* () {
  const real = yield* OSPlatform;
  return Object.assign(Object.create(real), { *getHomeDirectory() { return home; } });
})).pipe(e.Layer.provide(OSPlatformImpl.Layer));

/** The account key module jive and the agent use here: the real one, on the fake server. The host comes from outside. */
const accountKeyLayer = e.pipe(
  AccountKeyImpl.Layer,
  e.Layer.provideMerge(signedIn),
  e.Layer.provideMerge(fakeServer),
);

let closeAgent: () => Promise<void> = async () => {};
let sshdPid: number | undefined;
let port = 0;

beforeAll(async () => {
  // A socket nothing serves, so a child that missed the agent jive points it at fails rather than reaching a real one.
  process.env["SSH_AUTH_SOCK"] = path.join(scratch, "no-agent.sock");
  mkdirSync(paths.jiveHome, { recursive: true });
  mkdirSync(sshdDir);
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  port = listener.port;
  listener.stop(true);
  const hostKey = path.join(sshdDir, "host_key");
  expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]).exitCode).toBe(0);
  writeFileSync(path.join(sshdDir, "authorized_keys"), `${publicKeyLine}\n`);
  writeFileSync(path.join(sshdDir, "sshd_config"), [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`,
    `AuthorizedKeysFile ${path.join(sshdDir, "authorized_keys")}`, `PidFile ${path.join(sshdDir, "sshd.pid")}`,
    "StrictModes no", "UsePAM no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PermitUserRC no", "",
  ].join("\n"));
  expect(Bun.spawnSync(["/usr/sbin/sshd", "-f", path.join(sshdDir, "sshd_config"), "-E", path.join(sshdDir, "sshd.log")]).exitCode).toBe(0);
  for (let attempt = 0; attempt < 50 && !existsSync(path.join(sshdDir, "sshd.pid")); attempt += 1) await Bun.sleep(100);
  sshdPid = Number.parseInt(readFileSync(path.join(sshdDir, "sshd.pid"), "utf8"), 10);

  const scope = await e.Effect.runPromise(e.Scope.make());
  await e.Effect.runPromise(e.pipe(
    serveSigningAgent(paths.agentSocket),
    e.Scope.provide(scope),
    e.Effect.provide(e.pipe(SigningAgentImpl.Layer, e.Layer.provideMerge(accountKeyLayer), e.Layer.provideMerge(scratchHost), e.Layer.provideMerge(BunServices.layer))),
  ));
  closeAgent = () => e.Effect.runPromise(e.Scope.close(scope, e.Exit.void));
});

afterAll(async () => {
  await closeAgent();
  if (originalAgentSocket === undefined) delete process.env["SSH_AUTH_SOCK"];
  else process.env["SSH_AUTH_SOCK"] = originalAgentSocket;
  if (sshdPid !== undefined) process.kill(sshdPid, "SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs jive in this process on `args`, the way the entrypoint does; ssh and ssh-keygen get this process's stdio. */
function runJive(args: ReadonlyArray<string>): Promise<e.Exit.Exit<void, unknown>> {
  return e.Effect.runPromise(e.pipe(
    Cli.run(jive, { version: "0.0.0-test" }),
    e.Effect.provide(accountKeyLayer),
    e.Effect.provide(ModulesLayer),
    e.Effect.provide(scratchHost),
    e.Effect.provide(e.Stdio.layerTest({ args: e.Effect.succeed(args) })),
    e.Effect.provide(BunServices.layer),
    e.Effect.exit,
  ));
}

const errorOf = (exit: e.Exit.Exit<void, unknown>) => e.Option.getOrUndefined(e.Exit.findErrorOption(exit));

/** ssh's words for the sshd here, after `jive ssh connect`: no ~/.ssh read, and the new host key accepted. */
const toLocalSshd = () => [
  "-F", "/dev/null", "-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
  `${user}@127.0.0.1`, "-p", String(port),
];

test("ssh connect and jive init give ssh the same options, built from one place, and init's line is as before", () => {
  const key = { homeDirectory: "/home/tester", publicKeyFile: "/home/tester/.jive/ssh/account.pub" };
  expect(sshArgumentsThroughAgent(key)).toEqual([
    "-o", "IdentityAgent=/home/tester/.jive/signing-agent.sock",
    "-o", "IdentityFile=/home/tester/.jive/ssh/account.pub",
    "-o", "IdentitiesOnly=yes",
  ]);
  // What jive 0.6.0 wrote into core.sshCommand, character for character.
  expect(sshCommandLineThroughAgent(key)).toBe(
    'ssh -o IdentityAgent="/home/tester/.jive/signing-agent.sock" -o IdentityFile="/home/tester/.jive/ssh/account.pub" -o IdentitiesOnly=yes',
  );
});

test("with no account.pub, ssh connect fetches it, then logs in with the account key through the agent, passing every word to ssh", async () => {
  expect(existsSync(paths.accountPublicKeyFile)).toBe(false);
  const ran = path.join(scratch, "ran-over-ssh.txt");
  const exit = await runJive(["ssh", "connect", ...toLocalSshd(), `printf through-jive > ${ran}`]);
  expect(exit).toEqual(e.Exit.void);
  expect(readFileSync(ran, "utf8")).toBe("through-jive");
  expect(readFileSync(paths.accountPublicKeyFile, "utf8")).toBe(`${publicKeyLine}\n`);
  expect(server.publicKeyFetches).toBe(1);
  expect(server.signatures).toBe(1);
  expect(readFileSync(path.join(sshdDir, "sshd.log"), "utf8")).toContain("Accepted publickey");
}, 30_000);

test("ssh connect uses the account.pub it keeps without asking the server again, and passes ssh's exit code on", async () => {
  const failing = errorOf(await runJive(["ssh", "connect", ...toLocalSshd(), "exit 7"]));
  expect(failing instanceof Cli.CliError && failing.exitCode).toBe(7);
  expect(server.publicKeyFetches).toBe(1);
}, 30_000);

test("ssh connect gives ssh this terminal, so an interactive session gets a real one", async () => {
  // The jive entrypoint under `script`, which gives it a terminal; the remote command records whether ssh -t had one to
  // pass on. HOME is the scratch home, where account.pub is kept, so nothing reaches the server.
  const ran = path.join(scratch, "terminal.txt");
  const command = ["bun", path.join(import.meta.dir, "entrypoints", "jive.ts"), "ssh", "connect", ...toLocalSshd().filter((word) => word !== "-n"), "-t", `tty -s && echo has-a-terminal > ${ran}`];
  const quoted = command.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
  const underScript = process.platform === "darwin" ? ["script", "-q", "/dev/null", ...command] : ["script", "-qec", quoted, "/dev/null"];
  // This jive is the real entrypoint, on the real server's address; a proxy nothing serves keeps a broken build that
  // asks the server anyway from reaching it.
  const unreachable = "http://127.0.0.1:9";
  const child = Bun.spawn(underScript, {
    env: { ...process.env, HOME: home, HTTPS_PROXY: unreachable, HTTP_PROXY: unreachable, NO_PROXY: "" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(output).not.toContain("Pseudo-terminal will not be allocated");
  expect(exitCode).toBe(0);
  expect(readFileSync(ran, "utf8")).toBe("has-a-terminal\n");
}, 30_000);

test("ssh sign signs a file through the agent, and ssh-keygen -Y verify accepts the signature against account.pub", async () => {
  const notes = path.join(scratch, "notes.txt");
  writeFileSync(notes, "signed by jive\n");
  const signaturesBefore = server.signatures;
  expect(await runJive(["ssh", "sign", "-n", "file", notes])).toEqual(e.Exit.void);
  expect(server.signatures).toBe(signaturesBefore + 1);
  const allowedSigners = path.join(scratch, "allowed_signers");
  writeFileSync(allowedSigners, `tester@jive.sh ${readFileSync(paths.accountPublicKeyFile, "utf8")}`);
  const verified = Bun.spawnSync(
    ["ssh-keygen", "-Y", "verify", "-f", allowedSigners, "-I", "tester@jive.sh", "-n", "file", "-s", `${notes}.sig`],
    { stdin: new Blob([readFileSync(notes)]), stdout: "pipe", stderr: "pipe" },
  );
  expect(verified.stdout.toString()).toContain('Good "file" signature for tester@jive.sh');
});

test("ssh sign passes ssh-keygen's exit code on", async () => {
  const missing = path.join(scratch, "no-such-file.txt");
  // Async: the agent ssh-keygen may ask runs on this process's event loop.
  const direct = await Bun.spawn(["ssh-keygen", "-Y", "sign", "-f", paths.accountPublicKeyFile, "-n", "file", missing], {
    env: { ...process.env, SSH_AUTH_SOCK: paths.agentSocket }, stdout: "ignore", stderr: "ignore",
  }).exited;
  expect(direct).not.toBe(0);
  const failing = errorOf(await runJive(["ssh", "sign", "-n", "file", missing]));
  expect(failing instanceof Cli.CliError && failing.exitCode).toBe(direct);
});
