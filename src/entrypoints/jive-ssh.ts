import * as e from "effect";
import { BunServices } from "@effect/platform-bun";
import { OSPlatform, OSPlatformImpl } from "jive-abstract-library";
import { SSH_COMMAND_NAME } from "@/constants";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import { DaemonClientImpl } from "@/modules/daemon-client/impl";
import { sshConfigOption, sshOptions } from "@/modules/ssh-wrappers/command-line";
import { problemLine, signingSessionOf } from "@/modules/ssh-wrappers/signing-session";
import { wrapperLogger } from "@/modules/ssh-wrappers/stderr-logger";
import { shownPath, sshArgumentsThroughAgent } from "@/modules/ssh-wrappers/through-agent";

/**
 * ssh, logging in with the Jive account key through jive's agent and no other key: git's `core.sshCommand`, and a
 * drop-in for ssh by hand. Before ssh runs it asks `jive-daemon` whether the key can sign, because the agent can only
 * refuse a sign request with one byte that ssh reports as `agent refused operation`. Then it runs stock ssh with
 * jive's options first and the caller's arguments after them; ssh keeps the first value of an option, so a caller's
 * `-o` for the same option has no effect, and each such one is named on stderr. Its exit code is ssh's.
 */

/** ssh's own exit code for its failures; jive-ssh stands in for ssh, so its refusals use it too. */
const REFUSED = 255;

const program = e.Effect.gen(function* () {
  const args = process.argv.slice(2);
  const osPlatform = yield* OSPlatform;
  const daemonClient = yield* modules.daemonClient;
  const homeDirectory = yield* osPlatform.getHomeDirectory();
  const { accountPublicKeyFile, agentSocket } = jiveHomePaths(homeDirectory);
  const shown = (file: string) => shownPath({ homeDirectory, file });
  const options = sshOptions(args);
  const askDaemon = () => e.Effect.map(e.Effect.result(e.Effect.gen(() => daemonClient.getSession())), signingSessionOf);

  const identityFile = options.find((option) => option.letter === "i");
  if (identityFile !== undefined) {
    const { maybeUsername } = yield* askDaemon();
    const signedInAs = e.Option.match(maybeUsername, { onNone: () => "", onSome: (username) => `, signed in as ${username}` });
    const key = e.Option.getOrElse(identityFile.value, () => "<key>");
    yield* e.Effect.logError(
      `-i is not accepted. ${SSH_COMMAND_NAME} always logs in with your Jive account key, ${shown(accountPublicKeyFile)}${signedInAs}. `
      + `To log in with another key, use plain ssh -i ${key}. If you need -i with ${SSH_COMMAND_NAME}, tell us what for.`,
    );
    return REFUSED;
  }

  // `-G` only prints the configuration ssh would use (git may probe with it), so nothing signs.
  let account = "you";
  if (!options.some((option) => option.letter === "G")) {
    const session = yield* askDaemon();
    if (session._tag === "Blocked") {
      yield* e.Effect.logError(problemLine(session.problem));
      return REFUSED;
    }
    account = e.Option.getOrElse(session.maybeUsername, () => account);
  }

  for (const option of options) {
    if (option.letter === "A") {
      yield* e.Effect.logWarning(`-A forwards jive's agent: while you are connected, the remote host can sign as ${account} with your Jive key`);
    }
    if (option.letter !== "o" || e.Option.isNone(option.value)) continue;
    const written = option.value.value;
    const { keyword, argument } = sshConfigOption(written);
    switch (keyword.toLowerCase()) {
      case "identityagent":
        yield* e.Effect.logWarning(`-o ${written} has no effect: ${SSH_COMMAND_NAME} passes IdentityAgent=${shown(agentSocket)} first, and ssh keeps the first value`);
        break;
      case "identitiesonly":
        yield* e.Effect.logWarning(`-o ${written} has no effect: ${SSH_COMMAND_NAME} passes IdentitiesOnly=yes first, and ssh keeps the first value`);
        break;
      case "identityfile":
        yield* e.Effect.logWarning(`-o ${written} adds a second key: ssh offers your Jive account key, ${shown(accountPublicKeyFile)}, first, then ${argument}`);
        break;
      case "forwardagent":
        if (argument.toLowerCase() !== "no") {
          yield* e.Effect.logWarning(`-o ${written} forwards jive's agent: while you are connected, the remote host can sign as ${account} with your Jive key`);
        }
        break;
    }
  }

  const ran = yield* e.Effect.result(e.Effect.gen(() => osPlatform.spawnProcess({
    command: "ssh",
    args: [...sshArgumentsThroughAgent({ homeDirectory, publicKeyFile: accountPublicKeyFile }), ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })));
  if (e.Result.isFailure(ran)) {
    yield* e.Effect.logError(`could not run ssh: ${ran.failure}`);
    return REFUSED;
  }
  return ran.success.exitCode;
});

e.Effect.runPromise(e.pipe(
  program,
  e.Effect.provide(DaemonClientImpl.Layer),
  e.Effect.provide(OSPlatformImpl.Layer),
  e.Effect.provide(wrapperLogger(SSH_COMMAND_NAME)),
  e.Effect.provide(BunServices.layer),
)).then((exitCode) => process.exit(exitCode));
