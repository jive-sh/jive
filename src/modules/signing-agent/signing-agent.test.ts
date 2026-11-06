import { afterAll, beforeAll, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatformImpl } from "jive-abstract-library";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { AccountKeyImpl } from "@/modules/account-key/impl";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import { JiveServerError, SignInClaim, type OpenedSignInRequest, type Session } from "@/modules/jive-server/interface";
import { SessionImpl } from "@/modules/session/impl";
import { GitHubActionsIdentityImpl } from "@/modules/pipeline-identity/impl";
import { modules } from "@/modules";
import { TerminalSignInPromptImpl } from "@/modules/session/sign-in-prompt";
import { SigningAgentImpl } from "./impl";
import { serveSigningAgent } from "./socket-server";
import { sshString } from "./protocol";

/**
 * The signing agent end to end, with the real ssh-keygen and ssh-add as its clients: a fake server stands in for
 * `@jive-sh/server` and signs with a key made here, the way the server signs with the account's sealed key. HOME is a
 * scratch directory, so the session file, public key and socket are the test's own.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "jive-agent-")));
const paths = jiveHomePaths(scratch);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
const encoder = new TextEncoder();
const keyBlob = new Uint8Array([...sshString(encoder.encode("ssh-ed25519")), ...sshString(rawPublicKey)]);
const publicKeyLine = `ssh-ed25519 ${Buffer.from(keyBlob).toString("base64")} tester@jive.sh`;

/** What the fake server saw, so tests can say which session signed and how sign-in went. */
const server = {
  liveTokens: new Set<string>(),
  signedWith: [] as Array<string>,
  claimsBeforeApproval: 0,
  promptsShown: 0,
  pipelineIdTokens: [] as Array<string>,
  previousSessionTokens: [] as Array<string | undefined>,
  idTokenAudiences: [] as Array<string>,
};

const request: OpenedSignInRequest = {
  requestId: "request-1",
  claimSecret: "claim-secret",
  loginUrl: "https://jive.sh/login?request=request-1",
  approvalDevices: 0,
  expiresAt: Date.now() + 60_000,
};

let claims = 0;
const fakeServer = JiveServerImpl.mockLayer({
  *openSignInRequest({ previousSession }: { previousSession: e.Option.Option<Session> }) {
    server.previousSessionTokens.push(e.Option.getOrUndefined(e.Option.map(previousSession, (session) => session.sessionToken)));
    return request;
  },
  *claimSignInRequest() {
    claims += 1;
    if (claims <= server.claimsBeforeApproval) return SignInClaim.Pending();
    const sessionToken = `jive_session_${claims}`;
    server.liveTokens.add(sessionToken);
    return SignInClaim.Approved({ session: { sessionToken, expiresAt: Date.now() + 3_600_000 } });
  },
  *accountOf(session: Session) {
    return server.liveTokens.has(session.sessionToken) ? e.Option.some({ username: "tester", sessionExpiresAt: Date.now() + 86_400_000 }) : e.Option.none();
  },
  *signInPipeline(idToken: string) {
    server.pipelineIdTokens.push(idToken);
    server.liveTokens.add("jive_pipeline_session");
    return { sessionToken: "jive_pipeline_session", expiresAt: Date.now() + 3_600_000 };
  },
  *sshPublicKey() { return publicKeyLine; },
  *signWithSshKey(session: Session, data: Uint8Array) {
    if (!server.liveTokens.has(session.sessionToken)) {
      return yield* new JiveServerError({ call: "ssh:sign", reason: "The session token opens no live session." });
    }
    server.signedWith.push(session.sessionToken);
    const signature = sign(null, data, privateKey);
    return new Uint8Array([...sshString(encoder.encode("ssh-ed25519")), ...sshString(signature)]);
  },
});

const fakeJobIdentity = GitHubActionsIdentityImpl.mockLayer({
  *idToken(audience: string) {
    server.idTokenAudiences.push(audience);
    return "github-id-token";
  },
});

const fakePrompt = TerminalSignInPromptImpl.mockLayer({ *show() { server.promptsShown += 1; } });

const agentLayer = e.pipe(
  SigningAgentImpl.Layer,
  e.Layer.provideMerge(AccountKeyImpl.Layer),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(fakePrompt),
  e.Layer.provideMerge(fakeJobIdentity),
  e.Layer.provideMerge(fakeServer),
  // Bun reads HOME once at startup, so the scratch home reaches the modules through the platform they ask.
  e.Layer.provideMerge(OSPlatformImpl.mockLayer({ *getHomeDirectory() { return scratch; } })),
  e.Layer.provideMerge(BunServices.layer),
);

