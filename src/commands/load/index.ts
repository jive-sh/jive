import { Command } from "@effect/cli";
import { Console } from "effect";

import { ArgOrgRepoName, ArgPluginName } from "@/arguments";
import { pending } from "@/common/utils";

const loadRepoCommand = Command
  .make("repo", { repo: ArgOrgRepoName }, ({ repo }) => pending(`load repo "${repo}" into the workspace.`))
  .pipe(Command.withDescription("Load a repo into the workspace."));

const loadPluginCommand = Command
  .make("plugin", { plugin: ArgPluginName }, ({ plugin }) => pending(`load plugin "${plugin}".`))
  .pipe(Command.withDescription("Load a plugin for the workspace."));

export const loadCommand = Command
  .make("load", {}, () => Console.log("Select a subcommand to load repos or plugins."))
  .pipe(Command.withDescription("Load repos or plugins into the workspace."))
  .pipe(Command.withSubcommands([loadRepoCommand, loadPluginCommand]));
