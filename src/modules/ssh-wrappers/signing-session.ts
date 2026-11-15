import * as e from "effect";
import { TOOL_NAME } from "@/constants";
import type { DaemonDidNotAnswer, DaemonNotRunning, DaemonRefused } from "@/modules/daemon-client/interface";
import type { SessionStatus } from "@/modules/extension-daemon/protocol";

/**
 * Whether the Jive key can sign right now, from `jive-daemon`'s `GetSession` answer, and the words for when it can't.
 * The SSH agent protocol answers a refused sign request with one byte and no text, so `jive-ssh` and `jive-ssh-sign`
 * ask first and say why before ssh or ssh-keygen runs; `jive whoami` says the same about the daemon.
 */

/** Why the key can't sign, and what the person does about it. */
export interface SigningProblem {
  readonly cause: string;
  readonly fix: string;
}

export type SigningSession = e.Data.TaggedEnum<{
  /** Signed in, as the server confirmed just now. */
  Ready: { readonly maybeUsername: e.Option.Option<string> };
  /** Signing would fail. `maybeUsername` is who is signed in, when the daemon knows. */
  Blocked: { readonly problem: SigningProblem; readonly maybeUsername: e.Option.Option<string> };
}>;
export const SigningSession = e.Data.taggedEnum<SigningSession>();

export const notSignedIn: SigningProblem = { cause: "not signed in to Jive", fix: `run \`${TOOL_NAME} login\`` };

export function daemonProblem(error: DaemonNotRunning | DaemonDidNotAnswer | DaemonRefused): SigningProblem {
  switch (error._tag) {
    case "DaemonNotRunning":
      // Installing registers the daemon and starts it, and it starts again at each login; `jive upgrade` reinstalls with
      // the package manager that installed jive and runs the new installer (jive-abstract-library's installed-package).
      return { cause: "jive's daemon is not running", fix: `run \`${TOOL_NAME} daemons\` to see why; \`${TOOL_NAME} upgrade\` registers and starts it again, and so does logging in again` };
    case "DaemonDidNotAnswer":
      return { cause: `jive's daemon did not answer (${error.detail})`, fix: `run \`${TOOL_NAME} daemons\` to find its log` };
    case "DaemonRefused":
      return { cause: `jive's daemon could not check your session: ${error.message}`, fix: "run the command again" };
  }
}

/** The server at `url` can't be reached, so nothing can sign as the account the daemon last saw confirmed. */
export function serverUnreachable({ url, maybeUsername }: { readonly url: string; readonly maybeUsername: e.Option.Option<string> }): SigningProblem {
  const account = e.Option.getOrElse(maybeUsername, () => "your Jive account");
  return { cause: `your computer can't reach Jive's server (${url}) to sign as ${account}`, fix: "reconnect and run the command again" };
}

export function signingSessionOf(answer: e.Result.Result<SessionStatus, DaemonNotRunning | DaemonDidNotAnswer | DaemonRefused>): SigningSession {
  if (e.Result.isFailure(answer)) return SigningSession.Blocked({ problem: daemonProblem(answer.failure), maybeUsername: e.Option.none() });
  const status = answer.success;
  if (status._tag !== "SignedIn") return SigningSession.Blocked({ problem: notSignedIn, maybeUsername: e.Option.none() });
  const maybeUsername = e.Option.fromUndefinedOr(status.username);
  if (status.confirmedByServer) return SigningSession.Ready({ maybeUsername });
  const url = status.unreachableServerUrl !== undefined ? status.unreachableServerUrl : "its address unknown";
  return SigningSession.Blocked({ problem: serverUnreachable({ url, maybeUsername }), maybeUsername });
}

/** A problem as one line: the cause, then the fix. */
export const problemLine = ({ cause, fix }: SigningProblem): string => `${cause}; ${fix}`;
