import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import { SignInClaim, jiveServerFailure, type OpenedSignInRequest, type Session, type SignInCaller } from "@/modules/jive-server/interface";
import { SignInFailed } from "@/modules/session/interface";
import type { IMachineSignIn } from "./interface";

const CLAIM_INTERVAL = e.Duration.seconds(2);

/**
 * What the machine key signs, as `@jive-sh/server`'s `convex/model/machineKeys.ts` checks it. Each side keeps its own
 * copy; a sign-in against the live server is what proves they agree.
 */
const openMessage = (input: { readonly publicKey: string; readonly signedAt: number }): string => `jive-sign-in-open\n${input.publicKey}\n${input.signedAt}`;
const claimMessage = (requestId: string): string => `jive-sign-in-claim\n${requestId}`;

/** The sign-in under way: its request, and how it ended once it has. */
interface Attempt {
  readonly request: OpenedSignInRequest;
  readonly ended: e.Deferred.Deferred<Session, SignInFailed>;
  readonly claiming: e.Fiber.Fiber<void>;
}

export class MachineSignInImpl extends implementing(modules.machineSignIn).uses(
  modules.session,
  modules.jiveServer,
  modules.machineIdentity,
) implements IMachineSignIn {
  private readonly attempt = e.Ref.makeUnsafe(e.Option.none<Attempt>());
  /** One start, join or cancel at a time, so two programs asking at once share one request. */
  private readonly changing = e.Semaphore.makeUnsafe(1);

  *startOrJoin(caller: SignInCaller): EffectGen<OpenedSignInRequest, SignInFailed> {
    const self = this;
    return yield* e.Semaphore.withPermits(this.changing, 1)(e.Effect.gen(function* () {
      const maybeWaiting = yield* self.underWay();
      if (e.Option.isSome(maybeWaiting)) {
        const { request } = maybeWaiting.value;
        yield* e.Effect.log(`${caller.programs.join(" › ")} joined the sign-in waiting at ${request.loginUrl}`);
        // The request stays usable if the server can't add the name: the person just sees fewer programs.
        yield* e.pipe(
          e.Effect.gen(() => self.dependencies.jiveServer.addSignInCaller({ request, caller })),
          e.Effect.catch((error) => e.Effect.logWarning(`Jive did not add ${caller.programs.join(" › ")} to the sign-in: ${jiveServerFailure(error)}`)),
        );
        return request;
      }
      return yield* self.open(caller);
    }));
  }

  *waiting(): EffectGen<e.Option.Option<OpenedSignInRequest>> {
    return e.Option.map(yield* this.underWay(), ({ request }) => request);
  }

  *awaitEnd(): EffectGen<Session, SignInFailed> {
    const maybeAttempt = yield* e.Ref.get(this.attempt);
    if (e.Option.isNone(maybeAttempt)) return yield* new SignInFailed({ reason: "no sign-in is under way; start one first" });
    return yield* e.Deferred.await(maybeAttempt.value.ended);
  }

  *cancel(): EffectGen<void> {
    const self = this;
    yield* e.Semaphore.withPermits(this.changing, 1)(e.Effect.gen(function* () {
      const maybeAttempt = yield* e.Ref.getAndSet(self.attempt, e.Option.none());
      if (e.Option.isNone(maybeAttempt)) return;
      yield* e.Fiber.interrupt(maybeAttempt.value.claiming);
      yield* e.Deferred.fail(maybeAttempt.value.ended, new SignInFailed({ reason: "the sign-in was cancelled" }));
    }));
  }

  /** The attempt still waiting for the person: not ended and not expired. */
  private *underWay(): EffectGen<e.Option.Option<Attempt>> {
    const maybeAttempt = yield* e.Ref.get(this.attempt);
    if (e.Option.isNone(maybeAttempt)) return e.Option.none();
    const ended = yield* e.Deferred.isDone(maybeAttempt.value.ended);
    return ended || maybeAttempt.value.request.expiresAt <= Date.now() ? e.Option.none() : maybeAttempt;
  }

  private *open(caller: SignInCaller): EffectGen<OpenedSignInRequest, SignInFailed> {
    const { session, jiveServer, machineIdentity } = this.dependencies;
    const keyFailure = (error: { readonly detail: string }) => new SignInFailed({ reason: `this machine's key: ${error.detail}` });
    const machine = yield* e.pipe(e.Effect.gen(() => machineIdentity.describe()), e.Effect.mapError(keyFailure));
    const signedAt = Date.now();
    const signature = yield* e.pipe(e.Effect.gen(() => machineIdentity.sign(openMessage({ publicKey: machine.publicKey, signedAt }))), e.Effect.mapError(keyFailure));
    const request = yield* e.pipe(
      // The last session, even one the server has ended, tells it whose phones to ask.
      e.Effect.gen(function* () {
        return yield* jiveServer.openMachineSignInRequest({ previousSession: yield* session.lastIssued(), machine, signedAt, signature, callers: [caller] });
      }),
      e.Effect.mapError((error) => new SignInFailed({ reason: `could not open a sign-in request: ${jiveServerFailure(error)}` })),
    );
    const claimSignature = yield* e.pipe(e.Effect.gen(() => machineIdentity.sign(claimMessage(request.requestId))), e.Effect.mapError(keyFailure));
    yield* e.Effect.log(`${caller.programs.join(" › ")} asked to sign in to Jive: ${request.loginUrl}`);
    const ended = yield* e.Deferred.make<Session, SignInFailed>();
    const claiming = yield* e.Effect.forkDetach(e.pipe(
      e.Effect.gen(() => this.claimWhenApproved({ request, signature: claimSignature })),
      e.Effect.tap((claimed) => e.Effect.gen(() => session.adopt(claimed))),
      e.Effect.tap(({ expiresAt }) => e.Effect.log(`Signed in to Jive until ${new Date(expiresAt).toISOString()}`)),
      e.Effect.tapError(({ reason }) => e.Effect.logWarning(`The sign-in did not finish: ${reason}`)),
      e.Effect.exit,
      e.Effect.flatMap((exit) => e.Deferred.done(ended, exit)),
      e.Effect.asVoid,
    ));
    yield* e.Ref.set(this.attempt, e.Option.some({ request, ended, claiming }));
    return request;
  }

  private *claimWhenApproved(input: { readonly request: OpenedSignInRequest; readonly signature: string }): EffectGen<Session, SignInFailed> {
    const { jiveServer } = this.dependencies;
    while (Date.now() < input.request.expiresAt) {
      const claim = yield* e.pipe(
        e.Effect.gen(() => jiveServer.claimSignInRequest(input)),
        e.Effect.mapError((error) => new SignInFailed({ reason: `could not claim the sign-in: ${jiveServerFailure(error)}` })),
      );
      if (SignInClaim.$is("Approved")(claim)) return claim.session;
      if (SignInClaim.$is("Gone")(claim)) return yield* new SignInFailed({ reason: "the sign-in request expired or was already used; sign in again" });
      yield* e.Effect.sleep(CLAIM_INTERVAL);
    }
    return yield* new SignInFailed({ reason: "nobody approved the sign-in before it expired; sign in again" });
  }
}
