import * as e from "effect";
import type { EffectGen } from "effective-modules";

/**
 * The calls jive makes to `@jive-sh/server`, Jive's Convex backend. Every call that acts for a person takes a session
 * token and nothing else; a program gets one by claiming a sign-in request the person approved on jive.sh.
 */

/** A sign-in request this program opened. Only this program ever holds the claim secret. */
export interface OpenedSignInRequest {
  readonly requestId: string;
  readonly claimSecret: string;
  /** Shown by this program and by the login page, so the person can check they approve this program's request. */
  readonly confirmationCode: string;
  readonly loginUrl: string;
  readonly expiresAt: number;
}

/** A program's session on the server: the token every call takes, and when the server stops honouring it. */
export interface Session {
  readonly sessionToken: string;
  readonly expiresAt: number;
}

export type SignInClaim = e.Data.TaggedEnum<{
  Pending: {};
  Approved: { readonly session: Session };
  /** Unknown, expired or already claimed: the server answers the same for each. */
  Gone: {};
}>;
export const SignInClaim = e.Data.taggedEnum<SignInClaim>();

/** What `provision` answers about one resource instance (docs/jive_server_provision_api.md, section 2). */
export type ProvisionAnswer = e.Data.TaggedEnum<{
  Ready: { readonly instanceId: string };
  InProgress: { readonly retryAfterSeconds: number };
  /** The outside system wants a person first, on its own page. */
  PersonNeeded: { readonly reason: string; readonly url: string };
  Refused: { readonly reason: string };
}>;
export const ProvisionAnswer = e.Data.taggedEnum<ProvisionAnswer>();

/** The server could not be reached, or refused the call. Never carries a token, claim secret or signature. */
export class JiveServerError extends e.Data.TaggedError("JiveServerError")<{
  readonly call: string;
  readonly reason: string;
}> {}

/** The audience a CI/CD job's ID token is minted for: it names Jive's API, whichever deployment serves it. */
export const JIVE_API_AUDIENCE = "https://api.jive.sh";

export interface IJiveServer {
  openSignInRequest(): EffectGen<OpenedSignInRequest, JiveServerError>;
  claimSignInRequest(request: OpenedSignInRequest): EffectGen<SignInClaim, JiveServerError>;
  /**
   * Exchanges a CI/CD job's ID token, minted for `JIVE_API_AUDIENCE`, for a session of that job's pipeline
   * (`pipelineSessions:signIn`). The server checks the token's workflow, ref, runner and repository; a refusal fails
   * with its reason.
   */
  signInPipeline(idToken: string): EffectGen<Session, JiveServerError>;
  /** The session's account handle, or none when the server no longer honours the session (expired or revoked). */
  accountOf(session: Session): EffectGen<e.Option.Option<{ readonly username: string }>, JiveServerError>;
  /** The account's OpenSSH public key, creating the key on the server on the first call. */
  createSshKey(session: Session): EffectGen<{ readonly publicKey: string }, JiveServerError>;
  /**
   * Signs `data` with the account's SSH key on the server. The signature comes back in SSH's encoding
   * (`string "ssh-ed25519" || string <signature>`), what an SSH agent answers a sign request with.
   */
  signWithSshKey(session: Session, data: Uint8Array): EffectGen<Uint8Array, JiveServerError>;
  /**
   * Asks the server to make sure one instance of a resource kind exists (`provision`). The caller names the kind,
   * e.g. `connector-package-registry`, never the implementation: the session's organization has one configured.
   */
  provision(input: { readonly session: Session; readonly kind: string; readonly instance: unknown }): EffectGen<ProvisionAnswer, JiveServerError>;
}
