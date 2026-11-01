import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { OpenedSignInRequest, Session } from "@/modules/jive-server/interface";

/**
 * This machine's session on `@jive-sh/server`, shared by the CLI and the signing agent through one owner-only file.
 * Signing in opens a sign-in request, shows the person its page and confirmation code, and claims the session once
 * they approve it on jive.sh with their passkey.
 */

/** Signing in did not finish: the request expired or was claimed elsewhere, or the server could not be reached. */
export class SignInFailed extends e.Data.TaggedError("SignInFailed")<{ readonly reason: string }> {}

export interface ISession {
  /** The stored session, when the server should still honour it. */
  current(): EffectGen<e.Option.Option<Session>>;
  /** Signs in afresh, replacing any stored session. */
  signIn(): EffectGen<Session, SignInFailed>;
  /**
   * The stored session, or a new one when there is none. Concurrent callers share one sign-in, so a burst of sign
   * requests to the agent shows the person one page.
   */
  ensureSignedIn(): EffectGen<Session, SignInFailed>;
  /** Drops the stored session, which the server no longer honours (it was revoked before it expired). */
  forget(): EffectGen<void>;
}

/** How a sign-in request reaches the person: the CLI prints it, the agent, which has no terminal, notifies. */
export interface ISignInPrompt {
  show(request: OpenedSignInRequest): EffectGen<void>;
}
