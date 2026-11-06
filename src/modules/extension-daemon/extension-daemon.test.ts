import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatformImpl } from "jive-abstract-library";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import { ExtensionSignInImpl } from "@/modules/extension-sign-in/impl";
import { JiveServerImpl } from "@/modules/jive-server/impl";
import { JiveServerError, SignInClaim, type OpenedSignInRequest, type Session } from "@/modules/jive-server/interface";
import { NpmCredentialPosterNotDecidedImpl } from "@/modules/npm-credential-poster/not-decided";
import { GitHubActionsIdentityImpl } from "@/modules/pipeline-identity/impl";
import { SessionImpl } from "@/modules/session/impl";
import { ExtensionSignInPromptImpl } from "@/modules/session/sign-in-prompt";
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
};

const fakeServer = JiveServerImpl.mockLayer({
  *openSignInRequest() {
    if (server.refuseToOpen) return yield* new JiveServerError({ call: "signInRequests:open", reason: "the test's server refused" });
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
  *claimSignInRequest(request: OpenedSignInRequest) {
    if (!server.approved.has(request.requestId)) return SignInClaim.Pending();
    server.approved.delete(request.requestId);
    const sessionToken = `jive_session_${request.requestId}`;
    server.issuedTokens.push(sessionToken);
    return SignInClaim.Approved({ session: { sessionToken, expiresAt: Date.now() + 12 * 3_600_000 } });
  },
  *accountOf(session: Session) {
    const live = server.issuedTokens.includes(session.sessionToken) || server.honoured.has(session.sessionToken);
    return live ? e.Option.some({ username: "tester", sessionExpiresAt: server.sessionEndsAt }) : e.Option.none();
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
  e.Layer.provideMerge(SessionImpl.Layer),
  e.Layer.provideMerge(ExtensionSignInPromptImpl.Layer),
  e.Layer.provideMerge(ExtensionSignInImpl.Layer),
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

const storedSessionToken = () => JSON.parse(readFileSync(paths.sessionFile, "utf8")).sessionToken as string;

let stopDaemon: () => Promise<void>;
let host: NativeHost;

beforeAll(async () => {
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
    expect(statSync(paths.extensionDaemonSocket).mode & 0o777).toBe(0o600);
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

  test("opens a sign-in request through jive's session and answers with its page, never its secret", async () => {
    const response = await host.request({ _tag: "StartSignIn" });
    const opened = server.opened.at(-1)!;
    expect(response).toEqual({ _tag: "SigningIn", loginUrl: opened.loginUrl, expiresAt: new Date(opened.expiresAt).toISOString() });
    expect(JSON.stringify(response).includes(opened.claimSecret)).toBe(false);
    expect(await host.request({ _tag: "GetSession" })).toMatchObject({ _tag: "SigningIn", loginUrl: opened.loginUrl });
  });

  test("two sign-ins started at once both answer, the later one waits, and each connection keeps answering", async () => {
    const other = startNativeHost();
    server.openDelayMs = 300;
    const [first, second] = await Promise.all([host.request({ _tag: "StartSignIn" }), other.request({ _tag: "StartSignIn" })]);
    server.openDelayMs = 0;
    expect([first._tag, second._tag]).toEqual(["SigningIn", "SigningIn"]);
    const waiting = await host.request({ _tag: "GetSession" });
    expect(waiting).toMatchObject({ _tag: "SigningIn", loginUrl: server.opened.at(-1)!.loginUrl });
    expect(await other.request({ _tag: "GetSession" })).toEqual(waiting);
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
    expect(await host.request({ _tag: "GetSession" })).toEqual({ _tag: "SignedIn", expiresAt: new Date(server.sessionEndsAt).toISOString() });
    expect(JSON.parse(readFileSync(paths.sessionFile, "utf8")).expiresAt).toBe(server.sessionEndsAt);
  });
});

describe("the npm credential", () => {
  test("is ready to post once signed in", async () => {
    expect(await host.request({ _tag: "GetNpmConnectionReadiness" })).toEqual({ _tag: "Ready" });
  });

  test("is posted with this machine's session, and nothing about it comes back", async () => {
    const credential = { npmUser: "chaine.dance", token: "npm_test-token", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" };
    expect(await host.request({ _tag: "PostNpmCredential", credential })).toEqual({ _tag: "Posted" });
    expect(server.posted.at(-1)).toEqual({ sessionToken: storedSessionToken(), credential });
  });

  test("is not ready while which Jive service takes it is undecided, the poster jive ships", async () => {
    const answer = await e.Effect.runPromise(e.pipe(
      e.Effect.gen(function* () {
        const daemon = yield* modules.extensionDaemon;
        return yield* daemon.answerLine(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId: "r", request: { _tag: "GetNpmConnectionReadiness" } }));
      }),
      e.Effect.provide(daemonLayer(NpmCredentialPosterNotDecidedImpl.Layer)),
    ));
    expect(answer.response).toMatchObject({ _tag: "NotReady", reason: expect.stringContaining("still being decided") });
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
    expect(await host.request({ _tag: "PostNpmCredential", credential: { npmUser: "u", token: "t", totpSecret: "A" } }))
      .toMatchObject({ _tag: "Refused" });
  });

  test("a second daemon stands down while the pidfile names a live one, and leaves its socket", { timeout: 30_000 }, async () => {
    // This test process stands in for the live daemon the pidfile names.
    writeFileSync(paths.extensionDaemonPidFile, String(process.pid));
    const second = Bun.spawn(["bun", path.join(import.meta.dir, "..", "..", "daemons", "jive-extension-daemon.ts")], {
      env: { ...process.env, HOME: scratch },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stderr).text()).toContain("standing down");
    expect(existsSync(paths.extensionDaemonSocket)).toBe(true);
    rmSync(paths.extensionDaemonPidFile);
  });

  test("the native host tells the extension when the daemon is not running", { timeout: 30_000 }, async () => {
    host.close();
    await stopDaemon();
    stopDaemon = async () => {};
    const orphan = startNativeHost();
    host = orphan;
    expect(await orphan.exited).toBe(0);
    expect(orphan.unsolicited).toEqual([{ _tag: "DaemonUnreachable", message: "jive-extension-daemon is not running" }]);
  });
});
