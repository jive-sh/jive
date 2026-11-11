import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Preloaded before every test file (bunfig.toml): every process a test starts (bun install, git, ssh, the jive
 * entrypoint) gets a home inside this package's node_modules, never the person's own. A tool run under the real home
 * can read anything there, and on macOS that puts permission dialogs for Desktop, Documents and iCloud Drive on screen.
 * Bun reads HOME once at startup, so code running in the test process itself takes its home from the host layer the
 * test provides.
 */
const testHomes = path.join(import.meta.dir, "..", "node_modules", ".cache", "jive-test-home");
mkdirSync(testHomes, { recursive: true });
const home = mkdtempSync(path.join(testHomes, "home-"));
for (const directory of [".config", ".cache"]) mkdirSync(path.join(home, directory));
// A sign-in a broken build starts opens the jive.sh page with the platform's opener; these refuse instead, so no test
// puts a browser tab on the person's screen.
const refusingOpeners = path.join(home, "refusing-openers");
mkdirSync(refusingOpeners);
for (const opener of ["open", "xdg-open"]) {
  writeFileSync(path.join(refusingOpeners, opener), "#!/bin/sh\necho 'tests never open a browser' >&2\nexit 1\n", { mode: 0o755 });
}
Object.assign(process.env, {
  PATH: `${refusingOpeners}${path.delimiter}${process.env["PATH"]}`,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  ZDOTDIR: home,
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
