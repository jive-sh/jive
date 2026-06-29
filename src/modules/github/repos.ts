import * as e from "effect";
import type { RepoIdentifier } from "@/modules/tool-state/interface";
import type { GithubAccessToken } from "./interface";
import { fetchResponse, githubHeaders, parseJson } from "./shared";

const RepoWritePermissionsSchema = e.Schema.Struct({
  permissions: e.Schema.optional(
    e.Schema.Struct({
      admin: e.Schema.optional(e.Schema.Boolean),
      maintain: e.Schema.optional(e.Schema.Boolean),
      push: e.Schema.optional(e.Schema.Boolean),
    }),
  ),
});

type RepoWritePermissions = e.Schema.Schema.Type<typeof RepoWritePermissionsSchema>;

export const remoteRepos = (
  org: string,
  accessToken: e.Option.Option<GithubAccessToken>,
): e.Effect.Effect<string[]> => {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (e.Option.isSome(accessToken)) {
    headers.Authorization = `Bearer ${accessToken.value.accessToken}`;
  }

  const fetchRepoNames = (endpoint: string) =>
    e.pipe(
      fetchResponse(endpoint, { headers }),
      e.Effect.flatMap(response => {
        if (!response.ok) {
          return e.Effect.succeed(e.Option.none<string[]>());
        }

        return e.pipe(
          parseJson<Array<{ name?: string }>>(response),
          e.Effect.map(rows =>
            e.Option.some(
              rows
                .map(row => row.name)
                .filter((name): name is string => typeof name === "string" && name.length > 0),
            ),
          ),
        );
      }),
      e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(e.Option.none<string[]>())),
      e.Effect.catchTag("GitHubJsonParseError", () => e.Effect.succeed(e.Option.none<string[]>())),
    );

  return e.Effect.gen(function*() {
    const orgRepos = yield* fetchRepoNames(`https://api.github.com/orgs/${org}/repos?per_page=100&type=all`);
    if (e.Option.isSome(orgRepos)) {
      return orgRepos.value;
    }

    const userRepos = yield* fetchRepoNames(`https://api.github.com/users/${org}/repos?per_page=100&type=all`);
    return e.Option.getOrElse(userRepos, () => [] as string[]);
  });
};

export const canReadFromRemote = (
  repo: RepoIdentifier,
  accessToken: GithubAccessToken,
): e.Effect.Effect<boolean> =>
  e.pipe(
    fetchResponse(`https://api.github.com/repos/${repo.org}/${repo.repo}`, {
      headers: githubHeaders(accessToken.accessToken),
    }),
    e.Effect.map(response => response.ok),
    e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(false)),
  );

export const canWriteToRemote = (
  repo: RepoIdentifier,
  accessToken: GithubAccessToken,
): e.Effect.Effect<boolean> =>
  e.Effect.gen(function*() {
    const maybeResponse = yield* e.pipe(
      fetchResponse(`https://api.github.com/repos/${repo.org}/${repo.repo}`, {
        headers: githubHeaders(accessToken.accessToken),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(maybeResponse) || !maybeResponse.value.ok) {
      return false;
    }

    const maybePermissions = yield* e.pipe(
      e.Effect.tryPromise(() => maybeResponse.value.text()),
      e.Effect.flatMap(payload => e.Schema.decode(e.Schema.parseJson(RepoWritePermissionsSchema))(payload)),
      e.Effect.map((permissions): e.Option.Option<RepoWritePermissions> => e.Option.some(permissions)),
      e.Effect.catchTag("UnknownException", () => e.Effect.succeed(e.Option.none<RepoWritePermissions>())),
      e.Effect.catchTag("ParseError", () => e.Effect.succeed(e.Option.none<RepoWritePermissions>())),
    );
    if (e.Option.isNone(maybePermissions) || !maybePermissions.value.permissions) {
      return false;
    }

    const permissions = maybePermissions.value.permissions;
    return Boolean(permissions.push || permissions.maintain || permissions.admin);
  });
