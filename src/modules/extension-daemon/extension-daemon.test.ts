import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatformImpl } from "jive-abstract-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import { JiveServerRefused, JiveServerUnreachable, SignInClaim, type OpenedSignInRequest, type Session, type SignInCaller } from "@/modules/jive-server/interface";
import { FileMachineIdentityImpl } from "@/modules/machine-identity/impl";
import type { MachineDescription } from "@/modules/machine-identity/interface";
import { MachineSignInImpl } from "@/modules/machine-sign-in/impl";
import { bytesToBase64, bytesToBase64Url, readBase64 } from "@/modules/security-key/bytes";
import { buildCeremony } from "@/modules/security-key/webauthn";
import { NpmCredentialPosterNotDecidedImpl } from "@/modules/npm-credential-poster/not-decided";
import { GitHubActionsIdentityImpl } from "@/modules/pipeline-identity/impl";
import { SessionImpl } from "@/modules/session/impl";
import { InsideDaemonSignInRouteImpl } from "@/modules/session/sign-in-route";
import { ExtensionDaemonImpl } from "./impl";
import { extensionIdOf } from "./native-messaging/extension-id";
import { encodeFrame, FrameReader } from "./native-messaging/framing";
import { EXTENSION_PUBLIC_KEY, NATIVE_HOST_NAME, PROTOCOL_VERSION, type DaemonRequest, type NpmCredential } from "./protocol";
import { runExtensionDaemon } from "./run";

/**
 * The extension daemon and the native host the way Chrome uses them: the daemon runs here, with a fake server in place
 * of `@jive-sh/server` and a recording npm credential poster, and registers the native host in a test manifest
 * directory; each test starts the native host from that manifest as its own process and speaks Chrome's framing to it.
 * HOME is a scratch directory (short, since a unix socket path must stay under 104 bytes), so the session file and
 * the socket are the test's own, and nothing touches a real browser profile or the server.
 */

const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "jxd-")));
const paths = jiveHomePaths(scratch);
const manifestDir = path.join(scratch, "chrome", "NativeMessagingHosts");
const ORIGIN = `chrome-extension://${extensionIdOf(EXTENSION_PUBLIC_KEY)}/`;

/** What the fake server and poster saw, and what the test lets them do. */
const server = {
  opened: [] as Array<OpenedSignInRequest>,
  /** What each opened request named: the machine and the programs, and the signature over the open message. */
  openedFor: [] as Array<{ readonly machine: MachineDescription; readonly callers: ReadonlyArray<SignInCaller>; readonly signedAt: number; readonly signature: string }>,
  /** Programs that joined a request already waiting, by request. */
  joined: [] as Array<{ readonly requestId: string; readonly caller: SignInCaller }>,
  /** The machine signature each claim carried. */
  claimSignatures: [] as Array<{ readonly requestId: string; readonly signature: string }>,
  approved: new Set<string>(),
  issuedTokens: [] as Array<string>,
  refuseToOpen: false,
  /** How long opening a request takes, so two sign-ins can overlap. */
  openDelayMs: 0,
  posted: [] as Array<{ readonly sessionToken: string; readonly credential: NpmCredential }>,
  /** Sessions the server honours besides the ones it issued here, such as one `jive login` stored. */
  honoured: new Set<string>(),
  /** When the server says every live session now ends: each use has moved it past what the session file holds. */
  sessionEndsAt: Date.now() + 24 * 3_600_000,
  /** Bytes `signWithSigningPasskey` was asked to sign, in order. */
  signed: [] as Array<Uint8Array>,
  /** Whether the server answers at all, or the network fails as it does offline. */
  reachable: true,
};

const CREDENTIAL_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
let signingKey: CryptoKey | undefined;
let verifyingKey: CryptoKey | undefined;
let signingSpki = "";

