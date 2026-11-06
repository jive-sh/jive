import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import type { OpenedSignInRequest, Session } from "@/modules/jive-server/interface";
import { SignInFailed } from "@/modules/session/interface";
import type { IExtensionDaemon } from "./interface";
import { PROTOCOL_VERSION, RequestEnvelope, type DaemonRequest, type DaemonResponse, type ResponseEnvelope } from "./protocol";

const decodeRequestLine = e.Schema.decodeUnknownOption(e.Schema.fromJsonString(RequestEnvelope));
const isoTime = (epochMs: number): string => new Date(epochMs).toISOString();

export class ExtensionDaemonImpl extends implementing(modules.extensionDaemon).uses(
  modules.session,
  modules.extensionSignIn,
  modules.npmCredentialPoster,
) implements IExtensionDaemon {
  /** The sign-in the extension started, claiming in the background until it ends or another replaces it. */
  private readonly signInFiber = e.Ref.makeUnsafe(e.Option.none<e.Fiber.Fiber<Session, SignInFailed>>());
  /**
   * One start or sign-out at a time: another one replacing that sign-in's fiber mid-start would interrupt the start
   * waiting on it. Several connections can each send one.
   */
  private readonly startingOrSigningOut = e.Semaphore.makeUnsafe(1);

  *answerLine(line: string): EffectGen<ResponseEnvelope> {
    // A decode error would quote the line, which can hold a token or secret, so none is kept.
    const maybeEnvelope = decodeRequestLine(line);
    if (e.Option.isNone(maybeEnvelope)) {
      return { requestId: "", response: { _tag: "Failed", message: "the daemon could not read that request" } };
    }
    const { requestId, protocolVersion, request } = maybeEnvelope.value;
    if (protocolVersion !== PROTOCOL_VERSION) {
      const older = protocolVersion < PROTOCOL_VERSION ? "the extension" : "jive";
      return { requestId, response: { _tag: "Failed", message: `the extension speaks protocol ${protocolVersion} and jive-extension-daemon ${PROTOCOL_VERSION}; upgrade ${older}` } };
    }
    return {
      requestId,
      response: yield* e.pipe(
        e.Effect.gen(() => this.answer(request)),
        // A defect answers this request only; the connection keeps answering the ones after it.
        e.Effect.catchCause((cause) => e.pipe(
          e.Effect.logError(`Could not answer the extension's ${request._tag}: ${e.Cause.pretty(cause)}`),
          e.Effect.as<DaemonResponse>({ _tag: "Failed", message: `jive-extension-daemon could not answer ${request._tag}` }),
        )),
      ),
    };
  }

  private *answer(request: DaemonRequest): EffectGen<DaemonResponse> {
    const { session, extensionSignIn, npmCredentialPoster } = this.dependencies;
    const self = this;
    switch (request._tag) {
      case "GetSession": {
        const maybeSession = yield* session.current();
        if (e.Option.isSome(maybeSession)) {
          // Only the server knows whether the session still holds and when it now ends; offline, the saved end stands.
          const checked = yield* e.Effect.result(e.Effect.gen(() => session.checkWithServer(maybeSession.value)));
          if (e.Result.isFailure(checked)) return { _tag: "SignedIn", expiresAt: isoTime(maybeSession.value.expiresAt) };
          if (e.Option.isSome(checked.success)) return { _tag: "SignedIn", expiresAt: isoTime(checked.success.value.session.expiresAt) };
        }
        return e.Option.match(yield* extensionSignIn.waiting(), {
          onNone: (): DaemonResponse => ({ _tag: "SignedOut" }),
          onSome: (waiting): DaemonResponse => signingIn(waiting),
        });
      }
      case "StartSignIn":
        return yield* e.pipe(
          e.Effect.gen(() => this.startSignIn()),
          e.Semaphore.withPermits(this.startingOrSigningOut, 1),
          e.Effect.map(signingIn),
          e.Effect.catchTag("SignInFailed", ({ reason }) => e.Effect.succeed<DaemonResponse>({ _tag: "SignInFailed", reason })),
        );
      case "SignOut":
        yield* e.Semaphore.withPermits(this.startingOrSigningOut, 1)(e.Effect.gen(function* () {
          yield* self.cancelSignIn();
          yield* session.forget();
        }));
        return { _tag: "SignedOut" };
      case "GetNpmConnectionReadiness": {
        if (e.Option.isNone(yield* session.current())) return { _tag: "NotReady", reason: "this machine is not signed in to Jive" };
        return e.Option.match(yield* npmCredentialPoster.unavailableBecause(), {
          onNone: (): DaemonResponse => ({ _tag: "Ready" }),
          onSome: (reason): DaemonResponse => ({ _tag: "NotReady", reason }),
        });
      }
      case "PostNpmCredential": {
        const maybeSession = yield* session.current();
        if (e.Option.isNone(maybeSession)) return { _tag: "Refused", reason: "this machine is no longer signed in to Jive" };
        return yield* e.pipe(
          e.Effect.gen(() => npmCredentialPoster.postNpmCredential({ session: maybeSession.value, credential: request.credential })),
          e.Effect.as<DaemonResponse>({ _tag: "Posted" }),
          e.Effect.catchTag("CredentialRefused", ({ reason }) => e.Effect.succeed<DaemonResponse>({ _tag: "Refused", reason })),
        );
      }
    }
  }

  /**
   * Signs in through jive's session, replacing a sign-in already waiting, and answers once the request is open. The
   * session keeps claiming in the background and stores the session when the person approves; the extension sees it
   * on its next `GetSession`.
   */
  private *startSignIn(): EffectGen<OpenedSignInRequest, SignInFailed> {
    const { session, extensionSignIn } = this.dependencies;
    yield* this.cancelSignIn();
    yield* extensionSignIn.expect();
    const fiber = yield* e.Effect.forkDetach(e.pipe(
      e.Effect.gen(() => session.signIn()),
      e.Effect.tap(({ expiresAt }) => e.Effect.log(`Signed in to Jive until ${isoTime(expiresAt)}`)),
      e.Effect.tapError(({ reason }) => e.Effect.logWarning(`The extension's sign-in did not finish: ${reason}`)),
      e.Effect.ensuring(e.Effect.gen(() => extensionSignIn.ended())),
    ));
    yield* e.Ref.set(this.signInFiber, e.Option.some(fiber));
    // The request opens before the session claims it, so the sign-in ends first only when it could not open one.
    return yield* e.Effect.raceFirst(
      e.Effect.gen(() => extensionSignIn.awaitOpened()),
      e.pipe(e.Fiber.join(fiber), e.Effect.andThen(e.Effect.fail(new SignInFailed({ reason: "the sign-in ended before it opened a request" })))),
    );
  }

  private *cancelSignIn(): EffectGen<void> {
    const maybeFiber = yield* e.Ref.getAndSet(this.signInFiber, e.Option.none());
    if (e.Option.isSome(maybeFiber)) yield* e.Fiber.interrupt(maybeFiber.value);
  }
}

function signingIn(request: OpenedSignInRequest): DaemonResponse {
  return { _tag: "SigningIn", loginUrl: request.loginUrl, expiresAt: isoTime(request.expiresAt) };
}
