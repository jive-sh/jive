import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";

import { rootCommands } from "@/commands";
import { CLI_NAME, CLI_VERSION } from "./common/consts";

const topLevelCommand = Command
  .make(CLI_NAME, {}, () => Console.log(`Use --help to explore ${CLI_NAME} commands.`))
  .pipe(Command.withDescription(`${CLI_NAME} CLI root command.`))
  .pipe(Command.withSubcommands(rootCommands));

const cli = Command.run(topLevelCommand, {
  name: CLI_NAME,
  version: CLI_VERSION
});

cli(process.argv)
  .pipe(
    Effect.provide(NodeContext.layer),
    NodeRuntime.runMain
  );