const fakeServer = JiveServerImpl.mockLayer({
  *openMachineSignInRequest(input: { readonly machine: MachineDescription; readonly callers: ReadonlyArray<SignInCaller>; readonly signedAt: number; readonly signature: string }) {
    if (server.refuseToOpen) return yield* new JiveServerRefused({ call: "POST /sign-in-requests", reason: "the test's server refused" });
    server.openedFor.push({ machine: input.machine, callers: input.callers, signedAt: input.signedAt, signature: input.signature });
    yield* e.Effect.sleep(server.openDelayMs);
    const requestId = `request-${server.opened.length + 1}`;
    const request: OpenedSignInRequest = {
      requestId,
      claimSecret: `claim-secret-${requestId}`,
      loginUrl: `https://jive.sh/login?request=${requestId}`,
      approvalDevices: 0,
      expiresAt: Date.now() + 10 * 60_000,
    };
    server.opened.push(request);
    return request;
  },
  *addSignInCaller({ request, caller }: { readonly request: OpenedSignInRequest; readonly caller: SignInCaller }) {
    server.joined.push({ requestId: request.requestId, caller });
    return true;
  },
  *claimSignInRequest({ request, signature }: { readonly request: OpenedSignInRequest; readonly signature: string }) {
    server.claimSignatures.push({ requestId: request.requestId, signature });
    if (!server.approved.has(request.requestId)) return SignInClaim.Pending();
    server.approved.delete(request.requestId);
    const sessionToken = `jive_session_${request.requestId}`;
    server.issuedTokens.push(sessionToken);
    return SignInClaim.Approved({ session: { sessionToken, expiresAt: Date.now() + 12 * 3_600_000 } });
  },
  *accountOf(session: Session) {
    if (!server.reachable) return yield* new JiveServerUnreachable({ call: "accounts:me", url: "https://api.jive.example", transportFailure: "TransportError" });
    const live = server.issuedTokens.includes(session.sessionToken) || server.honoured.has(session.sessionToken);
    return live ? e.Option.some({ username: "tester", sessionExpiresAt: server.sessionEndsAt }) : e.Option.none();
  },
  *ensureSigningPasskey() {
    return { credentialId: bytesToBase64Url(CREDENTIAL_ID), publicKeySpki: signingSpki };
  },
  *signWithSigningPasskey(input: { readonly challenge: Uint8Array }) {
    const key = signingKey;
    if (key === undefined) return yield* new JiveServerRefused({ call: "signingPasskey:sign", reason: "the test key was not generated" });
    const challenge = Uint8Array.from(input.challenge);
    server.signed.push(challenge);
    const signature = yield* e.Effect.tryPromise({
      try: () => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, challenge),
      catch: () => new JiveServerRefused({ call: "signingPasskey:sign", reason: "the test key could not sign" }),
    });
    return new Uint8Array(signature);
  },
});

const recordingPoster = NpmCredentialPosterNotDecidedImpl.mockLayer({
  *unavailableBecause() { return e.Option.none(); },
  *postNpmCredential({ session, credential }: { session: Session; credential: NpmCredential }) {
    server.posted.push({ sessionToken: session.sessionToken, credential });
  },
});

const daemonLayer = (poster: typeof recordingPoster | typeof NpmCredentialPosterNotDecidedImpl.Layer) => e.pipe(
  ExtensionDaemonImpl.Layer,
  e.Layer.provideMerge(poster),
  e.Layer.provideMerge(MachineSignInImpl.Layer),
  e.Layer.provideMerge(FileMachineIdentityImpl.Layer),
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(InsideDaemonSignInRouteImpl.Layer),
  e.Layer.provideMerge(GitHubActionsIdentityImpl.mockLayer({})),
  e.Layer.provideMerge(fakeServer),
  // Bun reads HOME once at startup, so the scratch home reaches the modules through the platform they ask.
  e.Layer.provideMerge(OSPlatformImpl.mockLayer({ *getHomeDirectory() { return scratch; } })),
  e.Layer.provideMerge(BunServices.layer),
);

/** Starts the daemon in this process; the returned function stops it, as a restart or a stopped daemon would. */
async function startDaemon(): Promise<() => Promise<void>> {
  const scope = await e.Effect.runPromise(e.Scope.make());
  await e.Effect.runPromise(e.pipe(
    runExtensionDaemon({ paths, manifestDirs: [manifestDir] }),
    e.Scope.provide(scope),
    e.Effect.provide(daemonLayer(recordingPoster)),
  ));
  return () => e.Effect.runPromise(e.Scope.close(scope, e.Exit.void));
}

