import * as e from "effect";
import * as modules from "@/modules";
import { prettyList } from "@/logging";
import type { GithubAccessToken } from "@/modules/github/interface";

export const warnOnInaccessibleRepos = e.Effect.fn(function*(accessToken: GithubAccessToken) {
  const git = yield* modules.IGit;
  const github = yield* modules.IGitHub;

  const inaccessibleRepos: Record<string, {missingPermissions: string[];}> = {};
  const repos = yield* git.getSubmodules;

  for (const repo of repos) {
    const missingPermissions: string[] = [];
    const canRead = yield* github.canReadFromRemote(repo, accessToken);
    const canWrite = yield* github.canWriteToRemote(repo, accessToken);
    if (!canRead) missingPermissions.push("read");
    if (!canWrite) missingPermissions.push("write");
    inaccessibleRepos[repo.toString()] = {missingPermissions};
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
});
