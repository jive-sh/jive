import { Command } from "@effect/cli";
import { Console } from "effect";

import { ArgOrgRepoName, ArgPluginName } from "@/arguments";
import { pending } from "@/common/utils";

const unloadRepoCommand = Command
  .make("repo", { repo: ArgOrgRepoName }, ({ repo }) => pending(`unload repo "${repo}".`))
  .pipe(Command.withDescription("Unload a repo from the workspace."));

const unloadPluginCommand = Command
  .make("plugin", { plugin: ArgPluginName }, ({ plugin }) => pending(`unload plugin "${plugin}".`))
  .pipe(Command.withDescription("Unload a plugin from the workspace."));

export const unloadCommand = Command
  .make("unload", {}, () => Console.log("Select a subcommand to unload repos or plugins."))
  .pipe(Command.withDescription("Unload repos or plugins from the workspace."))
  .pipe(Command.withSubcommands([unloadRepoCommand, unloadPluginCommand]));
