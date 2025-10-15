import { Command } from "@effect/cli";
import { Console } from "effect";

import { ArgOrgRepoName } from "@/arguments";
import { pending } from "@/common/utils";

const unlinkRepoCommand = Command
  .make("repo", { repo: ArgOrgRepoName }, ({ repo }) => pending(`unlink repo "${repo}".`))
  .pipe(Command.withDescription("Remove a repo link from the current workspace."));

export const unlinkCommand = Command
  .make("unlink", {}, () => Console.log("Select a subcommand to unlink resources."))
  .pipe(Command.withDescription("Remove linked resources from the workspace."))
  .pipe(Command.withSubcommands([unlinkRepoCommand]));