let closeAgent: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(path.dirname(paths.accountPublicKeyFile), { recursive: true });
  writeFileSync(paths.accountPublicKeyFile, `${publicKeyLine}\n`);
  const scope = await e.Effect.runPromise(e.Scope.make());
  await e.Effect.runPromise(e.pipe(serveSigningAgent(paths.agentSocket), e.Scope.provide(scope), e.Effect.provide(agentLayer)));
  closeAgent = () => e.Effect.runPromise(e.Scope.close(scope, e.Exit.void));
});

afterAll(async () => {
  await closeAgent();
  rmSync(scratch, { recursive: true, force: true });
});

async function run(command: ReadonlyArray<string>, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Async: the agent answering ssh-keygen runs on this process's event loop.
  const child = Bun.spawn([...command], {
    cwd: scratch,
    env: { ...process.env, SSH_AUTH_SOCK: paths.agentSocket },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

/** Signs a file the way git signs a commit (`gpg.ssh.program -Y sign -n git -f <user.signingKey>`), then verifies it. */
async function signAndVerify(): Promise<void> {
  const message = path.join(scratch, "commit.txt");
  writeFileSync(message, `tree ${Math.random()}\n`);
  rmSync(`${message}.sig`, { force: true });
  const signed = await run(["ssh-keygen", "-Y", "sign", "-n", "git", "-f", paths.accountPublicKeyFile, message]);
  expect(signed.stderr).not.toContain("agent refused");
  expect(signed.exitCode).toBe(0);
  const allowedSigners = path.join(scratch, "allowed_signers");
  writeFileSync(allowedSigners, `tester@jive.sh ${publicKeyLine}\n`);
  const verified = await run(
    ["ssh-keygen", "-Y", "verify", "-f", allowedSigners, "-I", "tester@jive.sh", "-n", "git", "-s", `${message}.sig`],
    readFileSync(message, "utf8"),
  );
  expect(verified.stdout).toContain('Good "git" signature for tester@jive.sh');
}

test("the socket is the owner's only", () => {
  expect(existsSync(paths.agentSocket)).toBe(true);
  expect(statSync(paths.agentSocket).mode & 0o777).toBe(0o600);
});

test("lists the account's public key and nothing else", async () => {
  const listed = await run(["ssh-add", "-L"]);
  expect(listed.stdout.trim()).toBe(publicKeyLine);
});

test("with no session, a commit signature signs in once, waiting for approval, then verifies", async () => {
  server.claimsBeforeApproval = 2;
  await signAndVerify();
  expect(server.promptsShown).toBe(1);
  expect(server.signedWith).toEqual(["jive_session_3"]);
  expect(JSON.parse(readFileSync(paths.sessionFile, "utf8")).sessionToken).toBe("jive_session_3");
  expect(statSync(paths.sessionFile).mode & 0o777).toBe(0o600);
});

test("a stored session signs without asking the person again", async () => {
  await signAndVerify();
  expect(server.promptsShown).toBe(1);
  expect(server.signedWith).toEqual(["jive_session_3", "jive_session_3"]);
});

test("a session the server has ended (unused for a day, or revoked) is dropped and signed in again once", async () => {
  server.liveTokens.clear();
  await signAndVerify();
  expect(server.promptsShown).toBe(2);
  expect(server.signedWith.at(-1)).toBe("jive_session_4");
});

// The Jive key beyond git and GitHub, as the README's "Using your Jive key for other SSH" shows it: jive writes nothing
// to ~/.ssh, so the person points ssh or ssh-keygen at the agent's socket and the public key themselves.

test("signs anything else with ssh-keygen -Y sign, under a namespace other than git", async () => {
  const document = path.join(scratch, "release.tar");
  writeFileSync(document, "any bytes\n");
  const signed = await run(["ssh-keygen", "-Y", "sign", "-n", "file", "-f", paths.accountPublicKeyFile, document]);
  expect(signed.exitCode).toBe(0);
  const allowedSigners = path.join(scratch, "allowed_signers_file");
  writeFileSync(allowedSigners, `tester@jive.sh ${publicKeyLine}\n`);
  const verified = await run(
    ["ssh-keygen", "-Y", "verify", "-f", allowedSigners, "-I", "tester@jive.sh", "-n", "file", "-s", `${document}.sig`],
    readFileSync(document, "utf8"),
  );
  expect(verified.stdout).toContain('Good "file" signature for tester@jive.sh');
});

test("logs in to an SSH server that is not GitHub, with the key in its authorized_keys", async () => {
  // An sshd on this machine, running as the person running the test, accepting only the account key.
  const sshdDir = path.join(scratch, "sshd");
  mkdirSync(sshdDir);
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  const hostKey = path.join(sshdDir, "host_key");
  expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]).exitCode).toBe(0);
  writeFileSync(path.join(sshdDir, "authorized_keys"), `${publicKeyLine}\n`);
  writeFileSync(path.join(sshdDir, "sshd_config"), [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`,
    `AuthorizedKeysFile ${path.join(sshdDir, "authorized_keys")}`, `PidFile ${path.join(sshdDir, "sshd.pid")}`,
    "StrictModes no", "UsePAM no", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PermitUserRC no", "",
  ].join("\n"));
  const sshdLog = path.join(sshdDir, "sshd.log");
  expect(Bun.spawnSync(["/usr/sbin/sshd", "-f", path.join(sshdDir, "sshd_config"), "-E", sshdLog]).exitCode).toBe(0);
  for (let attempt = 0; attempt < 50 && !existsSync(path.join(sshdDir, "sshd.pid")); attempt += 1) await Bun.sleep(100);
  const sshdPid = Number.parseInt(readFileSync(path.join(sshdDir, "sshd.pid"), "utf8"), 10);
  try {
    // The README's command, with absolute paths for the scratch home, and no ~/.ssh read on either side.
    const loggedIn = await run([
      "ssh", "-F", "/dev/null",
      "-o", `IdentityAgent=${paths.agentSocket}`, "-o", `IdentityFile=${paths.accountPublicKeyFile}`, "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-p", String(port), `${userInfo().username}@127.0.0.1`, "echo signed-in-through-jive",
    ]);
    expect(loggedIn.stderr).not.toContain("Permission denied");
    expect(loggedIn.stdout.trim()).toBe("signed-in-through-jive");
    expect(readFileSync(sshdLog, "utf8")).toContain("Accepted publickey");
    expect(server.signedWith.at(-1)).toBe("jive_session_4");
  } finally {
    process.kill(sshdPid, "SIGTERM");
  }
}, 30_000);

test("refuses to sign for a key it does not hold", async () => {
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
  const otherBlob = new Uint8Array([...sshString(encoder.encode("ssh-ed25519")), ...sshString(Buffer.from(other, "base64url"))]);
  const otherPublicKeyFile = path.join(scratch, "other.pub");
  writeFileSync(otherPublicKeyFile, `ssh-ed25519 ${Buffer.from(otherBlob).toString("base64")} other\n`);
  const message = path.join(scratch, "other.txt");
  writeFileSync(message, "other\n");
  const signed = await run(["ssh-keygen", "-Y", "sign", "-n", "git", "-f", otherPublicKeyFile, message]);
  expect(signed.exitCode).not.toBe(0);
});

test("a CI/CD job signs in by exchanging its ID token for Jive's audience, and the pipeline session is stored", async () => {
  const session = await e.Effect.runPromise(e.pipe(
    e.Effect.gen(function* () { return yield* (yield* modules.session).signInAsPipeline(); }),
    e.Effect.provide(agentLayer),
  ));
  expect(server.idTokenAudiences).toEqual(["https://api.jive.sh"]);
  expect(server.pipelineIdTokens).toEqual(["github-id-token"]);
  expect(session.sessionToken).toBe("jive_pipeline_session");
  expect(JSON.parse(readFileSync(paths.sessionFile, "utf8")).sessionToken).toBe("jive_pipeline_session");
  expect(server.promptsShown).toBe(2);
});

// Each use extends a session on the server, so a saved end in the past proves nothing: only the server's refusal ends it.

test("a stored session past its saved end still signs, without asking the person, while the server honours it", async () => {
  server.liveTokens.add("jive_session_used_daily");
  writeFileSync(paths.sessionFile, `${JSON.stringify({ sessionToken: "jive_session_used_daily", expiresAt: Date.now() - 1000 })}\n`);
  const prompts = server.promptsShown;
  await signAndVerify();
  expect(server.promptsShown).toBe(prompts);
  expect(server.signedWith.at(-1)).toBe("jive_session_used_daily");
});

test("a sign-in after the server ended the stored session names that session, so the server can ask the account's phones", async () => {
  writeFileSync(paths.sessionFile, `${JSON.stringify({ sessionToken: "jive_ended_session", expiresAt: Date.now() - 1000 })}\n`);
  server.previousSessionTokens.length = 0;
  const prompts = server.promptsShown;
  await signAndVerify();
  expect(server.promptsShown).toBe(prompts + 1);
  expect(server.previousSessionTokens).toEqual(["jive_ended_session"]);
  expect(JSON.parse(readFileSync(paths.sessionFile, "utf8")).sessionToken).toBe(server.signedWith.at(-1));
});
