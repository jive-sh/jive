import * as e from "effect";

export class GitHubRequestError extends e.Data.TaggedError("GitHubRequestError")<{
  message: string;
}> {}

export class GitHubJsonParseError extends e.Data.TaggedError("GitHubJsonParseError")<{
  message: string;
}> {}

export const fetchResponse = (input: string | URL, init?: RequestInit) =>
  e.Effect.tryPromise({
    try: () => fetch(input, init),
    catch: error => new GitHubRequestError({ message: getErrorMessage(error) }),
  });

export const parseJson = <A>(response: Response) =>
  e.Effect.tryPromise({
    try: () => response.json() as Promise<A>,
    catch: error => new GitHubJsonParseError({ message: getErrorMessage(error) }),
  });

export const readResponseMessage = (response: Response) =>
  e.pipe(
    parseJson<{ message?: string }>(response),
    e.Effect.map(body => body.message ?? String(response.status)),
    e.Effect.catchTag("GitHubJsonParseError", () => e.Effect.succeed(String(response.status))),
  );

export const githubHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
});

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
