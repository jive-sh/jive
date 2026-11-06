import * as e from "effect";
import * as path from "node:path";
import { EXTENSION_DAEMON_NAME, NATIVE_HOST_COMMAND_NAME, installedCommandPath } from "@/constants";
import type { JiveHomePaths } from "@/jive-home";
import { EXTENSION_PUBLIC_KEY, NATIVE_HOST_NAME } from "../protocol";
import { extensionIdOf } from "./extension-id";

/**
 * Tells Chrome where the native host is, so the extension's `connectNative` starts it. Chrome reads one manifest
 * per host from a per-user directory and runs its `path` with no shell and a minimal PATH, allowing only the
 * origins it lists (https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location).
 * The extension daemon writes it at every start, so installing, moving or upgrading jive needs no step of its own.
 */

/** The per-user manifest directories of Google Chrome and Chromium on this OS; none on others yet. */
export function defaultNativeMessagingDirs(input: { readonly homeDirectory: string; readonly os: string }): ReadonlyArray<string> {
  if (input.os === "darwin") {
    return ["Google/Chrome", "Chromium"].map((browser) => path.join(input.homeDirectory, "Library", "Application Support", browser, "NativeMessagingHosts"));
  }
  if (input.os === "linux") {
    return ["google-chrome", "chromium"].map((browser) => path.join(input.homeDirectory, ".config", browser, "NativeMessagingHosts"));
  }
  // Windows registers hosts in the registry, which is not done yet.
  return [];
}

/**
 * The executable Chrome should start. Installed, every jive command is the same multi-call binary under its command's
 * name (jive-abstract-library's build), so the native host is `jive-native-host` beside the running daemon. Run from
 * source (`bun src/daemons/jive-extension-daemon.ts`), there is no such binary, so the daemon writes a launcher that
 * runs the native host's source with the same bun.
 */
function nativeHostExecutable(paths: JiveHomePaths): e.Effect.Effect<string, string, e.FileSystem.FileSystem> {
  return e.Effect.gen(function* () {
    if (path.basename(process.execPath).startsWith(EXTENSION_DAEMON_NAME)) {
      return installedCommandPath(process.execPath, NATIVE_HOST_COMMAND_NAME);
    }
    const fs = yield* e.FileSystem.FileSystem;
    const source = path.join(import.meta.dir, "..", "..", "..", "entrypoints", `${NATIVE_HOST_COMMAND_NAME}.ts`);
    const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
    const launcher = paths.nativeHostLauncherFromSource;
    yield* e.pipe(
      fs.writeFileString(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} "$@"\n`),
      e.Effect.andThen(fs.chmod(launcher, 0o700)),
      e.Effect.mapError((error) => `could not write ${launcher}: ${error.message}`),
    );
    return launcher;
  });
}

/** Writes this host's manifest into each directory whose browser is installed (its parent exists). Returns where it wrote. */
export function registerNativeHost(input: {
  readonly paths: JiveHomePaths;
  readonly manifestDirs: ReadonlyArray<string>;
}): e.Effect.Effect<ReadonlyArray<string>, string, e.FileSystem.FileSystem> {
  return e.Effect.gen(function* () {
    const fs = yield* e.FileSystem.FileSystem;
    const executable = yield* nativeHostExecutable(input.paths);
    const manifest = JSON.stringify({
      name: NATIVE_HOST_NAME,
      description: "jive-extension-daemon's relay for the Jive browser extension",
      path: executable,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionIdOf(EXTENSION_PUBLIC_KEY)}/`],
    }, null, 2);
    const written: Array<string> = [];
    for (const dir of input.manifestDirs) {
      const browserInstalled = yield* e.pipe(fs.exists(path.dirname(dir)), e.Effect.orElseSucceed(() => false));
      if (!browserInstalled) continue;
      const manifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`);
      yield* e.pipe(
        fs.makeDirectory(dir, { recursive: true }),
        e.Effect.andThen(fs.writeFileString(manifestPath, `${manifest}\n`)),
        e.Effect.mapError((error) => `could not write ${manifestPath}: ${error.message}`),
      );
      written.push(manifestPath);
    }
    return written;
  });
}
