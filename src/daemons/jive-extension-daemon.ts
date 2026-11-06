import * as e from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { OSPlatform, OSPlatformImpl, exitWhenUninstalled } from "jive-abstract-library";
import { homedir } from "node:os";
import { EXTENSION_DAEMON_NAME } from "@/constants";
import { holdPidFile, standDownIfAnotherServes } from "@/daemon-pid-file";
import { jiveHomePaths } from "@/jive-home";
import { defaultNativeMessagingDirs } from "@/modules/extension-daemon/native-messaging/host-registration";
import { runExtensionDaemon } from "@/modules/extension-daemon/run";
import { ExtensionDaemonLayer } from "@/modules/runtime";

/**
 * Answers the Jive browser extension (`src/modules/extension-daemon/protocol.ts`), which reaches it through Chrome
 * native messaging and `jive-native-host`. It holds no session of its own: it reads and writes the one `jive login`
 * keeps, signs in through the same sign-in request when the extension asks, and posts what the extension collects to
 * Jive with it. The session never passes through the extension or the browser. Starts at login.
 */

const paths = jiveHomePaths(homedir());

standDownIfAnotherServes({ daemonName: EXTENSION_DAEMON_NAME, pidFile: paths.extensionDaemonPidFile, served: paths.extensionDaemonSocket });

// Takes this daemon's registration away with it if this copy of jive is ever uninstalled.
exitWhenUninstalled();

holdPidFile(paths.extensionDaemonPidFile);

BunRuntime.runMain(e.pipe(
  e.Effect.gen(function* () {
    const osPlatform = yield* OSPlatform;
    const { os } = yield* osPlatform.getCurrentPlatform();
    const manifestDirs = defaultNativeMessagingDirs({ homeDirectory: yield* osPlatform.getHomeDirectory(), os });
    yield* runExtensionDaemon({ paths, manifestDirs });
  }),
  e.Effect.andThen(e.Effect.never),
  e.Effect.scoped,
  e.Effect.provide(ExtensionDaemonLayer),
  e.Effect.provide(OSPlatformImpl.Layer),
  e.Effect.provide(BunServices.layer),
));
