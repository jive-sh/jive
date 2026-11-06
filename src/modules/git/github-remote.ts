import * as e from "effect";
import { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

/**
 * GitHub's remote URLs, for `.gitmodules` and for recognising a submodule's repo. Every GitHub URL jive writes is the
 * https one; `url."git@github.com:".insteadOf "https://github.com/"` in each repository's config makes git fetch and
 * push it over SSH, through the signing agent.
 */

export const GITHUB_HTTPS = "https://github.com/";
export const GITHUB_SSH = "git@github.com:";

export const githubHttpsUrl = (repo: RepoIdentifier): string => `${GITHUB_HTTPS}${repo.org}/${repo.repo}`;

/** https://github.com/o/r, git@github.com:o/r and ssh://git@github.com/o/r, each with or without `.git`. */
const GITHUB_REMOTE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/** The GitHub repo a remote URL names; none for any other host. */
export const repoOfGitHubRemote = (url: string): e.Option.Option<RepoIdentifier> => {
  const match = GITHUB_REMOTE.exec(url.trim());
  return match === null ? e.Option.none() : e.Option.some(new RepoIdentifier(match[1]!, match[2]!));
};
