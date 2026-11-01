import * as path from "node:path";

/**
 * What jive keeps in the person's home directory, shared by every process that reads it: the CLI writes the session
 * and the account's public key, the signing agent reads both and serves its socket, and git and ssh are pointed at
 * the public key and the socket by `jive git setup`.
 *
 * One signing agent serves a person however many copies of jive are installed: a second copy's agent finds the first
 * one's pidfile names a live process and stands down.
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
  };
};
export type JiveHomePaths = ReturnType<typeof jiveHomePaths>;
