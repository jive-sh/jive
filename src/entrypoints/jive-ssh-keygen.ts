import { homedir } from "node:os";
import { sshKeygenEnvironmentThroughAgent } from "@/modules/signing-agent/ssh-clients";

/**
 * What git runs to sign (`gpg.ssh.program`): ssh-keygen with its arguments untouched, pointed at the signing agent,
 * so `ssh-keygen -Y sign -f <account.pub>` asks the agent, which asks the server. Its exit code is ssh-keygen's.
 */
const result = Bun.spawnSync(["ssh-keygen", ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: sshKeygenEnvironmentThroughAgent({ inherited: process.env, homeDirectory: homedir() }),
});

process.exit(result.exitCode ?? 1);
