import { spawnSync } from "node:child_process";

/**
 * Only refuses. jive 0.7.0 set git's `gpg.ssh.program` to this command; 0.8.0 signs through `jive-ssh-sign`, so a
 * repository configured by 0.7.0 gets this message instead of git's `cannot exec … No such file or directory`, naming
 * the fix. There is no fallback to signing: `jive init` rewrites the repository's git config.
 */

const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const repository = topLevel.status === 0 && topLevel.stdout.trim() !== "" ? topLevel.stdout.trim() : "this repository";
process.stderr.write(`jive-ssh-keygen was replaced by jive-ssh-sign in jive 0.8.0; run jive init in ${repository} to update its git config\n`);
process.exit(1);
