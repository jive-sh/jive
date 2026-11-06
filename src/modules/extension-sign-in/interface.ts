import type * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { OpenedSignInRequest } from "@/modules/jive-server/interface";

/**
 * The sign-in request the Jive browser extension is waiting on. jive's session opens and claims it (`ISession.signIn`)
 * and shows it through the extension's sign-in prompt, which hands it here; the extension daemon reads it back to
 * answer the extension. The claim secret stays in memory, so a daemon restart drops a waiting sign-in.
 */
export interface IExtensionSignIn {
  /** A sign-in is starting: forgets any earlier request, so `awaitOpened` waits for this one's. */
  expect(): EffectGen<void>;
  /** The request jive's session opened for that sign-in, from the extension's sign-in prompt. */
  opened(request: OpenedSignInRequest): EffectGen<void>;
  awaitOpened(): EffectGen<OpenedSignInRequest>;
  /** The request still waiting for the person, if one is and it hasn't expired. */
  waiting(): EffectGen<e.Option.Option<OpenedSignInRequest>>;
  /** The sign-in ended (approved, failed, expired or cancelled): nothing is waiting any more. */
  ended(): EffectGen<void>;
}
