import * as e from "effect";
import * as epn from "@effect/platform-node";
import * as modules from "./index";
import { PlainTextLogger } from "@/logging";
import type { BadPreconditionsError } from "@/modules";

export const ModulesImpl = e.pipe(
  // Custom modules
  modules.AuthImpl,
  e.Layer.provideMerge(modules.BunImpl),
  e.Layer.provideMerge(modules.DaemonImpl),
  e.Layer.provideMerge(modules.GitImpl),
  e.Layer.provideMerge(modules.GitHubImpl),
  e.Layer.provideMerge(modules.SshImpl),
  e.Layer.provideMerge(modules.NpmImpl),
  e.Layer.provideMerge(modules.TemplatesImpl),
  e.Layer.provideMerge(modules.YubiKeyImpl),
  e.Layer.provideMerge(modules.HostShellImpl),
  e.Layer.provideMerge(modules.ToolStateImpl),
  // System
  e.Layer.provideMerge(epn.NodeCommandExecutor.layer),
  e.Layer.provideMerge(epn.NodeFileSystem.layer),
  e.Layer.provideMerge(PlainTextLogger),
) satisfies e.Layer.Layer<any, BadPreconditionsError, never>;
