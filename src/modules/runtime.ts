import * as e from "effect";
import { OSPlatformImpl } from "jive-abstract-library";
import { AuthImpl } from "./auth/impl";
import { BunImpl } from "./bun/impl";
import { DaemonImpl } from "./daemon/impl";
import { GitImpl } from "./git/impl";
import { GithubImpl } from "./github/impl";
import { NpmImpl } from "./npm/impl";
import { SshImpl } from "./ssh/impl";
import { TemplatesImpl } from "./templates/impl";
import { ToolStateImpl } from "./tool-state/impl";
import { YubiKeyImpl } from "./yubikey/impl";

/**
 * Every module jive owns, composed most-dependent first. What is left for the entrypoint to provide is the
 * host's own services (the filesystem, paths and the terminal), which `BunServices.layer` gives.
 */
export const ModulesLayer = e.pipe(
  AuthImpl.Layer,
  e.Layer.provideMerge(BunImpl.Layer),
  e.Layer.provideMerge(GitImpl.Layer),
  e.Layer.provideMerge(GithubImpl.Layer),
  e.Layer.provideMerge(SshImpl.Layer),
  e.Layer.provideMerge(YubiKeyImpl.Layer),
  e.Layer.provideMerge(ToolStateImpl.Layer),
  e.Layer.provideMerge(DaemonImpl.Layer),
  e.Layer.provideMerge(NpmImpl.Layer),
  e.Layer.provideMerge(TemplatesImpl.Layer),
  e.Layer.provideMerge(OSPlatformImpl.Layer),
);
