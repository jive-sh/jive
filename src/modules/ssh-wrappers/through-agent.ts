import { jiveHomePaths } from "@/jive-home";

/**
 * How ssh and ssh-keygen are pointed at the signing agent: `jive-ssh` passes ssh these options ahead of the caller's,
 * and `jive-ssh-sign` gives ssh-keygen the agent's socket as SSH_AUTH_SOCK.
 */

/** ssh's options that make it authenticate with the account key through the agent, and offer no other key. */
export function sshArgumentsThroughAgent({ homeDirectory, publicKeyFile }: { readonly homeDirectory: string; readonly publicKeyFile: string }): ReadonlyArray<string> {
  return [
    "-o", `IdentityAgent=${jiveHomePaths(homeDirectory).agentSocket}`,
    "-o", `IdentityFile=${publicKeyFile}`,
    "-o", "IdentitiesOnly=yes",
  ];
}

/** ssh-keygen's environment: `inherited`, with SSH_AUTH_SOCK naming the agent's socket. */
export function sshKeygenEnvironmentThroughAgent({ inherited, homeDirectory }: {
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): Record<string, string | undefined> {
  return { ...inherited, SSH_AUTH_SOCK: jiveHomePaths(homeDirectory).agentSocket };
}

/** `file` as a person reads it in a message: under the home directory, written with `~`. */
export function shownPath({ homeDirectory, file }: { readonly homeDirectory: string; readonly file: string }): string {
  return file.startsWith(`${homeDirectory}/`) ? `~${file.slice(homeDirectory.length)}` : file;
}
