import * as e from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { TOOL_NAME } from "@/constants";
import { modules } from "@/modules";
import { GitHubUnanswered, type IGitHub } from "./interface";

/** Only a name of letters, digits and hyphens is asked about, so the name can never change the request's path. */
const ACCOUNT_NAME = /^[A-Za-z0-9-]+$/;
const ANSWER_TIMEOUT = e.Duration.seconds(5);

/**
 * Asks GitHub's REST API, unauthenticated: `GET /users/<name>` answers 200 for a user or an organization and 404 when
 * no account has the name.
 */
export class GitHubImpl extends implementing(modules.github).uses(HttpClient.HttpClient) implements IGitHub {
  *accountExists(name: string): EffectGen<boolean, GitHubUnanswered> {
    if (!ACCOUNT_NAME.test(name)) return false;
    const response = yield* e.pipe(
      this.getDependency(HttpClient.HttpClient).execute(e.pipe(
        HttpClientRequest.get(`https://api.github.com/users/${name}`),
        HttpClientRequest.setHeaders({ accept: "application/vnd.github+json", "user-agent": TOOL_NAME }),
      )),
      e.Effect.timeout(ANSWER_TIMEOUT),
      e.Effect.catchTag("HttpClientError", (error) => e.Effect.fail(new GitHubUnanswered({ reason: error.reason._tag }))),
      e.Effect.catchTag("TimeoutError", () => e.Effect.fail(new GitHubUnanswered({ reason: `no answer within ${e.Duration.format(ANSWER_TIMEOUT)}` }))),
    );
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return yield* new GitHubUnanswered({ reason: `GitHub answered ${response.status}` });
  }
}
