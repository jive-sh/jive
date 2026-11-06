import * as path from "node:path";

/**
 * What jive keeps in the person's home directory, shared by every process that reads it: the CLI writes the session
 * and the account's public key, the signing agent reads both and serves its socket, and git and ssh are pointed at
 * the public key and the socket per repository by `jive init` and `jive load` (never through `~/.ssh`). The extension
 * daemon reads and writes the same session and serves the Jive browser extension on its own socket.
 *
 * One of each daemon serves a person however many copies of jive are installed: a second copy's daemon finds the
 * first one's pidfile names a live process and stands down.
 */
export const jiveHomePaths = (homeDirectory: string) => {
  const jiveHome = path.join(homeDirectory, ".jive");
  return {
    jiveHome,
    /** The session token and its expiry, readable by the owner only. */
    sessionFile: path.join(jiveHome, "session.json"),
    /** The account's OpenSSH public key, as the server returned it; the private key never leaves the server. */
    accountPublicKeyFile: path.join(jiveHome, "ssh", "account.pub"),
    agentSocket: path.join(jiveHome, "signing-agent.sock"),
    agentPidFile: path.join(jiveHome, "signing-agent.pid"),
    /** Where the extension daemon answers the native host, which relays the extension's messages. Owner-only. */
    extensionDaemonSocket: path.join(jiveHome, "extension-daemon.sock"),
    extensionDaemonPidFile: path.join(jiveHome, "extension-daemon.pid"),
    /** The launcher Chrome starts as the native host when the extension daemon runs from source, not as a binary. */
    nativeHostLauncherFromSource: path.join(jiveHome, "jive-native-host-from-source"),
  };
};
export type JiveHomePaths = ReturnType<typeof jiveHomePaths>;
