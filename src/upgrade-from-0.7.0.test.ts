import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";

/**
 * Upgrading a machine that runs jive 0.7.0, whose `jive-signing-agent` and `jive-extension-daemon` are registered and
 * running, to this version: the built installer (`dist/base/install.cjs`, from `bun run jive:cicd:build`) runs in a
 * scratch install of this package with HOME in the scratch directory. It must remove both old registrations, stopping
 * their daemons, and register `jive-daemon`, which must then serve both sockets rather than stand down.
 *
 * The service manager is a fake on PATH (`launchctl`, and `systemctl` on Linux) that starts this repository's
 * `jive-daemon` from source when asked to start the new unit, and answers a stop by sending SIGTERM and returning
 * before the daemon has exited, as launchd's `bootout` does. The old daemons are stand-ins that take 1.5 seconds to
 * exit after SIGTERM and write the pidfiles 0.7.0's did. Nothing reaches the real launchd, systemd or ~/.jive.
 */

const installer = path.join(import.meta.dir, "..", "dist", "base", "install.cjs");
const built = existsSync(installer);
if (!built && process.env["CI"] !== undefined) throw new Error(`${installer} is missing: CI runs the build before this test`);

// Short: the daemon's socket paths must stay under macOS's 104-byte limit.
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "ju-")));
const home = path.join(scratch, "h");
const paths = jiveHomePaths(home);
const fakeBin = path.join(scratch, "fake-bin");
const services = path.join(scratch, "services");
const serviceLog = path.join(scratch, "service-calls.log");
const packageDir = path.join(scratch, "install", "node_modules", "@jive-sh", "jive");
const started: Array<{ readonly label: string; readonly kill: () => void; readonly exited: Promise<number> }> = [];

