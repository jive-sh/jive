import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatform, OSPlatformImpl } from "jive-abstract-library";
import { SIGNING_COMMAND_NAME } from "@/constants";
import { modules } from "@/modules";
import { DaemonClientImpl } from "@/modules/daemon-client/impl";
import { sshKeygenOptions } from "@/modules/ssh-wrappers/command-line";
import { problemLine, signingSessionOf } from "@/modules/ssh-wrappers/signing-session";
import { wrapperLogger } from "@/modules/ssh-wrappers/stderr-logger";
import { sshKeygenEnvironmentThroughAgent } from "@/modules/ssh-wrappers/through-agent";

/**
 * What git runs for SSH signatures (`gpg.ssh.program`): stock ssh-keygen with every argument unchanged and jive's
 * agent as SSH_AUTH_SOCK, so `-Y sign -f ~/.jive/ssh/account.pub` signs through the server and git's other uses of the
 * program (`-Y verify`, `-Y find-principals`, `-Y check-novalidate`, `-l`) run as they would with ssh-keygen. Before
 * `-Y sign` it asks `jive-daemon` whether the key can sign, because the agent can only refuse with one byte that
 * ssh-keygen reports as `agent refused operation`. Its exit code is ssh-keygen's.
 */

/** ssh-keygen's own exit code for its failures, which this program's refusals share. */
const REFUSED = 255;

const program = e.Effect.gen(function* () {
  const args = process.argv.slice(2);
  const osPlatform = yield* OSPlatform;
  // ssh-keygen keeps the last -Y it is given.
  const mode = sshKeygenOptions(args).findLast((option) => option.letter === "Y");
  if (mode !== undefined && e.Option.contains(mode.value, "sign")) {
    const daemonClient = yield* modules.daemonClient;
    const session = signingSessionOf(yield* e.Effect.result(e.Effect.gen(() => daemonClient.getSession())));
    if (session._tag === "Blocked") {
      yield* e.Effect.logError(problemLine(session.problem));
      return REFUSED;
    }
  }
  const homeDirectory = yield* osPlatform.getHomeDirectory();
  const ran = yield* e.Effect.result(e.Effect.gen(() => osPlatform.spawnProcess({
    command: "ssh-keygen",
    args,
    env: sshKeygenEnvironmentThroughAgent({ inherited: process.env, homeDirectory }),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })));
  if (e.Result.isSuccess(ran)) return ran.success.exitCode;
  yield* e.Effect.logError(`could not run ssh-keygen: ${ran.failure}`);
  return REFUSED;
});

e.Effect.runPromise(e.pipe(
  program,
  e.Effect.provide(DaemonClientImpl.Layer),
  e.Effect.provide(OSPlatformImpl.Layer),
  e.Effect.provide(wrapperLogger(SIGNING_COMMAND_NAME)),
  e.Effect.provide(BunServices.layer),
)).then((exitCode) => process.exit(exitCode));
