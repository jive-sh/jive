import * as path from "node:path";

/**
 * What jive keeps in the person's home directory, shared by every process that reads it: the CLI writes the session
 * and the account's public key, and `jive-daemon` reads both. Git and ssh are pointed at the public key and the
 * agent socket per repository by `jive init` and `jive load` (never through `~/.ssh`). The same daemon serves the
 * Jive browser extension and jive's ssh wrappers on its API socket.
 *
 * One daemon serves a person however many copies of jive are installed: a second copy finds the pidfile names a
 * live process and stands down. The older pidfiles stay so a source run stands down while an old process still
 * holds a socket.
 */
export const jiveHomePaths = (homeDirectory: string) => {
  const jiveHome = path.join(homeDirectory, ".jive");
  return {
    jiveHome,
    /** The session token and its expiry, readable by the owner only. */
    sessionFile: path.join(jiveHome, "session.json"),
    /**
     * The repository whose signing passkey answers npm, written by `PrepareSigningPasskey` and read again after a
     * restart. The page does not name a repository, so this is the only copy.
     */
    signingPasskeyRepositoryFile: path.join(jiveHome, "signing-passkey-repository.json"),
    /** The account's OpenSSH public key, as the server returned it; the private key never leaves the server. */
    accountPublicKeyFile: path.join(jiveHome, "ssh", "account.pub"),
    agentSocket: path.join(jiveHome, "signing-agent.sock"),
    agentPidFile: path.join(jiveHome, "signing-agent.pid"),
    /** This process. The older pidfiles are only read, so a live old daemon is not replaced. */
    daemonPidFile: path.join(jiveHome, "jive-daemon.pid"),
    /**
     * Where `jive-daemon` answers requests (`modules/extension-daemon/protocol.ts`): the native host relays the Jive
     * extension's, and `jive-ssh`, `jive-ssh-sign` and `jive whoami` ask who is signed in. Owner-only.
     */
    daemonSocket: path.join(jiveHome, "jive-daemon.sock"),
    extensionDaemonPidFile: path.join(jiveHome, "extension-daemon.pid"),
    /** The launcher Chrome starts as the native host when the extension daemon runs from source, not as a binary. */
    nativeHostLauncherFromSource: path.join(jiveHome, "jive-native-host-from-source"),
  };
};
export type JiveHomePaths = ReturnType<typeof jiveHomePaths>;