afterAll(async () => {
  // Every daemon the fake service manager started, by the pid it recorded, then the stand-ins.
  for (const entry of existsSync(services) ? readdirSync(services) : []) {
    if (!entry.endsWith(".pid")) continue;
    const pid = Number.parseInt(readFileSync(path.join(services, entry), "utf8"), 10);
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  for (const oldDaemon of started) oldDaemon.kill();
  await Promise.all(started.map((oldDaemon) => oldDaemon.exited));
  rmSync(scratch, { recursive: true, force: true });
});

/** One script answering as `launchctl`, `systemctl` and `loginctl`, by the name it was run as. */
const FAKE_SERVICE_MANAGER = `#!/bin/sh
echo "$(basename "$0") $*" >> "$FAKE_SERVICE_LOG"
start() { sh -c "$FAKE_DAEMON_COMMAND" < /dev/null >> "$FAKE_SERVICES/$1.log" 2>&1 & echo $! > "$FAKE_SERVICES/$1.pid"; }
stop() { if [ -f "$FAKE_SERVICES/$1.pid" ]; then kill -TERM "$(cat "$FAKE_SERVICES/$1.pid")" 2>/dev/null; rm -f "$FAKE_SERVICES/$1.pid"; fi; }
case "$(basename "$0") $1" in
  "launchctl bootout") stop "\${2##*/}" ;;
  "launchctl bootstrap") start "$(basename "$3" .plist)" ;;
  "systemctl --user")
    case "$2" in
      restart) start "\${3%.service}" ;;
      disable) stop "\${4%.service}" ;;
    esac ;;
esac
exit 0
`;

/** What 0.7.0 left in ~/.jive/daemons for one daemon, with the unregister argv its installer recorded. */
function oldRegistration(name: string) {
  const label = `jive-daemon.jive-sh.jive.${name}.0000000000`;
  const plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  writeFileSync(plist, "<plist/>\n");
  writeFileSync(path.join(home, ".jive", "daemons", `${label}.json`), `${JSON.stringify({
    id: label, name, packageName: "@jive-sh/jive", packageDir, workingDirectory: path.dirname(packageDir),
    executable: path.join(packageDir, "bin", name), files: [plist], kind: "launchd", unit: label,
    unregister: ["launchctl", "bootout", `gui/501/${label}`],
  }, null, 2)}\n`);
  return { label, plist };
}

/** A running 0.7.0 daemon: it holds its pidfile, and exits 1.5 seconds after SIGTERM. */
function startOldDaemon({ label, pidFile }: { readonly label: string; readonly pidFile: string }) {
  const child = Bun.spawn([process.execPath, "-e", [
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
    "process.on(\"SIGTERM\", () => setTimeout(() => process.exit(0), 1500));",
  ].join("\n")], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  writeFileSync(path.join(services, `${label}.pid`), String(child.pid));
  started.push({ label, kill: () => child.kill("SIGKILL"), exited: child.exited });
  return child;
}

async function waitFor(input: { readonly probe: () => boolean; readonly what: string }): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (input.probe()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${input.what}`);
}

test.skipIf(!built)("installing over 0.7.0 stops and unregisters jive-signing-agent and jive-extension-daemon, and jive-daemon starts and serves both sockets", async () => {
  // This package installed where 0.7.0 was: the built installer, and the platform package the build installed.
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  copyFileSync(installer, path.join(packageDir, "install.cjs"));
  copyFileSync(path.join(path.dirname(installer), "package.json"), path.join(packageDir, "package.json"));
  copyFileSync(path.join(path.dirname(installer), "bin", "package.json"), path.join(packageDir, "bin", "package.json"));
  const builtPackages = path.join(import.meta.dir, "..", "node_modules", "@jive-sh");
  for (const entry of readdirSync(builtPackages).filter((name) => /^jive-(darwin|linux|windows)-/.test(name))) {
    symlinkSync(path.join(builtPackages, entry), path.join(path.dirname(packageDir), entry));
  }
  for (const directory of [fakeBin, services, path.join(home, ".jive", "daemons"), path.join(home, "Library", "LaunchAgents")]) mkdirSync(directory, { recursive: true });
  for (const name of ["launchctl", "systemctl", "loginctl"]) writeFileSync(path.join(fakeBin, name), FAKE_SERVICE_MANAGER, { mode: 0o755 });

  const signingAgent = oldRegistration("jive-signing-agent");
  const extensionDaemon = oldRegistration("jive-extension-daemon");
  const oldSigningAgent = startOldDaemon({ label: signingAgent.label, pidFile: paths.agentPidFile });
  const oldExtensionDaemon = startOldDaemon({ label: extensionDaemon.label, pidFile: paths.extensionDaemonPidFile });
  await waitFor({ probe: () => existsSync(paths.agentPidFile) && existsSync(paths.extensionDaemonPidFile), what: "the 0.7.0 daemons to write their pidfiles" });

  const environment: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    ZDOTDIR: home,
    PATH: `${fakeBin}${path.delimiter}${process.env["PATH"]}`,
    FAKE_SERVICE_LOG: serviceLog,
    FAKE_SERVICES: services,
    FAKE_DAEMON_COMMAND: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dir, "daemons", "jive-daemon.ts"))}`,
  };
  // The installer skips registering in CI, as a build agent's install should; this test is the person's machine.
  delete environment["CI"];
  const install = Bun.spawn([process.execPath, path.join(packageDir, "install.cjs")], { cwd: packageDir, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [installOutput, installErrors, installExit] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
  expect({ installExit, installErrors }).toEqual({ installExit: 0, installErrors: expect.not.stringContaining("failed") });
  expect(installOutput).toContain(`Removing daemon ${signingAgent.label}`);
  expect(installOutput).toContain(`Removing daemon ${extensionDaemon.label}`);

  // Both old registrations are gone, and their daemons were told to stop and did.
  const calls = readFileSync(serviceLog, "utf8");
  expect(calls).toContain(`launchctl bootout gui/501/${signingAgent.label}`);
  expect(calls).toContain(`launchctl bootout gui/501/${extensionDaemon.label}`);
  expect(await oldSigningAgent.exited).toBe(0);
  expect(await oldExtensionDaemon.exited).toBe(0);
  const records = readdirSync(path.join(home, ".jive", "daemons"));
  expect(records.filter((record) => record.includes("jive-signing-agent") || record.includes("jive-extension-daemon"))).toEqual([]);
  expect(existsSync(signingAgent.plist) || existsSync(extensionDaemon.plist)).toBe(false);

  // jive-daemon is registered for this install and, once the old daemons have gone, serves both sockets.
  const newRecords = records.filter((record) => record.startsWith("jive-daemon.jive-sh.jive.jive-daemon."));
  expect(newRecords).toHaveLength(1);
  const record = JSON.parse(readFileSync(path.join(home, ".jive", "daemons", newRecords[0]!), "utf8"));
  expect({ name: record.name, executable: record.executable }).toEqual({ name: "jive-daemon", executable: path.join(packageDir, "bin", "jive-daemon") });
  const newLabel = newRecords[0]!.replace(/\.json$/, "");
  await waitFor({ probe: () => existsSync(paths.daemonSocket) && existsSync(paths.agentSocket), what: "jive-daemon to serve both sockets" });
  const newPid = Number.parseInt(readFileSync(path.join(services, `${newLabel}.pid`), "utf8"), 10);
  expect(readFileSync(paths.daemonPidFile, "utf8")).toBe(String(newPid));
  expect(readFileSync(path.join(services, `${newLabel}.log`), "utf8")).not.toContain("standing down");
}, 60_000);

test("a 0.7.0 daemon still running after the wait makes jive-daemon stand down, exiting zero", async () => {
  const pidFile = path.join(scratch, "still-running.pid");
  // This test process stands in for the 0.7.0 daemon that never exits.
  writeFileSync(pidFile, String(process.pid));
  const startedAt = Date.now();
  const child = Bun.spawn([process.execPath, "-e", [
    `const { standDownIfStillServedAfter } = require(${JSON.stringify(path.join(import.meta.dir, "daemon-pid-file.ts"))});`,
    `standDownIfStillServedAfter({ daemonName: "jive-signing-agent", pidFile: ${JSON.stringify(pidFile)}, served: "the agent socket", waitMs: 500 });`,
    "console.log(\"did not stand down\");",
  ].join("\n")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: `jive-signing-agent ${process.pid} already serves the agent socket; standing down\n` });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
});
