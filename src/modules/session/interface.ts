import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { JiveServerError, JiveServerRefused, Session } from "@/modules/jive-server/interface";

/**
 * This machine's session on `@jive-sh/server`, shared by the CLI, the signing agent and `jive-daemon` through one
 * owner-only file. Only `jive-daemon` signs in (`modules/machine-sign-in`): it opens one sign-in request with the
 * machine's key for every program that asks, and stores the session once the person approves it with their passkey.
 * Every other program asks the daemon (`ISignInRoute`).
 */

/** Signing in did not finish: the request expired or was claimed elsewhere, or the server could not be reached. */
export class SignInFailed extends e.Data.TaggedError("SignInFailed")<{ readonly reason: string }> {}

/** Who this machine is signed in to Jive as. */
export type SignedInAccount = e.Data.TaggedEnum<{
  /** No session, or one the server has ended. */
  SignedOut: {};
  /** The server honours the session and named its account just now. */
  Confirmed: { readonly username: string; readonly session: Session };
  /**
   * The server at `unreachableUrl` could not be reached, so the stored session stands unchecked. The username is the
   * one saved when the server last confirmed the session; a session file saved before jive kept usernames has none.
   */
  Unconfirmed: { readonly maybeUsername: e.Option.Option<string>; readonly session: Session; readonly unreachableUrl: string };
}>;
export const SignedInAccount = e.Data.taggedEnum<SignedInAccount>();

export interface ISession {
  /**
   * The stored session, whatever its saved end: every use extends a session on the server, so only the server can say
   * it has ended (`checkWithServer`, or a refused call).
   */
  current(): EffectGen<e.Option.Option<Session>>;
  /** Signs in afresh with a passkey, replacing any stored session, through this process's `ISignInRoute`. */
  signIn(): EffectGen<Session, SignInFailed>;
  /** The stored session even when the server has ended it: the one a new sign-in request names so the account's phones are asked. */
  lastIssued(): EffectGen<e.Option.Option<Session>>;
  /** Stores a session `jive-daemon` just claimed, replacing any stored one. */
  adopt(session: Session): EffectGen<void, SignInFailed>;
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
   * end and the username the server gives; when it does not, `current` stops returning it, and the next sign-in names
   * it to the server so the account's phones are asked. Either applies only while `session` is still the one stored.
   */
  checkWithServer(session: Session): EffectGen<e.Option.Option<{ readonly username: string; readonly session: Session }>, JiveServerError>;
  /** The stored session checked with the server as `checkWithServer` does; an unreachable server leaves it unconfirmed. */
  whoIsSignedIn(): EffectGen<SignedInAccount, JiveServerRefused>;
  /** Drops the stored session: signing out. */
  forget(): EffectGen<void>;
}

/** The page the person approves a sign-in on, and how many of their phones were asked to. */
export interface SignInPage {
  readonly loginUrl: string;
  readonly approvalDevices: number;
}

/** How the CLI shows the person a sign-in: it prints the page and opens it. */
export interface ISignInPrompt {
  show(page: SignInPage): EffectGen<void>;
}

/**
 * How this process gets a new session. The CLI asks `jive-daemon` and waits, after which the session file holds the
 * session; inside the daemon, nothing signs in through `ISession`, so its route refuses.
 */
export interface ISignInRoute {
  signIn(): EffectGen<void, SignInFailed>;
}
