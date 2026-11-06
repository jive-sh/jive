import type { EffectGen } from "effective-modules";
import type { ResponseEnvelope } from "./protocol";

/**
 * What `jive-extension-daemon` answers the Jive browser extension (`./protocol`): this machine's Jive session, which
 * is the one `jive login` writes, signing in and out, and posting the npm credential the extension collects. The
 * session token is handed only to the npm credential poster; no response carries it, and nothing logs a request's
 * contents.
 */
export interface IExtensionDaemon {
  /** Answers one line from the socket. A line that isn't a request of this protocol version is refused. */
  answerLine(line: string): EffectGen<ResponseEnvelope>;
}
