import * as e from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { OSPlatformImpl, exitWhenUninstalled } from "jive-abstract-library";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { jiveHomePaths } from "@/jive-home";
import { SigningAgentLayer } from "@/modules/runtime";
import { serveSigningAgent } from "@/modules/signing-agent/socket-server";

/**
 * The SSH agent git and ssh reach through the config `jive init` and `jive load` write. It holds no key: each sign request goes to
 * `@jive-sh/server`, which signs with the account's key given this machine's session. Starts at login.
 */

const paths = jiveHomePaths(homedir());

/**
 * Another agent already serving the socket, from a second installed copy of jive. Exiting zero is what keeps the
 * service manager from restarting this one forever, and it happens before anything here could remove the
 * incumbent's socket.
 */
function incumbentAgentPid(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(paths.agentPidFile, "utf-8"), 10);
    if (!Number.isInteger(pid) || pid === process.pid) return undefined;
    // Signal 0 sends nothing; it only asks whether the process exists.
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

const incumbent = incumbentAgentPid();
if (incumbent !== undefined) {
  process.stderr.write(`jive-signing-agent ${incumbent} already serves ${paths.agentSocket}; standing down\n`);
  process.exit(0);
}

// Takes this daemon's registration away with it if this copy of jive is ever uninstalled.
exitWhenUninstalled();

mkdirSync(paths.jiveHome, { recursive: true, mode: 0o700 });
writeFileSync(paths.agentPidFile, String(process.pid));
process.on("exit", () => {
  // Only this agent's own pidfile: a later agent may have written its own after this one stood down.
  try {
    if (readFileSync(paths.agentPidFile, "utf-8") === String(process.pid)) rmSync(paths.agentPidFile);
  } catch {}
});

BunRuntime.runMain(e.pipe(
  serveSigningAgent(paths.agentSocket),
  e.Effect.andThen(e.Effect.never),
  e.Effect.scoped,
  e.Effect.provide(SigningAgentLayer),
  e.Effect.provide(OSPlatformImpl.Layer),
  e.Effect.provide(BunServices.layer),
));
