import * as e from "effect";
import { BadArgumentError, BadPreconditionsError, Module, modules } from "@/modules";
import type { GithubAccessToken } from "@/modules/github/interface";
import type { GenEffect } from "@/temp-libs/effective-modules";

export function* warnOnInaccessibleRepos(accessToken: GithubAccessToken): GenEffect<void, BadArgumentError | BadPreconditionsError, Module.git | Module.github> {
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
