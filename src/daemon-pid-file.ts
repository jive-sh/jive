import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * How each jive daemon keeps to one per person when several copies of jive are installed, each registering its own:
 * the first records its pid, and a later one that finds that pid alive stands down.
 */

/** The live daemon the pidfile names, unless it is this process. */
function incumbentPid(pidFile: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
    if (!Number.isInteger(pid) || pid === process.pid) return undefined;
    // Signal 0 sends nothing; it only asks whether the process exists.
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * Exits when another daemon already serves `served`, from a second installed copy of jive. Exiting zero is what keeps
 * the service manager from restarting this one forever, and it happens before anything could remove the incumbent's
 * socket.
 */
export function standDownIfAnotherServes(input: { readonly daemonName: string; readonly pidFile: string; readonly served: string }): void {
  const incumbent = incumbentPid(input.pidFile);
  if (incumbent === undefined) return;
  process.stderr.write(`${input.daemonName} ${incumbent} already serves ${input.served}; standing down\n`);
  process.exit(0);
}

/** Records this process in the pidfile, and removes the record when it exits if it is still this process's. */
export function holdPidFile(pidFile: string): void {
  mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile, String(process.pid));
  process.on("exit", () => {
    // Only this daemon's own pidfile: a later daemon may have written its own after this one stood down.
    try {
      if (readFileSync(pidFile, "utf-8") === String(process.pid)) rmSync(pidFile);
    } catch {}
  });
}
