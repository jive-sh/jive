import { expect, test } from "bun:test";
import * as e from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { modules } from "@/modules";
import { GitHubImpl } from "./impl";
import { GitHubUnanswered } from "./interface";

/** The real module against a fake GitHub answering each account name with `statusFor(name)`, recording each request. */
async function accountExists({ name, statusFor }: { readonly name: string; readonly statusFor: (name: string) => number }) {
  const requests: Array<{ readonly url: string; readonly userAgent: string | undefined }> = [];
  const fakeGitHub = e.Layer.succeed(HttpClient.HttpClient, HttpClient.make((request, url) => {
    requests.push({ url: url.toString(), userAgent: request.headers["user-agent"] });
    const status = statusFor(url.pathname.replace("/users/", ""));
    return e.Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status })));
  }));
  const result = await e.Effect.runPromise(e.pipe(
    e.Effect.gen(function* () { return yield* (yield* modules.github).accountExists(name); }),
    e.Effect.provide(GitHubImpl.Layer),
    e.Effect.provide(fakeGitHub),
    e.Effect.result,
  ));
  return { result, requests };
}

const known = (name: string) => name === "ozyman42" ? 200 : 404;

test.each([
  { name: "ozyman42", exists: true },
  { name: "no-such-org", exists: false },
])("$name exists on GitHub: $exists, asked by GET /users/<name> with a User-Agent", async ({ name, exists }) => {
  const { result, requests } = await accountExists({ name, statusFor: known });
  expect(result).toEqual(e.Result.succeed(exists));
  expect(requests).toEqual([{ url: `https://api.github.com/users/${name}`, userAgent: "jive" }]);
});

test.each([
  { name: "ozyman42/workspace" },
  { name: "../orgs/acme" },
  { name: "" },
])("'$name' is no account, and GitHub is not asked", async ({ name }) => {
  const { result, requests } = await accountExists({ name, statusFor: known });
  expect(result).toEqual(e.Result.succeed(false));
  expect(requests).toEqual([]);
});

test("an answer other than 200 or 404 (a rate limit) is no answer", async () => {
  const { result } = await accountExists({ name: "ozyman42", statusFor: () => 403 });
  expect(result).toEqual(e.Result.fail(new GitHubUnanswered({ reason: "GitHub answered 403" })));
});
