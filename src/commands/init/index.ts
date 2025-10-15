import { Command } from "@effect/cli";

import { pending } from "@/common/utils";

export const initCommand = Command
  .make("init", {}, () => pending("initialize a new workspace."))
  .pipe(Command.withDescription("Initialize a new Jive workspace."));
