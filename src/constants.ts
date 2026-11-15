import * as path from "node:path";
import { name } from "../package.json";

export const PACKAGE_NAME = name;
export const TOOL_NAME = "jive";
/** ssh with the account key through the signing agent (`src/entrypoints/jive-ssh.ts`): git's `core.sshCommand`. */
export const SSH_COMMAND_NAME = "jive-ssh";
/** ssh-keygen's signing through the signing agent (`src/entrypoints/jive-ssh-sign.ts`): git's `gpg.ssh.program`. */
export const SIGNING_COMMAND_NAME = "jive-ssh-sign";
/** The one daemon (`src/daemons/jive-daemon.ts`): the SSH agent socket and its API socket. */
export const DAEMON_NAME = "jive-daemon";
/** What Chrome starts when the extension connects: it relays the extension's messages to the extension daemon. */
export const NATIVE_HOST_COMMAND_NAME = "jive-native-host";

/**
 * Where an installed jive command lives, given the running one (`OSPlatform.getExecutablePath`). jive-abstract-library
 * installs every command as a link to one binary in the same directory, so each sits beside the running one; git
 * config names them by these paths.
 */
export const installedCommandPath = (runningExecutable: string, commandName: string): string =>
  path.join(path.dirname(runningExecutable), process.platform === "win32" ? `${commandName}.exe` : commandName);
