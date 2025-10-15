import { Command } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import * as packageJSON from "../package.json";
import { Schema } from "effect";

const onCommand = Command.make("on")

const loadCommand = Command.make("load");

const unloadCommand = Command.make("unload");

const templatizeCommand = Command.make("templatize");

const createCommand = Command.make("create");

const initCommand = Command.make("init");

const updateCommand = Command.make("update");

const userCommand = Command.make("user");

const topLevelCommandName = Schema.decodeUnknownSync(Schema.String)(Object.keys(packageJSON.bin).pop());

const topLevelCommand = Command.make(topLevelCommandName, {}, () =>
  Console.log("Hello World")
).pipe(Command.withSubcommands([
  onCommand,
  loadCommand,
  unloadCommand,
  templatizeCommand,
  createCommand,
  initCommand,
  updateCommand,
  userCommand
]));

const cli = Command.run(topLevelCommand, {
  name: packageJSON.name,
  version: `v${packageJSON.version}`
});

cli(process.argv)
  .pipe(
    Effect.provide(NodeContext.layer),
    NodeRuntime.runMain
  );