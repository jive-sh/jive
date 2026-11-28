import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatformImpl } from "jive-abstract-library";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { AccountKeyImpl } from "@/modules/account-key/impl";
import { ExtensionDaemonImpl } from "@/modules/extension-daemon/impl";
import { serveExtensionDaemon } from "@/modules/extension-daemon/socket-server";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import { MachineSignInImpl } from "@/modules/machine-sign-in/impl";
import { JiveServerUnreachable, type Session } from "@/modules/jive-server/interface";
import { NpmCredentialPosterNotDecidedImpl } from "@/modules/npm-credential-poster/not-decided";
import { GitHubActionsIdentityImpl } from "@/modules/pipeline-identity/impl";
import { SessionImpl } from "@/modules/session/impl";
import { SignInFailed } from "@/modules/session/interface";
import { InsideDaemonSignInRouteImpl } from "@/modules/session/sign-in-route";
import { SigningAgentImpl } from "@/modules/signing-agent/impl";
import { sshString } from "@/modules/signing-agent/protocol";
import { serveSigningAgent } from "@/modules/signing-agent/socket-server";

/**
 * `jive-ssh` and `jive-ssh-sign` as git runs them: processes started from their entrypoints, with stock ssh and
 * ssh-keygen behind them. jive-daemon's two sockets run in this process, the API socket answering `GetSession` and the
 * signing agent, both on a fake Jive server that signs with a key made here and can be made unreachable. ssh logs in
 * to an sshd on this machine that accepts only that key. Every process gets HOME in the scratch directory, so the
 * session file, account.pub and sockets are the test's own; ssh reads no ~/.ssh (`-F /dev/null`).
 */

// Short: the sockets' paths must stay under macOS's 104-byte limit.
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "js-")));
const home = path.join(scratch, "h");
/** A home with an account key whose daemon never started. */
const homeWithoutDaemon = path.join(scratch, "n");
const sshdDir = path.join(scratch, "sshd");
const paths = jiveHomePaths(home);
const user = userInfo().username;
const SERVER_URL = "https://api.jive.example";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const encoder = new TextEncoder();
const keyBlob = new Uint8Array([
  ...sshString(encoder.encode("ssh-ed25519")),
  ...sshString(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")),
]);
const publicKeyLine = `ssh-ed25519 ${Buffer.from(keyBlob).toString("base64")} tester@jive.sh`;

/** What the fake server was asked, and whether it can be reached. */
const server = { reachable: true, signatures: 0 };
const unreachable = (call: string) => new JiveServerUnreachable({ call, url: SERVER_URL, transportFailure: "TransportError" });
const fakeServer = JiveServerImpl.mockLayer({
  *accountOf(session: Session) {
    if (!server.reachable) return yield* unreachable("accounts:me");
    return session.sessionToken === "jive_session" ? e.Option.some({ username: "tester", sessionExpiresAt: Date.now() + 86_400_000 }) : e.Option.none();
  },
  *signWithSshKey(_session: Session, data: Uint8Array) {
    if (!server.reachable) return yield* unreachable("ssh:sign");
    server.signatures += 1;
    return new Uint8Array([...sshString(encoder.encode("ssh-ed25519")), ...sshString(sign(null, data, privateKey))]);
  },
});
/** A sign-in would show the person a page; no case here may start one. */
let signInsShown = 0;
const countingSignIn = MachineSignInImpl.mockLayer({
  *waiting() { return e.Option.none(); },
  *startOrJoin() {
    signInsShown += 1;
    return yield* new SignInFailed({ reason: "no case here signs in" });
  },
});

const daemonLayer = e.pipe(
  SigningAgentImpl.Layer,
  e.Layer.provideMerge(ExtensionDaemonImpl.Layer),
  e.Layer.provideMerge(AccountKeyImpl.Layer),
  e.Layer.provideMerge(NpmCredentialPosterNotDecidedImpl.Layer),
  e.Layer.provideMerge(countingSignIn),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(InsideDaemonSignInRouteImpl.Layer),
  e.Layer.provideMerge(GitHubActionsIdentityImpl.mockLayer({})),
  e.Layer.provideMerge(fakeServer),
  // Bun reads HOME once at startup, so the scratch home reaches the daemon through the platform it asks.
  e.Layer.provideMerge(OSPlatformImpl.mockLayer({ *getHomeDirectory() { return home; } })),
  e.Layer.provideMerge(BunServices.layer),
);

const signIn = () => writeFileSync(paths.sessionFile, `${JSON.stringify({ sessionToken: "jive_session", expiresAt: Date.now() + 3_600_000, username: "tester" })}\n`, { mode: 0o600 });

let closeDaemon: () => Promise<void> = async () => {};
let sshdPid: number | undefined;
let port = 0;

beforeAll(async () => {
  for (const directory of [home, homeWithoutDaemon]) {
    const keyFile = jiveHomePaths(directory).accountPublicKeyFile;
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, `${publicKeyLine}\n`);
  }
  signIn();

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
    e.Effect.all([serveSigningAgent(paths.agentSocket), serveExtensionDaemon(paths.daemonSocket)]),
    e.Scope.provide(scope),
    e.Effect.provide(daemonLayer),
  ));
  closeDaemon = () => e.Effect.runPromise(e.Scope.close(scope, e.Exit.void));
});