interface NativeHost {
  request(request: DaemonRequest, protocolVersion?: number): Promise<any>;
  /** Messages that arrived without a matching request, such as `DaemonUnreachable`. */
  readonly unsolicited: ReadonlyArray<any>;
  readonly exited: Promise<number>;
  close(): void;
}

/** Starts the native host exactly as Chrome does: its manifest's executable, the extension's origin as the argument, framed JSON on stdio. */
function startNativeHost(): NativeHost {
  const manifest = JSON.parse(readFileSync(path.join(manifestDir, `${NATIVE_HOST_NAME}.json`), "utf8"));
  const child = Bun.spawn([manifest.path, ORIGIN], { env: { ...process.env, HOME: scratch }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const waiting = new Map<string, (response: any) => void>();
  const unsolicited: Array<any> = [];
  const frames = new FrameReader();
  void (async () => {
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      for (const json of frames.push(chunk)) {
        const message = JSON.parse(json);
        const resolve = message.requestId === undefined ? undefined : waiting.get(message.requestId);
        if (resolve === undefined) unsolicited.push(message);
        else {
          waiting.delete(message.requestId);
          resolve(message.response);
        }
      }
    }
  })();
  let next = 0;
  return {
    request: (request, protocolVersion = PROTOCOL_VERSION) => new Promise((resolve) => {
      next += 1;
      const requestId = `r${next}`;
      waiting.set(requestId, resolve);
      child.stdin.write(encodeFrame(JSON.stringify({ protocolVersion, requestId, request })));
      child.stdin.flush();
    }),
    unsolicited,
    exited: child.exited,
    close: () => { child.stdin.end(); },
  };
}

async function waitFor<A>(input: { readonly probe: () => Promise<A | undefined>; readonly what: string }): Promise<A> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const value = await input.probe();
    if (value !== undefined) return value;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for ${input.what}`);
}

/** A program that signs in through the daemon's socket the way `jive login` does. */
const SIGN_IN_FIXTURE = path.join(import.meta.dir, "sign-in-through-daemon.fixture.ts");

/** The caller a request answered in this process names: there is no socket peer to read. */
const TEST_CALLER: SignInCaller = { programs: ["extension-daemon.test"] };

const storedSessionToken = () => JSON.parse(readFileSync(paths.sessionFile, "utf8")).sessionToken as string;

let stopDaemon: () => Promise<void>;
let host: NativeHost;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  signingKey = pair.privateKey;
  verifyingKey = pair.publicKey;
  signingSpki = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  mkdirSync(path.dirname(manifestDir), { recursive: true });
  stopDaemon = await startDaemon();
  host = startNativeHost();
});

afterAll(async () => {
  host.close();
  await stopDaemon();
  rmSync(scratch, { recursive: true, force: true });
});

describe("registration with Chrome", () => {
  test("writes a host manifest that lets only the Jive extension start the native host", () => {
    const manifest = JSON.parse(readFileSync(path.join(manifestDir, `${NATIVE_HOST_NAME}.json`), "utf8"));
    expect(manifest).toMatchObject({ name: NATIVE_HOST_NAME, type: "stdio", allowed_origins: [ORIGIN] });
    expect(statSync(manifest.path).mode & 0o111).not.toBe(0);
  });

  test("keeps the socket owner-only", () => {
    expect(statSync(paths.daemonSocket).mode & 0o777).toBe(0o600);
  });
});

describe("signing in", () => {
  test("starts signed out", async () => {
    expect(await host.request({ _tag: "GetSession" })).toEqual({ _tag: "SignedOut" });
  });

  test("a sign-in request the server won't open is answered with why", async () => {
    server.refuseToOpen = true;
    const response = await host.request({ _tag: "StartSignIn" });
    server.refuseToOpen = false;
    expect(response).toMatchObject({ _tag: "SignInFailed", reason: expect.stringContaining("the test's server refused") });
    expect(await host.request({ _tag: "GetSession" })).toEqual({ _tag: "SignedOut" });
  });

  test("opens a sign-in request signed with this machine's key, naming the program that asked, and answers with its page, never its secret", async () => {
    const response = await host.request({ _tag: "StartSignIn" });
    const opened = server.opened.at(-1)!;
    expect(response).toEqual({ _tag: "SigningIn", loginUrl: opened.loginUrl, expiresAt: new Date(opened.expiresAt).toISOString(), approvalDevices: 0 });
    const openedFor = server.openedFor.at(-1)!;
    // The native host relays the extension, so it is the program on the socket's other end.
    expect(openedFor.callers).toHaveLength(1);
    expect(openedFor.callers[0]!.programs.at(-1)).toContain("jive-native-host");
    expect(openedFor.machine.keyStorage).toBe("file");
    const stored = JSON.parse(readFileSync(paths.machineKeyFile, "utf8"));
    expect(stored.publicKey).toBe(openedFor.machine.publicKey);
    expect(statSync(paths.machineKeyFile).mode & 0o777).toBe(0o600);
    const publicKey = await crypto.subtle.importKey("raw", Buffer.from(openedFor.machine.publicKey, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const verifies = (signature: string, message: string) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(message));
    expect(await verifies(openedFor.signature, `jive-sign-in-open\n${openedFor.machine.publicKey}\n${openedFor.signedAt}`)).toBe(true);
    const claim = await waitFor({ probe: async () => server.claimSignatures.find(({ requestId }) => requestId === opened.requestId), what: "the daemon's first claim" });
    expect(await verifies(claim.signature, `jive-sign-in-claim\n${opened.requestId}`)).toBe(true);
    expect(JSON.stringify(response).includes(opened.claimSecret)).toBe(false);
    expect(await host.request({ _tag: "GetSession" })).toMatchObject({ _tag: "SigningIn", loginUrl: opened.loginUrl });
  });

  test("a sign-in started while one waits joins it: the same page, no second request, and the program is added to it", async () => {
    const other = startNativeHost();
    const openedBefore = server.opened.length;
    const [first, second] = await Promise.all([host.request({ _tag: "StartSignIn" }), other.request({ _tag: "StartSignIn" })]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ _tag: "SigningIn", loginUrl: server.opened.at(-1)!.loginUrl });
    expect(server.opened.length).toBe(openedBefore);
    expect(server.joined.filter(({ requestId }) => requestId === server.opened.at(-1)!.requestId)).toHaveLength(2);
    expect(await other.request({ _tag: "GetSession" })).toEqual(await host.request({ _tag: "GetSession" }));
    other.close();
  });

  test("stores the session in jive's own session file once the person approves, owner-only", { timeout: 30_000 }, async () => {
    server.approved.add(server.opened.at(-1)!.requestId);
    const signedIn = await waitFor({
      probe: async () => {
        const response = await host.request({ _tag: "GetSession" });
        return response._tag === "SignedIn" ? response : undefined;
      },
      what: "the daemon to claim the session",
    });
    expect(JSON.stringify(signedIn).includes(server.issuedTokens[0]!)).toBe(false);
    expect(storedSessionToken()).toBe(server.issuedTokens[0]!);
    expect(statSync(paths.sessionFile).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(paths.jiveHome, "daemon-session.json"))).toBe(false);
  });

  test("is still signed in after the daemon restarts", { timeout: 30_000 }, async () => {
    host.close();
    await stopDaemon();
    stopDaemon = await startDaemon();
    host = startNativeHost();
    expect(await host.request({ _tag: "GetSession" })).toMatchObject({ _tag: "SignedIn" });
  });

  test("a session the server has ended reads as signed out, before its saved end", async () => {
    writeFileSync(paths.sessionFile, `${JSON.stringify({ sessionToken: "jive_session_ended", expiresAt: Date.now() + 3_600_000 })}\n`, { mode: 0o600 });
    expect(await host.request({ _tag: "GetSession" })).toEqual({ _tag: "SignedOut" });
    expect(JSON.parse(readFileSync(paths.sessionFile, "utf8"))).toMatchObject({ sessionToken: "jive_session_ended", endedByServer: true });
  });

  test("a session `jive login` stored is the one the extension sees, past its saved end, with the end the server gives", async () => {
    server.honoured.add("jive_session_from_jive_login");
    writeFileSync(paths.sessionFile, `${JSON.stringify({ sessionToken: "jive_session_from_jive_login", expiresAt: Date.now() - 1000 })}\n`, { mode: 0o600 });
    expect(await host.request({ _tag: "GetSession" })).toEqual({
      _tag: "SignedIn", username: "tester", expiresAt: new Date(server.sessionEndsAt).toISOString(), confirmedByServer: true,
    });
    expect(JSON.parse(readFileSync(paths.sessionFile, "utf8"))).toMatchObject({ expiresAt: server.sessionEndsAt, username: "tester" });
  });

  test("with the server unreachable, the stored session is signed in but unconfirmed, with the saved username and the server's address", async () => {
    const stored = JSON.parse(readFileSync(paths.sessionFile, "utf8"));
    server.reachable = false;
    try {
      expect(await host.request({ _tag: "GetSession" })).toEqual({
        _tag: "SignedIn",
        username: "tester",
        expiresAt: new Date(stored.expiresAt).toISOString(),
        confirmedByServer: false,
        unreachableServerUrl: "https://api.jive.example",
      });
      expect(JSON.parse(readFileSync(paths.sessionFile, "utf8"))).toEqual(stored);
    } finally {
      server.reachable = true;
    }
  });
});

describe("two programs signing in at once", () => {
  test("each its own process: one request names both, and both get the session once it is approved", { timeout: 60_000 }, async () => {
    await host.request({ _tag: "SignOut" });
    const openedBefore = server.opened.length;
    const joinedBefore = server.joined.length;
    const start = () => Bun.spawn(["bun", SIGN_IN_FIXTURE], { env: { ...process.env, HOME: scratch }, stdout: "pipe", stderr: "pipe" });
    const programs = [start(), start()];
    const request = await waitFor({
      probe: async () => server.opened.length === openedBefore + 1 && server.joined.length === joinedBefore + 1 ? server.opened.at(-1) : undefined,
      what: "one request, with the second program joined to it",
    });
    server.approved.add(request.requestId);
    const finished = await Promise.all(programs.map(async (child) => ({
      exitCode: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })));
    expect(finished).toEqual([0, 1].map(() => ({
      exitCode: 0,
      stdout: `page ${request.loginUrl}\nsigned in jive_session_${request.requestId}\n`,
      stderr: "",
    })));
    expect(server.opened.length).toBe(openedBefore + 1);
    const fixtureName = path.basename(SIGN_IN_FIXTURE).replace(/\.ts$/, "");
    expect(server.openedFor.at(-1)!.callers.map(({ programs: names }) => names.at(-1))).toEqual([fixtureName]);
    expect(server.joined.at(-1)).toEqual({ requestId: request.requestId, caller: expect.objectContaining({ programs: expect.arrayContaining([fixtureName]) }) });
    expect(storedSessionToken()).toBe(`jive_session_${request.requestId}`);
  });
});

describe("the npm credential", () => {
  test("is ready to post once signed in", async () => {
    expect(await host.request({ _tag: "GetNpmConnectionReadiness" })).toEqual({ _tag: "Ready" });
  });

  test("is posted with this machine's session, and nothing about it comes back", async () => {
    const credential = { npmUser: "chaine.dance", token: "npm_test-token" };
    expect(await host.request({ _tag: "PostNpmCredential", credential })).toEqual({ _tag: "Posted" });
    expect(server.posted.at(-1)).toEqual({ sessionToken: storedSessionToken(), credential });
  });

  test("is not ready while which Jive service takes it is undecided, the poster jive ships", async () => {
    const answer = await e.Effect.runPromise(e.pipe(
      e.Effect.gen(function* () {
        const daemon = yield* modules.extensionDaemon;
        return yield* daemon.answerLine({ line: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: "r", request: { _tag: "GetNpmConnectionReadiness" } }), caller: TEST_CALLER });
      }),
      e.Effect.provide(daemonLayer(NpmCredentialPosterNotDecidedImpl.Layer)),
    ));
    expect(answer.response).toMatchObject({ _tag: "NotReady", reason: expect.stringContaining("still being decided") });
  });
});

describe("the signing passkey", () => {
  const challenge = Uint8Array.from([9, 8, 7, 6]);
  const rpId = "www.npmjs.com";
  const origin = "https://www.npmjs.com";

  const remember = () => {
    server.honoured.add("jive_session_passkey");
    writeFileSync(paths.sessionFile, `${JSON.stringify({ sessionToken: "jive_session_passkey", expiresAt: Date.now() + 3_600_000 })}\n`, { mode: 0o600 });
  };

  test("refuses when no repository was prepared, and the reason does not contain the challenge", async () => {
    remember();
    const response = await host.request({
      _tag: "AnswerSecurityKey",
      kind: "get",
      challenge: bytesToBase64Url(challenge),
      rpId,
      origin,
      crossOrigin: false,
    });
    expect(response._tag).toBe("SecurityKeyRefused");
    expect(response.reason).toBe("this machine has not been told which repository's signing passkey answers npm");
    expect(String(response.reason).includes(bytesToBase64Url(challenge))).toBe(false);
    expect(server.signed).toEqual([]);
  });

  test("refuses when this machine is signed out", async () => {
    writeFileSync(paths.sessionFile, `${JSON.stringify({ sessionToken: "jive_session_passkey_dead", expiresAt: Date.now() + 3_600_000 })}\n`, { mode: 0o600 });
    expect(await host.request({ _tag: "PrepareSigningPasskey", repositoryOwner: "jive-sh", repositoryName: "example" })).toEqual({ _tag: "SigningPasskeyPrepared" });
    const response = await host.request({
      _tag: "AnswerSecurityKey",
      kind: "get",
      challenge: bytesToBase64Url(challenge),
      rpId,
      origin,
      crossOrigin: false,
    });
    expect(response).toEqual({ _tag: "SecurityKeyRefused", reason: "this machine is not signed in to Jive" });
  });

  test("a get is signed over authenticatorData concatenated with sha256(clientDataJSON)", async () => {
    remember();
    expect(await host.request({ _tag: "PrepareSigningPasskey", repositoryOwner: "jive-sh", repositoryName: "example" })).toEqual({ _tag: "SigningPasskeyPrepared" });
    const response = await host.request({
      _tag: "AnswerSecurityKey",
      kind: "get",
      challenge: bytesToBase64Url(challenge),
      rpId,
      origin,
      crossOrigin: false,
    });
    const spki = readBase64(signingSpki);
    if (spki._tag !== "Read") throw new Error("the test key is not base64");
    const built = buildCeremony({ kind: "get", challenge, rpId, origin, crossOrigin: false, credentialId: CREDENTIAL_ID, publicKeySpki: spki.bytes });
    expect(built._tag).toBe("Built");
    if (built._tag !== "Built") return;
    expect(server.signed.at(-1)).toEqual(built.ceremony.signedBytes);
    expect(response._tag).toBe("SecurityKeyAnswer");
    expect(response.attestationObject).toBeUndefined();
    const signature = readBase64(response.signature);
    const key = verifyingKey;
    expect(signature._tag).toBe("Read");
    if (signature._tag !== "Read" || key === undefined) return;
    expect(readBase64(response.authenticatorData)).toEqual({ _tag: "Read", bytes: built.ceremony.authenticatorData });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature.bytes, built.ceremony.signedBytes)).toBe(true);
  });

  test("a create answer's attestation wraps that authenticator data and the signature verifies", async () => {
    const response = await host.request({
      _tag: "AnswerSecurityKey",
      kind: "create",
      challenge: bytesToBase64Url(challenge),
      rpId,
      origin,
      crossOrigin: false,
    });
    const spki = readBase64(signingSpki);
    expect(spki._tag).toBe("Read");
    if (spki._tag !== "Read") return;
    const built = buildCeremony({ kind: "create", challenge, rpId, origin, crossOrigin: false, credentialId: CREDENTIAL_ID, publicKeySpki: spki.bytes });
    expect(built._tag).toBe("Built");
    if (built._tag !== "Built" || built.ceremony._tag !== "create") return;
    expect(server.signed.at(-1)).toEqual(built.ceremony.signedBytes);
    const attestation = readBase64(response.attestationObject);
    expect(attestation).toEqual({ _tag: "Read", bytes: built.ceremony.attestationObject });
    const signature = readBase64(response.signature);
    const key = verifyingKey;
    if (signature._tag !== "Read" || key === undefined) throw new Error("missing signature");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature.bytes, built.ceremony.signedBytes)).toBe(true);
  });

  test("a new daemon answers with the repository the last prepare stored", async () => {
    remember();
    const prepare = await e.Effect.runPromise(e.pipe(
      e.Effect.gen(function* () {
        const daemon = yield* modules.extensionDaemon;
        return yield* daemon.answerLine({ caller: TEST_CALLER, line: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId: "prepare-stored",
          request: { _tag: "PrepareSigningPasskey", repositoryOwner: "jive-sh", repositoryName: "stored-example" },
        }) });
      }),
      e.Effect.provide(daemonLayer(recordingPoster)),
    ));
    expect(prepare.response).toEqual({ _tag: "SigningPasskeyPrepared" });
    expect(JSON.parse(readFileSync(paths.signingPasskeyRepositoryFile, "utf8"))).toEqual({
      repositoryOwner: "jive-sh",
      repositoryName: "stored-example",
    });
    const answer = await e.Effect.runPromise(e.pipe(
      e.Effect.gen(function* () {
        const daemon = yield* modules.extensionDaemon;
        return yield* daemon.answerLine({ caller: TEST_CALLER, line: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId: "answer-stored",
          request: {
            _tag: "AnswerSecurityKey",
            kind: "get",
            challenge: bytesToBase64Url(challenge),
            rpId,
            origin,
            crossOrigin: false,
          },
        }) });
      }),
      e.Effect.provide(daemonLayer(recordingPoster)),
    ));
    expect(answer.response._tag).toBe("SecurityKeyAnswer");
  });
});

describe("refusals", () => {
  test("a request of another protocol version is refused with which side to upgrade", async () => {
    expect(await host.request({ _tag: "GetSession" }, 2)).toMatchObject({ _tag: "Failed", message: expect.stringContaining("upgrade jive") });
  });

  test("signing out forgets jive's session, and then nothing can be posted", async () => {
    expect(await host.request({ _tag: "SignOut" })).toEqual({ _tag: "SignedOut" });
    expect(existsSync(paths.sessionFile)).toBe(false);
    expect(await host.request({ _tag: "GetNpmConnectionReadiness" })).toMatchObject({ _tag: "NotReady" });
    expect(await host.request({ _tag: "PostNpmCredential", credential: { npmUser: "u", token: "t" } }))
      .toMatchObject({ _tag: "Refused" });
  });

  test("a second daemon stands down while the pidfile names a live one, and leaves its socket", { timeout: 30_000 }, async () => {
    // This test process stands in for the live daemon the pidfile names.
    writeFileSync(paths.daemonPidFile, String(process.pid));
    const second = Bun.spawn(["bun", path.join(import.meta.dir, "..", "..", "daemons", "jive-daemon.ts")], {
      env: { ...process.env, HOME: scratch },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stderr).text()).toContain("standing down");
    expect(existsSync(paths.daemonSocket)).toBe(true);
    rmSync(paths.daemonPidFile);
  });

  test("one process serves the agent socket and the extension socket", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "jxd-")));
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "..", "..", "daemons", "jive-daemon.ts")], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const childPaths = jiveHomePaths(home);
    try {
      await waitFor({
        probe: async () => existsSync(childPaths.agentSocket) && existsSync(childPaths.daemonSocket) ? true : undefined,
        what: "jive-daemon to serve both sockets",
      });
      expect(existsSync(childPaths.daemonPidFile)).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the native host tells the extension when the daemon is not running", { timeout: 30_000 }, async () => {
    host.close();
    await stopDaemon();
    stopDaemon = async () => {};
    const orphan = startNativeHost();
    host = orphan;
    expect(await orphan.exited).toBe(0);
    expect(orphan.unsolicited).toEqual([{ _tag: "DaemonUnreachable", message: "jive-daemon is not running" }]);
  });
});
