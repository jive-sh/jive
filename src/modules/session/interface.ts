import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { JiveServerError, OpenedSignInRequest, Session } from "@/modules/jive-server/interface";

/**
 * This machine's session on `@jive-sh/server`, shared by the CLI, the signing agent and the extension daemon through
 * one owner-only file. Signing in opens a sign-in request, shows the person its page, and claims the session once they approve it on jive.sh with their passkey.
 */

/** Signing in did not finish: the request expired or was claimed elsewhere, or the server could not be reached. */
export class SignInFailed extends e.Data.TaggedError("SignInFailed")<{ readonly reason: string }> {}

export interface ISession {
  /**
   * The stored session, whatever its saved end: every use extends a session on the server, so only the server can say
   * it has ended (`checkWithServer`, or a refused call).
   */
  current(): EffectGen<e.Option.Option<Session>>;
  /** Signs in afresh with a passkey, replacing any stored session. */
  signIn(): EffectGen<Session, SignInFailed>;
  /**
   * Signs a CI/CD job in by exchanging its ID token for a session of its pipeline, replacing any stored session. The
   * only other way to a session; nothing here accepts a token from elsewhere.
   */
  signInAsPipeline(): EffectGen<Session, SignInFailed>;
  /**
   * The stored session, or a new one when there is none. Concurrent callers share one sign-in, so a burst of sign
   * requests to the agent shows the person one page.
   */
  ensureSignedIn(): EffectGen<Session, SignInFailed>;
  /**
   * Asks the server whether it still honours `session` (`accounts:me`). When it does, the stored session takes the
   * end the server gives; when it does not, `current` stops returning it, and the next sign-in names it to the server so
   * the account's phones are asked. Either applies only while `session` is still the one stored.
   */
  checkWithServer(session: Session): EffectGen<e.Option.Option<{ readonly username: string; readonly session: Session }>, JiveServerError>;
  /** Drops the stored session: signing out. */
  forget(): EffectGen<void>;
}

/**
 * How a sign-in request reaches the person: the CLI prints it, the agent, which has no terminal, notifies, and the
 * extension daemon hands it to the Jive browser extension, which asked for it.
 */
export interface ISignInPrompt {
  show(request: OpenedSignInRequest): EffectGen<void>;
}
