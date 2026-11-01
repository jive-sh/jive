import * as e from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { modules } from "@/modules";
import type { IPipelineIdentity } from "./interface";

/**
 * GitHub Actions gives a job permitted `id-token: write` these two variables, and answers a GET of the URL, with the
 * audience appended and the request token as a bearer, with `{ value: <ID token> }`
 * (https://docs.github.com/en/actions/reference/security/oidc#methods-for-requesting-the-oidc-token).
 */
const REQUEST_URL_VARIABLE = "ACTIONS_ID_TOKEN_REQUEST_URL";
const REQUEST_TOKEN_VARIABLE = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

const IdTokenResponse = e.Schema.Struct({ value: e.Schema.NonEmptyString });

export class GitHubActionsIdentityImpl extends implementing(modules.pipelineIdentity).uses(OSPlatform, HttpClient.HttpClient) implements IPipelineIdentity {
  *idToken(audience: string): EffectGen<string, string> {
    const osPlatform = this.dependencies.OSPlatform;
    const maybeRequestUrl = yield* osPlatform.readEnv(REQUEST_URL_VARIABLE);
    const maybeRequestToken = yield* osPlatform.readEnv(REQUEST_TOKEN_VARIABLE);
    if (e.Option.isNone(maybeRequestUrl) || e.Option.isNone(maybeRequestToken)) {
      return yield* e.Effect.fail(
        `${REQUEST_URL_VARIABLE} and ${REQUEST_TOKEN_VARIABLE} are not set: \`jive login --cicd\` runs in a GitHub Actions job`
        + " with the `id-token: write` permission, which Jive's reusable pipeline grants its deploy job",
      );
    }
    const operation = `request a GitHub Actions ID token for ${audience}`;
    const response = yield* e.pipe(
      this.getDependency(HttpClient.HttpClient).execute(e.pipe(
        HttpClientRequest.get(`${maybeRequestUrl.value}&audience=${encodeURIComponent(audience)}`),
        HttpClientRequest.bearerToken(maybeRequestToken.value),
      )),
      e.Effect.mapError((error) => `could not ${operation}: ${error.message}`),
    );
    if (response.status !== 200) {
      return yield* e.Effect.fail(`could not ${operation}: GitHub answered ${response.status}`);
    }
    const { value } = yield* e.pipe(
      response.json,
      e.Effect.flatMap(e.Schema.decodeUnknownEffect(IdTokenResponse)),
      e.Effect.mapError(() => `could not ${operation}: GitHub's answer has no token`),
    );
    return value;
  }
}
