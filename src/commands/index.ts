import { createCommand } from "./create";
import { initCommand } from "./init";
import { linkCommand } from "./link";
import { loadCommand } from "./load";
import { onCommand } from "./on";
import { templatizeCommand } from "./templatize";
import { unlinkCommand } from "./unlink";
import { unloadCommand } from "./unload";
import { updateCommand } from "./update";
import { userCommand } from "./user";

export const rootCommands = [
  onCommand,
  linkCommand,
  unlinkCommand,
  loadCommand,
  unloadCommand,
  templatizeCommand,
  createCommand,
  initCommand,
  updateCommand,
  userCommand
] as const;

export type RootCommand = (typeof rootCommands)[number];
