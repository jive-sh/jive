import { jiveHomePaths } from "@/jive-home";

/**
 * How ssh and ssh-keygen are pointed at the signing agent, for every caller. ssh takes options: `jive init` and
 * `jive load` write them into each repository's `core.sshCommand`, and `jive ssh connect` passes them to ssh. ssh-keygen
 * takes the agent's socket as SSH_AUTH_SOCK: `jive-ssh-keygen` (git's `gpg.ssh.program`) and `jive ssh sign` set it.
 */

/** ssh's options that make it authenticate with the account key through the agent, and offer no other key. */
function sshOptions({ homeDirectory, publicKeyFile }: { readonly homeDirectory: string; readonly publicKeyFile: string }) {
  return [
    { name: "IdentityAgent", value: jiveHomePaths(homeDirectory).agentSocket },
    { name: "IdentityFile", value: publicKeyFile },
    { name: "IdentitiesOnly", value: "yes" },
  ];
}

/** The options as ssh's own arguments, for running ssh directly. */
export function sshArgumentsThroughAgent(input: { readonly homeDirectory: string; readonly publicKeyFile: string }): ReadonlyArray<string> {
  return sshOptions(input).flatMap(({ name, value }) => ["-o", `${name}=${value}`]);
}

/** The same options as one `ssh` command line, for git's `core.sshCommand`, which git runs through a shell. */
export function sshCommandLineThroughAgent(input: { readonly homeDirectory: string; readonly publicKeyFile: string }): string {
  const quoted = (value: string) => /^\w+$/.test(value) ? value : JSON.stringify(value);
  return ["ssh", ...sshOptions(input).map(({ name, value }) => `-o ${name}=${quoted(value)}`)].join(" ");
}

/** ssh-keygen's environment: `inherited`, with SSH_AUTH_SOCK naming the agent's socket. */
export function sshKeygenEnvironmentThroughAgent({ inherited, homeDirectory }: {
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): Record<string, string | undefined> {
  return { ...inherited, SSH_AUTH_SOCK: jiveHomePaths(homeDirectory).agentSocket };
}
