import { Layer } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { BunImpl } from "./bun/impl";
import { DaemonImpl } from "./daemon/impl";
import { GitImpl } from "./git/impl";
import { TemplatesImpl } from "./templates/impl";
import { ToolStateImpl } from "./tool-state/impl";

const ToolStateWithDependenciesLive = Layer.provide(ToolStateImpl, NodeFileSystem.layer);
const CoreModuleDependenciesLive = Layer.mergeAll(NodeFileSystem.layer, ToolStateWithDependenciesLive);

const BunWithDependenciesLive = Layer.provide(BunImpl, CoreModuleDependenciesLive);
const GitWithDependenciesLive = Layer.provide(GitImpl, CoreModuleDependenciesLive);
const TemplatesWithDependenciesLive = Layer.provide(TemplatesImpl, CoreModuleDependenciesLive);

export const ModuleDependenciesLive = Layer.mergeAll(
  CoreModuleDependenciesLive,
  BunWithDependenciesLive,
  DaemonImpl,
  GitWithDependenciesLive,
  TemplatesWithDependenciesLive,
);
