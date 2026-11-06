import * as e from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { OSPlatformImpl, exitWhenUninstalled } from "jive-abstract-library";
import { homedir } from "node:os";
import { holdPidFile, standDownIfAnotherServes } from "@/daemon-pid-file";
import { jiveHomePaths } from "@/jive-home";
import { SigningAgentLayer } from "@/modules/runtime";
import { serveSigningAgent } from "@/modules/signing-agent/socket-server";

/**
 * The SSH agent git and ssh reach through the config `jive init` and `jive load` write. It holds no key: each sign request goes to
 * `@jive-sh/server`, which signs with the account's key given this machine's session. Starts at login.
 */

const paths = jiveHomePaths(homedir());

standDownIfAnotherServes({ daemonName: "jive-signing-agent", pidFile: paths.agentPidFile, served: paths.agentSocket });

// Takes this daemon's registration away with it if this copy of jive is ever uninstalled.
exitWhenUninstalled();

holdPidFile(paths.agentPidFile);

BunRuntime.runMain(e.pipe(
  serveSigningAgent(paths.agentSocket),
  e.Effect.andThen(e.Effect.never),
  e.Effect.scoped,
  e.Effect.provide(SigningAgentLayer),
  e.Effect.provide(OSPlatformImpl.Layer),
  e.Effect.provide(BunServices.layer),
));
