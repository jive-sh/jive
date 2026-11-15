import * as e from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { OSPlatform, OSPlatformImpl, exitWhenUninstalled } from "jive-abstract-library";
import { homedir } from "node:os";
import { DAEMON_NAME } from "@/constants";
import { holdPidFile, standDownIfAnotherServes, standDownIfStillServedAfter } from "@/daemon-pid-file";
import { jiveHomePaths } from "@/jive-home";
import { defaultNativeMessagingDirs } from "@/modules/extension-daemon/native-messaging/host-registration";
import { runExtensionDaemon } from "@/modules/extension-daemon/run";
import { DaemonLayer } from "@/modules/runtime";
import { serveSigningAgent } from "@/modules/signing-agent/socket-server";

/**
 * The one Jive daemon. It serves the SSH agent socket (`~/.jive/signing-agent.sock`) and its own API socket
 * (`~/.jive/jive-daemon.sock`), which the Jive extension and jive's ssh wrappers ask, in this process, on one
 * session. It holds no key: signing goes to `@jive-sh/server` with this machine's session. Starts at login.
 *
 * A source run stands down when this pidfile, or an older `jive-signing-agent` or `jive-extension-daemon` pidfile,
 * names a live process, so it does not remove that process's socket.
 */

const paths = jiveHomePaths(homedir());
/** How long an upgrade gives the daemons jive 0.7.0 ran to exit after their registrations are removed. */
const LEGACY_DAEMON_EXIT_WAIT_MS = 10_000;

standDownIfAnotherServes({ daemonName: DAEMON_NAME, pidFile: paths.daemonPidFile, served: paths.agentSocket });
standDownIfStillServedAfter({ daemonName: "jive-signing-agent", pidFile: paths.agentPidFile, served: paths.agentSocket, waitMs: LEGACY_DAEMON_EXIT_WAIT_MS });
standDownIfStillServedAfter({ daemonName: "jive-extension-daemon", pidFile: paths.extensionDaemonPidFile, served: "the Jive extension", waitMs: LEGACY_DAEMON_EXIT_WAIT_MS });

// Takes this daemon's registration away with it if this copy of jive is ever uninstalled.
exitWhenUninstalled();

holdPidFile(paths.daemonPidFile);

BunRuntime.runMain(e.pipe(
  e.Effect.gen(function* () {
    const osPlatform = yield* OSPlatform;
    const { os } = yield* osPlatform.getCurrentPlatform();
    const manifestDirs = defaultNativeMessagingDirs({ homeDirectory: yield* osPlatform.getHomeDirectory(), os });
    yield* e.Effect.all([
      serveSigningAgent(paths.agentSocket),
      runExtensionDaemon({ paths, manifestDirs }),
    ], { concurrency: "unbounded" });
  }),
  e.Effect.andThen(e.Effect.never),
  e.Effect.scoped,
  e.Effect.provide(DaemonLayer),
  e.Effect.provide(OSPlatformImpl.Layer),
  e.Effect.provide(BunServices.layer),
));
