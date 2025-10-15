import { Command } from "@effect/cli";

import { ArgOrgRepoName, ArgTemplateName } from "@/arguments";
import { pending } from "@/common/utils";

export const templatizeCommand = Command
  .make("templatize", { repo: ArgOrgRepoName, template: ArgTemplateName }, ({ repo, template }) =>
    pending(`templatize repo "${repo}" into template "${template}".`)
  )
  .pipe(Command.withDescription("Convert an existing repo into a reusable template."));
