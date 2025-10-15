import { Command } from "@effect/cli";
import { Console } from "effect";

import { pending } from "@/common/utils";

const updateRepoCommand = Command
  .make("repo", {}, () => pending("update repo metadata."))
  .pipe(Command.withDescription("Update repositories managed by Jive."));

const updatePluginCommand = Command
  .make("plugin", {}, () => pending("update plugins."))
  .pipe(Command.withDescription("Update plugins managed by Jive."));

export const updateCommand = Command
  .make("update", {}, () => Console.log("Select a subcommand to update repos or plugins."))
  .pipe(Command.withDescription("Update repos or plugins."))
  .pipe(Command.withSubcommands([updateRepoCommand, updatePluginCommand]));
