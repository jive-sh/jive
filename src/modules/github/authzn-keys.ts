import * as e from "effect";
import { TOOL_NAME } from "@/constants";
import type { SshKey } from "@/modules/ssh/interface";
import type { GithubAccessToken, GithubWriteToken } from "./interface";
import { fetchResponse, githubHeaders, parseJson, readResponseMessage } from "./shared";

const GITHUB_KEY_PREFIX = `${TOOL_NAME}:`;

interface GitHubUserKey {
  readonly id: number;
  readonly key: string;
  readonly title: string;
}

const normalizeKeyBody = (publicKey: string): string => {
  const [keyType = "", keyBody = ""] = publicKey.trim().split(/\s+/, 3);
  return keyType && keyBody ? `${keyType} ${keyBody}` : publicKey.trim();
};

const managedKeyTitle = (key: SshKey): string =>
  `${GITHUB_KEY_PREFIX}${key.email}:${key.name}`;

const fetchUserKeys = (token: string, endpoint: string): e.Effect.Effect<GitHubUserKey[]> =>
  e.Effect.gen(function*() {
    const maybeResponse = yield* e.pipe(
      fetchResponse(endpoint, {
        headers: githubHeaders(token),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(maybeResponse) || !maybeResponse.value.ok) {
      return [] as GitHubUserKey[];
    }

    const maybeRows = yield* e.pipe(
      parseJson<Array<{ id: number; key?: string; title?: string }>>(maybeResponse.value),
      e.Effect.map(rows => e.Option.some(rows)),
      e.Effect.catchTag(
        "GitHubJsonParseError",
        () => e.Effect.succeed(e.Option.none<Array<{ id: number; key?: string; title?: string }>>()),
      ),
    );
    if (e.Option.isNone(maybeRows)) {
      return [] as GitHubUserKey[];
    }

    return maybeRows.value
      .filter(row => typeof row.id === "number" && typeof row.key === "string")
      .map(row => ({
        id: row.id,
        key: row.key!,
        title: row.title ?? "",
      }));
  });

const deleteUserKey = (token: string, endpoint: string) =>
  e.pipe(
    fetchResponse(endpoint, {
      method: "DELETE",
      headers: githubHeaders(token),
    }),
    e.Effect.flatMap(response =>
      response.ok ?
        e.Effect.void :
        e.Effect.logWarning(`GitHub key deletion failed with status ${response.status}.`),
    ),
    e.Effect.catchTag("GitHubRequestError", error => e.Effect.logWarning(`GitHub key deletion failed: ${error.message}`)),
  );

const createUserKey = (token: string, endpoint: string, title: string, publicKey: string) =>
  e.Effect.gen(function*() {
    const maybeResponse = yield* e.pipe(
      fetchResponse(endpoint, {
        method: "POST",
        headers: {
          ...githubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          key: publicKey,
        }),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", error =>
        e.Effect.gen(function*() {
          yield* e.Effect.logWarning(`GitHub key creation failed: ${error.message}`);
          return e.Option.none<Response>();
        }),
      ),
    );
    if (e.Option.isNone(maybeResponse)) {
      return;
    }
    if (maybeResponse.value.ok) {
      return;
    }

    const message = yield* readResponseMessage(maybeResponse.value);
    yield* e.Effect.logWarning(`GitHub key creation failed: ${message}`);
  });

const ensureUserKey = (
  token: string,
  publicKey: string,
  title: string,
  listEndpoint: string,
  deleteEndpointBase: string,
) =>
  e.Effect.gen(function*() {
    const existingKeys = yield* fetchUserKeys(token, listEndpoint);
    const normalizedPublicKey = normalizeKeyBody(publicKey);
    if (existingKeys.some(existingKey => normalizeKeyBody(existingKey.key) === normalizedPublicKey)) {
      return;
    }

    for (const existingKey of existingKeys.filter(existingKey => existingKey.title === title)) {
      yield* deleteUserKey(token, `${deleteEndpointBase}/${existingKey.id}`);
    }

    yield* createUserKey(token, listEndpoint, title, publicKey);
  });

export const sshKeyExists = (
  accessToken: GithubAccessToken,
  key: SshKey,
): e.Effect.Effect<{ authn: boolean; signing: boolean }> =>
  e.Effect.gen(function*() {
    const normalizedPublicKey = normalizeKeyBody(key.pubkey);
    const authKeys = yield* fetchUserKeys(accessToken.accessToken, "https://api.github.com/user/keys");
    const signingKeys = yield* fetchUserKeys(accessToken.accessToken, "https://api.github.com/user/ssh_signing_keys");
    return {
      authn: authKeys.some(existingKey => normalizeKeyBody(existingKey.key) === normalizedPublicKey),
      signing: signingKeys.some(existingKey => normalizeKeyBody(existingKey.key) === normalizedPublicKey),
    };
  });

export const setSshKey = (writeToken: GithubWriteToken, key: SshKey): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const title = managedKeyTitle(key);
    yield* ensureUserKey(
      writeToken.writeToken,
      key.pubkey,
      title,
      "https://api.github.com/user/keys",
      "https://api.github.com/user/keys",
    );
    yield* ensureUserKey(
      writeToken.writeToken,
      key.pubkey,
      title,
      "https://api.github.com/user/ssh_signing_keys",
      "https://api.github.com/user/ssh_signing_keys",
    );
  });
