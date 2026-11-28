import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { modules } from "@/modules";
import { daemonProblem } from "@/modules/ssh-wrappers/signing-session";
import type { DaemonDidNotAnswer, DaemonNotRunning } from "@/modules/daemon-client/interface";
import { SignInFailed, type ISignInRoute } from "./interface";

/**
 * The CLI's way to a session: \`jive-daemon\` opens the sign-in request, or adds this program to the one already
 * waiting, so the person gets one prompt however many programs ask. The CLI shows the page and waits for the daemon
 * to store the session.
 */
export class ThroughDaemonSignInRouteImpl extends implementing(modules.signInRoute).uses(modules.daemonClient, modules.signInPrompt) implements ISignInRoute {
  *signIn(): EffectGen<void, SignInFailed> {
    const { daemonClient, signInPrompt } = this.dependencies;
    const page = yield* e.pipe(e.Effect.gen(() => daemonClient.startSignIn()), e.Effect.catchTags(unreachableDaemon));
    yield* signInPrompt.show(page);
    yield* e.pipe(e.Effect.gen(() => daemonClient.awaitSignIn({ until: page.expiresAt })), e.Effect.catchTags(unreachableDaemon));
  }
}

const daemonFailure = (error: DaemonNotRunning | DaemonDidNotAnswer) => {
  const { cause, fix } = daemonProblem(error);
  return e.Effect.fail(new SignInFailed({ reason: `${cause}; ${fix}` }));
};
const unreachableDaemon = { DaemonNotRunning: daemonFailure, DaemonDidNotAnswer: daemonFailure };

/** Inside \`jive-daemon\`, which signs in through \`IMachineSignIn\` on its API socket; nothing there signs in through \`ISession\`. */
export class InsideDaemonSignInRouteImpl extends implementing(modules.signInRoute) implements ISignInRoute {
  *signIn(): EffectGen<void, SignInFailed> {
    return yield* new SignInFailed({ reason: "jive-daemon signs in only when a program asks it on its socket" });
  }
}
