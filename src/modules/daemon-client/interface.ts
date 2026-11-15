import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { SessionStatus } from "@/modules/extension-daemon/protocol";

/**
 * Asks `jive-daemon` on its API socket (`~/.jive/jive-daemon.sock`), for the commands that run outside it:
 * `jive-ssh`, `jive-ssh-sign` and `jive whoami` all learn who this machine is signed in as here, so they say the
 * same thing and none of them reaches the server itself.
 */

/** Nothing listens on the daemon's socket: the daemon is not running. */
export class DaemonNotRunning extends e.Data.TaggedError("DaemonNotRunning")<{ readonly socketPath: string }> {}

/** The daemon's socket was reached but no readable answer came back; `detail` says what happened instead. */
export class DaemonDidNotAnswer extends e.Data.TaggedError("DaemonDidNotAnswer")<{ readonly detail: string }> {}

/** The daemon answered that it could not handle the request, with its own words. */
export class DaemonRefused extends e.Data.TaggedError("DaemonRefused")<{ readonly message: string }> {}

export interface IDaemonClient {
  /** The daemon's `GetSession` answer: signed out, waiting for a sign-in, or signed in and as whom. */
  getSession(): EffectGen<SessionStatus, DaemonNotRunning | DaemonDidNotAnswer | DaemonRefused>;
}
