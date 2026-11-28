import type * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { OpenedSignInRequest, Session, SignInCaller } from "@/modules/jive-server/interface";
import type { SignInFailed } from "@/modules/session/interface";

/**
 * \`jive-daemon\`'s sign-in, the only one on the machine: one request at a time, opened with the machine's key
 * (\`modules/machine-identity\`) and naming every program that asked while it waits, so the person sees one prompt.
 * The daemon claims the session with the machine's signature and stores it in the shared session file. The claim
 * secret stays in this process; a restart drops a waiting sign-in.
 */
export interface IMachineSignIn {
  /**
   * Opens a request for \`caller\`, or, while one waits, adds \`caller\` to it; answers with the request once it is open.
   * Claiming runs in the background until the request is approved, expires or is cancelled.
   */
  startOrJoin(caller: SignInCaller): EffectGen<OpenedSignInRequest, SignInFailed>;
  /** The request still waiting for the person, if one is and it hasn't expired. */
  waiting(): EffectGen<e.Option.Option<OpenedSignInRequest>>;
  /** Waits for the sign-in under way to end with its session, or why it didn't; fails at once when none is under way. */
  awaitEnd(): EffectGen<Session, SignInFailed>;
  /** Stops the sign-in under way, if any: signing out. */
  cancel(): EffectGen<void>;
}