afterAll(async () => {
  await closeDaemon();
  if (sshdPid !== undefined) process.kill(sshdPid, "SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs `jive-ssh` or `jive-ssh-sign` from source, as git would, with HOME at `homeDirectory`. */
async function runWrapper({ command, args, homeDirectory = home, stdin }: {
  readonly command: "jive-ssh" | "jive-ssh-sign";
  readonly args: ReadonlyArray<string>;
  readonly homeDirectory?: string;
  readonly stdin?: string;
}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  // Async: the daemon answering the child runs on this process's event loop. SSH_AUTH_SOCK names a socket nothing
  // serves, so a child that missed jive's agent fails rather than reaching a real one.
  const child = Bun.spawn(["bun", path.join(import.meta.dir, "entrypoints", `${command}.ts`), ...args], {
    cwd: scratch,
    env: { ...process.env, HOME: homeDirectory, SSH_AUTH_SOCK: path.join(scratch, "no-agent.sock") },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

/** ssh's words for the sshd here: no ~/.ssh read, the new host key accepted, nothing of ssh's own on stderr. */
const toLocalSshd = (...command: ReadonlyArray<string>) => [
  "-F", "/dev/null", "-n", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
  `${user}@127.0.0.1`, "-p", String(port), ...command,
];

const fileToSign = () => {
  const file = path.join(scratch, `commit-${Math.random()}.txt`);
  writeFileSync(file, `tree ${Math.random()}\n`);
  return file;
};

const allowedSigners = () => {
  const file = path.join(scratch, "allowed_signers");
  writeFileSync(file, `tester@jive.sh ${publicKeyLine}\n`);
  return file;
};

describe("signed in, with the server reachable", () => {
  test("jive-ssh logs in with the account key, passes git's -o SendEnv and ssh's exit code on, and says nothing itself", async () => {
    const ran = path.join(scratch, "ran-over-ssh.txt");
    const signatures = server.signatures;
    // `-i` in the remote command is the command's, not ssh's.
    const loggedIn = await runWrapper({ command: "jive-ssh", args: ["-o", "SendEnv=GIT_PROTOCOL", ...toLocalSshd(`ls -i /dev/null > /dev/null && printf through-jive > ${ran}`)] });
    expect(loggedIn).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(ran, "utf8")).toBe("through-jive");
    expect(server.signatures).toBe(signatures + 1);
    expect(readFileSync(path.join(sshdDir, "sshd.log"), "utf8")).toContain("Accepted publickey");
    expect((await runWrapper({ command: "jive-ssh", args: toLocalSshd("exit 7") })).exitCode).toBe(7);
  }, 30_000);

  test("jive-ssh-sign signs git's -Y sign through the agent, and passes -Y verify to ssh-keygen, which accepts the signature", async () => {
    const file = fileToSign();
    const signed = await runWrapper({ command: "jive-ssh-sign", args: ["-Y", "sign", "-n", "git", "-f", paths.accountPublicKeyFile, file] });
    expect(signed.exitCode).toBe(0);
    expect(signed.stderr).not.toContain("jive-ssh-sign:");
    const verified = await runWrapper({
      command: "jive-ssh-sign",
      args: ["-Y", "verify", "-f", allowedSigners(), "-I", "tester@jive.sh", "-n", "git", "-s", `${file}.sig`],
      stdin: readFileSync(file, "utf8"),
    });
    expect(verified.stdout).toContain('Good "git" signature for tester@jive.sh');
    expect(verified.exitCode).toBe(0);
  });

  test("jive-ssh-sign passes everything but -Y sign to ssh-keygen unchanged, without asking the daemon: git's checks, -l, even making a key", async () => {
    const file = fileToSign();
    expect((await runWrapper({ command: "jive-ssh-sign", args: ["-Y", "sign", "-n", "git", "-f", paths.accountPublicKeyFile, file] })).exitCode).toBe(0);
    // The home whose daemon never started: none of these asks it.
    const homeDirectory = homeWithoutDaemon;
    const principals = await runWrapper({ command: "jive-ssh-sign", args: ["-Y", "find-principals", "-f", allowedSigners(), "-s", `${file}.sig`], homeDirectory });
    expect({ exitCode: principals.exitCode, stdout: principals.stdout.trim() }).toEqual({ exitCode: 0, stdout: "tester@jive.sh" });
    const checked = await runWrapper({ command: "jive-ssh-sign", args: ["-Y", "check-novalidate", "-n", "git", "-s", `${file}.sig`], stdin: readFileSync(file, "utf8"), homeDirectory });
    expect(checked.exitCode).toBe(0);
    const fingerprint = await runWrapper({ command: "jive-ssh-sign", args: ["-l", "-f", paths.accountPublicKeyFile], homeDirectory });
    const plainFingerprint = Bun.spawnSync(["ssh-keygen", "-l", "-f", paths.accountPublicKeyFile], { stdout: "pipe", stderr: "pipe" });
    expect(fingerprint).toEqual({ exitCode: 0, stdout: plainFingerprint.stdout.toString(), stderr: "" });
    const newKey = path.join(scratch, "new-key");
    expect((await runWrapper({ command: "jive-ssh-sign", args: ["-q", "-t", "ed25519", "-N", "", "-f", newKey], homeDirectory })).exitCode).toBe(0);
    expect(existsSync(newKey)).toBe(true);
  });

  test("ssh options jive-ssh's own override, or that add a key or forward the agent, are each named on stderr, and ssh still logs in", async () => {
    const loggedIn = await runWrapper({
      command: "jive-ssh",
      args: ["-o", "IdentityAgent=/elsewhere.sock", "-oIdentitiesOnly=no", "-o", "IdentityFile /nowhere/key", "-A", ...toLocalSshd("true")],
    });
    expect(loggedIn).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: [
        "jive-ssh: warning: -o IdentityAgent=/elsewhere.sock has no effect: jive-ssh passes IdentityAgent=~/.jive/signing-agent.sock first, and ssh keeps the first value",
        "jive-ssh: warning: -o IdentitiesOnly=no has no effect: jive-ssh passes IdentitiesOnly=yes first, and ssh keeps the first value",
        "jive-ssh: warning: -o IdentityFile /nowhere/key adds a second key: ssh offers your Jive account key, ~/.jive/ssh/account.pub, first, then /nowhere/key",
        "jive-ssh: warning: -A forwards jive's agent: while you are connected, the remote host can sign as tester with your Jive key",
        "",
      ].join("\n"),
    });
    const forwarded = await runWrapper({ command: "jive-ssh", args: [...toLocalSshd(), "-o", "ForwardAgent=yes", "true"] });
    expect(forwarded.stderr).toBe("jive-ssh: warning: -o ForwardAgent=yes forwards jive's agent: while you are connected, the remote host can sign as tester with your Jive key\n");
  }, 30_000);
});

describe("refusals, each before ssh or ssh-keygen runs", () => {
  test("-i is refused, even naming the Jive key itself, in either spelling and after the destination", async () => {
    const signatures = server.signatures;
    for (const args of [
      ["-i", paths.accountPublicKeyFile, ...toLocalSshd("true")],
      [`-i${paths.accountPublicKeyFile}`, ...toLocalSshd("true")],
      [`${user}@127.0.0.1`, "-i", paths.accountPublicKeyFile, "true"],
    ]) {
      expect(await runWrapper({ command: "jive-ssh", args })).toEqual({
        exitCode: 255,
        stdout: "",
        stderr: `jive-ssh: -i is not accepted. jive-ssh always logs in with your Jive account key, ~/.jive/ssh/account.pub, signed in as tester. To log in with another key, use plain ssh -i ${paths.accountPublicKeyFile}. If you need -i with jive-ssh, tell us what for.\n`,
      });
    }
    expect(server.signatures).toBe(signatures);
  });

  const causes = [
    {
      name: "not signed in",
      arrange: () => rmSync(paths.sessionFile, { force: true }),
      homeDirectory: home,
      message: "not signed in to Jive; run `jive login`",
    },
    {
      name: "the server unreachable",
      arrange: () => { server.reachable = false; },
      homeDirectory: home,
      message: `your computer can't reach Jive's server (${SERVER_URL}) to sign as tester; reconnect and run the command again`,
    },
    {
      name: "the daemon not running",
      arrange: () => {},
      homeDirectory: homeWithoutDaemon,
      message: "jive's daemon is not running; run `jive daemons` to see why; `jive upgrade` registers and starts it again, and so does logging in again",
    },
  ];

  test.each(causes)("with $name, jive-ssh and jive-ssh-sign say so and exit 255, and nothing signs or opens a sign-in", async ({ arrange, homeDirectory, message }) => {
    const signatures = server.signatures;
    arrange();
    try {
      expect(await runWrapper({ command: "jive-ssh", args: toLocalSshd("true"), homeDirectory })).toEqual({ exitCode: 255, stdout: "", stderr: `jive-ssh: ${message}\n` });
      const file = fileToSign();
      expect(await runWrapper({ command: "jive-ssh-sign", args: ["-Y", "sign", "-n", "git", "-f", jiveHomePaths(homeDirectory).accountPublicKeyFile, file], homeDirectory })).toEqual({ exitCode: 255, stdout: "", stderr: `jive-ssh-sign: ${message}\n` });
      expect(existsSync(`${file}.sig`)).toBe(false);
    } finally {
      server.reachable = true;
      signIn();
    }
    expect(server.signatures).toBe(signatures);
    expect(signInsShown).toBe(0);
  }, 30_000);

  test("-G prints what plain ssh with jive's options prints, even while the daemon is not running", async () => {
    const withoutDaemon = jiveHomePaths(homeWithoutDaemon);
    const printed = await runWrapper({ command: "jive-ssh", args: ["-G", "-F", "/dev/null", "example.com"], homeDirectory: homeWithoutDaemon });
    const plain = Bun.spawnSync([
      "ssh", "-o", `IdentityAgent=${withoutDaemon.agentSocket}`, "-o", `IdentityFile=${withoutDaemon.accountPublicKeyFile}`, "-o", "IdentitiesOnly=yes",
      "-G", "-F", "/dev/null", "example.com",
    ], { env: { ...process.env, HOME: homeWithoutDaemon }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(printed).toEqual({ exitCode: plain.exitCode, stdout: plain.stdout.toString(), stderr: plain.stderr.toString() });
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout + printed.stderr).toContain(`identityagent ${withoutDaemon.agentSocket}\n`);
  });
});

describe("jive whoami asks the same daemon", () => {
  const whoami = async () => {
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "entrypoints", "jive.ts"), "whoami"], {
      cwd: scratch, env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exitCode, stdout, stderr };
  };

  test("prints the account the server confirms", async () => {
    expect(await whoami()).toEqual({ exitCode: 0, stdout: "tester\n", stderr: "" });
  });

  test("offline, prints the saved account, marked unconfirmed", async () => {
    server.reachable = false;
    try {
      expect(await whoami()).toEqual({ exitCode: 0, stdout: "tester (not confirmed: can't reach Jive's server)\n", stderr: "" });
    } finally {
      server.reachable = true;
    }
  });

  test("signed out, says so with the fix", async () => {
    rmSync(paths.sessionFile);
    try {
      expect(await whoami()).toEqual({ exitCode: 1, stdout: "", stderr: "ERROR: You are not logged in\nERROR: Fix: Run `jive login`\n" });
    } finally {
      signIn();
    }
  });
});
