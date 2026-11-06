import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { NpmCredential } from "@/modules/extension-daemon/protocol";
import type { Session } from "@/modules/jive-server/interface";

/** Jive did not take the credential, with a reason the extension shows. Never carries the credential. */
export class CredentialRefused extends e.Data.TaggedError("CredentialRefused")<{ readonly reason: string }> {}

/**
 * Sends an npm credential the extension collected to Jive, authenticated by this machine's session. Which Jive service
 * accepts it (jive.sh, which issues sessions, or `@jive-sh/server`, which holds npm connections) is not decided yet,
 * so the extension daemon ships with `NpmCredentialPosterNotDecidedImpl`, and each candidate becomes one
 * implementation of this.
 */
export interface INpmCredentialPoster {
  /** Why posting can't happen now, if it can't: checked before the extension changes anything on npm. */
  unavailableBecause(): EffectGen<e.Option.Option<string>>;
  postNpmCredential(input: { readonly session: Session; readonly credential: NpmCredential }): EffectGen<void, CredentialRefused>;
}
