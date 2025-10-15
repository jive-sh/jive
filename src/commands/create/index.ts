import { Command } from "@effect/cli";

import { ArgOrgRepoName, ArgTemplateName } from "@/arguments";
import { pending } from "@/common/utils";

export const createCommand = Command
  .make("create", { template: ArgTemplateName, repo: ArgOrgRepoName }, ({ template, repo }) =>
    pending(`create repo "${repo}" from template "${template}".`)
  )
  .pipe(Command.withDescription("Create a new repo from a template."));
