import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import { Module, modules } from "@/modules";
import type { GithubAccessToken } from "@/modules/github/interface";

export function* warnOnInaccessibleRepos(accessToken: GithubAccessToken): EffectGen<void, BadArgumentError | BadPreconditionsError, Module.git | Module.github> {
  const git = yield* modules.git;
  const github = yield* modules.github;

  const inaccessibleRepos: Record<string, {missingPermissions: string[];}> = {};
  const repos = yield* git.getSubmodules();

  for (const repo of repos) {
    const missingPermissions: string[] = [];
    const canRead = yield* github.canReadFromRemote(repo, accessToken);
    const canWrite = yield* github.canWriteToRemote(repo, accessToken);
    if (!canRead) missingPermissions.push("read");
    if (!canWrite) missingPermissions.push("write");
    if (missingPermissions.length > 0) {
      inaccessibleRepos[repo.toString()] = { missingPermissions };
    }
  }

  const sortedKeys = Object.keys(inaccessibleRepos).sort();

  if (sortedKeys.length > 0) {
    let list = "";
    for (const key of sortedKeys) {
      const { missingPermissions } = inaccessibleRepos[key]!;
      list += `\n- ${key} (${missingPermissions.join(", ")})`;
    }
    yield* e.Effect.logWarning(`Missing permissions on the following locally-cloned repos:\n${list}`);
  }
}
