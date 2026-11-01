import * as path from "node:path";
import { name } from "../package.json";

export const PACKAGE_NAME = name;
export const TOOL_NAME = "jive";
export const GIT_CREDENTIAL_HELPER_NAME = "git-credential-jive";
/** What git runs to sign (`gpg.ssh.program`): ssh-keygen, pointed at the signing agent's socket. */
export const SSH_KEYGEN_COMMAND_NAME = "jive-ssh-keygen";

/**
 * Where an installed jive command lives, given the running one (`OSPlatform.getExecutablePath`). jive-abstract-library
 * installs every command as a link to one binary in the same directory, so each sits beside the running one; git
 * config names them by these paths.
 */
export const installedCommandPath = (runningExecutable: string, commandName: string): string =>
  path.join(path.dirname(runningExecutable), process.platform === "win32" ? `${commandName}.exe` : commandName);
