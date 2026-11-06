import * as e from "effect";
import type { Module } from "@/modules";
import type { JiveHomePaths } from "@/jive-home";
import { registerNativeHost } from "./native-messaging/host-registration";
import { serveExtensionDaemon } from "./socket-server";

/**
 * Starts the extension daemon: registers the native host with Chrome in `manifestDirs`, then answers the extension on
 * the daemon's socket until the scope closes. The daemon entrypoint and the tests each choose the directories.
 */
export const runExtensionDaemon = (input: {
  readonly paths: JiveHomePaths;
  readonly manifestDirs: ReadonlyArray<string>;
}): e.Effect.Effect<void, string, Module.extensionDaemon | e.FileSystem.FileSystem | e.Scope.Scope> =>
  e.Effect.gen(function* () {
    const fs = yield* e.FileSystem.FileSystem;
    yield* e.pipe(
      fs.makeDirectory(input.paths.jiveHome, { recursive: true, mode: 0o700 }),
      e.Effect.mapError((error) => `could not create ${input.paths.jiveHome}: ${error.message}`),
    );
    const registered = yield* registerNativeHost({ paths: input.paths, manifestDirs: input.manifestDirs });
    yield* e.Effect.log(registered.length === 0
      ? `No Chrome or Chromium found in ${input.manifestDirs.join(", ") || "(no directories for this OS)"}; the Jive extension can't reach this daemon`
      : `Native host registered for the Jive extension in ${registered.join(", ")}`);
    yield* serveExtensionDaemon(input.paths.extensionDaemonSocket);
  });
