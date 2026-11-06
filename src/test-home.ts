import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
Object.assign(process.env, {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  ZDOTDIR: home,
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
