import type { EffectGen } from "effective-modules";
import type { SignInCaller } from "@/modules/jive-server/interface";
import type { ResponseEnvelope } from "./protocol";

/**
 * What `jive-daemon` answers the Jive browser extension (`./protocol`): this machine's Jive session, which
 * is the one `jive login` writes, signing in and out, and posting the npm credential the extension collects. The
 * session token is handed only to the npm credential poster; no response carries it, and nothing logs a request's
 * contents.
 */
export interface IExtensionDaemon {
  /**
   * Answers one line from the socket. `caller` is the program on the other end, read from the socket's peer process
   * (`modules/caller-chain`); a sign-in it starts names it. A line that isn't a request of this protocol version is refused.
   */
  answerLine(input: { readonly line: string; readonly caller: SignInCaller }): EffectGen<ResponseEnvelope>;
}
