import { Command } from "@effect/cli";
import { Console } from "effect";

import { ArgOrgRepoName } from "@/arguments";
import { pending } from "@/common/utils";

const linkRepoCommand = Command
  .make("repo", { repo: ArgOrgRepoName }, ({ repo }) => pending(`link repo "${repo}".`))
  .pipe(Command.withDescription("Link a repo into the current workspace."));

export const linkCommand = Command
  .make("link", {}, () => Console.log("Select a subcommand to link resources."))
  .pipe(Command.withDescription("Link remote resources into the workspace."))
  .pipe(Command.withSubcommands([linkRepoCommand]));
