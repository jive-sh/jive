import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import { JIVE_API_AUDIENCE, SignInClaim, type JiveServerError, type OpenedSignInRequest, type Session } from "@/modules/jive-server/interface";
import { SignInFailed, type ISession } from "./interface";

const CLAIM_INTERVAL = e.Duration.seconds(2);

/**
 * The session file. A session the server refused stays, marked `endedByServer`, so the next sign-in can name it to the
 * server, which then asks that account's phones.
 */
const StoredSession = e.Schema.Struct({
  sessionToken: e.Schema.NonEmptyString,
  expiresAt: e.Schema.Number,
  endedByServer: e.Schema.optionalKey(e.Schema.Literal(true)),
});
const decodeStoredSession = e.Schema.decodeUnknownOption(e.Schema.fromJsonString(StoredSession));

export class SessionImpl extends implementing(modules.session).uses(
  modules.jiveServer,
  modules.signInPrompt,
  modules.pipelineIdentity,
  OSPlatform,
  e.FileSystem.FileSystem,
) implements ISession {
  private readonly signingIn = e.Semaphore.makeUnsafe(1);

  *current(): EffectGen<e.Option.Option<Session>> {
    return e.Option.filter(yield* this.stored(), (stored) => stored.endedByServer !== true);
  }

  *signIn(): EffectGen<Session, SignInFailed> {
    const { jiveServer, signInPrompt } = this.dependencies;
    const self = this;
    const request = yield* e.pipe(
      // The last session, even one the server has ended, tells it whose phones to ask.
      e.Effect.gen(function* () { return yield* jiveServer.openSignInRequest({ previousSession: yield* self.stored() }); }),
      e.Effect.mapError(({ reason }) => new SignInFailed({ reason: `could not open a sign-in request: ${reason}` })),
    );
    yield* signInPrompt.show(request);
    const session = yield* this.claimWhenApproved(request);
    yield* this.store(session);
    return session;
  }

  *signInAsPipeline(): EffectGen<Session, SignInFailed> {
    const { jiveServer, pipelineIdentity } = this.dependencies;
    const idToken = yield* e.pipe(
      e.Effect.gen(() => pipelineIdentity.idToken(JIVE_API_AUDIENCE)),
      e.Effect.mapError((reason) => new SignInFailed({ reason })),
    );
    const session = yield* e.pipe(
      e.Effect.gen(() => jiveServer.signInPipeline(idToken)),
      e.Effect.mapError(({ reason }) => new SignInFailed({ reason })),
    );
    yield* this.store(session);
    return session;
  }

  *ensureSignedIn(): EffectGen<Session, SignInFailed> {
    const self = this;
    return yield* e.Semaphore.withPermits(this.signingIn, 1)(e.Effect.gen(function* () {
      // Read inside the permit: a caller that waited behind a sign-in finds the session it stored.
      const maybeSession = yield* self.current();
      return e.Option.isSome(maybeSession) ? maybeSession.value : yield* self.signIn();
    }));
  }

  *checkWithServer(session: Session): EffectGen<e.Option.Option<{ readonly username: string; readonly session: Session }>, JiveServerError> {
    const maybeAccount = yield* this.dependencies.jiveServer.accountOf(session);
    // Another process may have signed in since `session` was read; its session is left alone.
    const isStored = e.Option.exists(yield* this.stored(), (stored) => stored.sessionToken === session.sessionToken);
    const renewed = { sessionToken: session.sessionToken, expiresAt: e.Option.isSome(maybeAccount) ? maybeAccount.value.sessionExpiresAt : session.expiresAt };
    if (isStored) {
      // A file left as it was costs only a stale end, or one more refused call before the next sign-in.
      yield* e.pipe(
        e.Effect.gen(() => this.store(e.Option.isSome(maybeAccount) ? renewed : { ...renewed, endedByServer: true })),
        e.Effect.catchTag("SignInFailed", ({ reason }) => e.Effect.logWarning(reason)),
      );
    }
    return e.Option.map(maybeAccount, ({ username }) => ({ username, session: renewed }));
  }

  *forget(): EffectGen<void> {
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const { sessionFile } = yield* this.paths();
    yield* e.Effect.ignore(fs.remove(sessionFile, { force: true }));
  }

  /** The session file's session, the server's ended one included. */
  private *stored(): EffectGen<e.Option.Option<typeof StoredSession.Type>> {
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const { sessionFile } = yield* this.paths();
    return e.Option.flatMap(yield* e.Effect.option(fs.readFileString(sessionFile)), decodeStoredSession);
  }

  private *claimWhenApproved(request: OpenedSignInRequest): EffectGen<Session, SignInFailed> {
    const { jiveServer } = this.dependencies;
    while (Date.now() < request.expiresAt) {
      const claim = yield* e.pipe(
        e.Effect.gen(() => jiveServer.claimSignInRequest(request)),
        e.Effect.mapError(({ reason }) => new SignInFailed({ reason: `could not claim the sign-in: ${reason}` })),
      );
      if (SignInClaim.$is("Approved")(claim)) return claim.session;
      if (SignInClaim.$is("Gone")(claim)) {
        return yield* new SignInFailed({ reason: "the sign-in request expired or was already used; sign in again" });
      }
      yield* e.Effect.sleep(CLAIM_INTERVAL);
    }
    return yield* new SignInFailed({ reason: "nobody approved the sign-in before it expired; sign in again" });
  }

  /** Written beside the target and renamed over it, so the file is never half-written or readable by others. */
  private *store(session: typeof StoredSession.Type): EffectGen<void, SignInFailed> {
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const { sessionFile } = yield* this.paths();
    const staging = `${sessionFile}.${process.pid}.tmp`;
    yield* e.pipe(
      e.Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(staging, `${JSON.stringify(session)}\n`, { mode: 0o600 });
        yield* fs.chmod(staging, 0o600);
        yield* fs.rename(staging, sessionFile);
      }),
      e.Effect.mapError((error) => new SignInFailed({ reason: `could not save the session to ${sessionFile}: ${error.message}` })),
    );
  }

  private *paths() {
    return jiveHomePaths(yield* this.dependencies.OSPlatform.getHomeDirectory());
  }
}
