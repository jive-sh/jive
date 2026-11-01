import { homedir } from "node:os";
import { jiveHomePaths } from "@/jive-home";

/**
 * What git runs to sign (`gpg.ssh.program`): ssh-keygen with its arguments untouched, pointed at the signing agent,
 * so `ssh-keygen -Y sign -f <account.pub>` asks the agent, which asks the server. Its exit code is ssh-keygen's.
 */
const result = Bun.spawnSync(["ssh-keygen", ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, SSH_AUTH_SOCK: jiveHomePaths(homedir()).agentSocket },
});

process.exit(result.exitCode ?? 1);
