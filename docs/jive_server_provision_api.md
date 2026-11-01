# `@jive-sh/server`: signing a pipeline in, and provisioning a resource

**Status (2026-11-01):** the contract the `jive` CLI codes against. `pipelineSessions:signIn` and `provision` are
built and deployed (`@jive-sh/server` 0.7.1, `adventurous-viper-740`). Choices marked **Default in effect** are open
with the command thread and may change.

**Why (Alex, 2026-11-01):** "We have a deploy hook in CI. That should do a `jive login --cicd` then `jive provision`
for a given resource". And: "a session should only be obtainable via human passkey, cicd oidc token exchange, or jive
mints a token and hands it off to a compute provider running an agent workflow".

The CLI is the only caller of both calls. They are Convex actions on the server deployment
(`https://adventurous-viper-740.convex.cloud` today, `https://api.jive.sh` once that domain moves), called over
Convex's HTTP API, or with `ConvexHttpClient` and `@jive-sh/server-client`'s `api`:

```http
POST <deployment URL>/api/action
Content-Type: application/json

{ "path": "<module>:<function>", "args": { … }, "format": "json" }
```

Convex answers `{ "status": "success", "value": <the function's answer> }`, or
`{ "status": "error", "errorMessage": "…" }` when the function threw or its arguments failed validation. A thrown
error is a failure the CLI reports as it is; every outcome a caller is expected to act on is a `value`.

## 1. `jive login --cicd`: `pipelineSessions:signIn`

Exchanges the deploy job's GitHub Actions ID token for a session token.

- **Token:** the job asks GitHub for an ID token with audience `https://api.jive.sh`
  (`ACTIONS_ID_TOKEN_REQUEST_URL` plus `&audience=https://api.jive.sh`, bearer `ACTIONS_ID_TOKEN_REQUEST_TOKEN`). The
  job needs `id-token: write`; the deploy job of Jive's reusable pipeline has it.
- **Request:** `Authorization: Bearer <ID token>`, `args: {}`.
- **Answer:**

| `value` | Meaning |
| --- | --- |
| `{ status: "signedIn", sessionToken, expiresAt }` | `sessionToken` is `jive_` + 43 base64url characters; `expiresAt` is milliseconds since the epoch, one hour after signing in. |
| `{ status: "refused", reason }` | `reason` says what to change; it never repeats the token. |

- **Refusals:** no ID token; a job not from `.github/workflows/pipeline.yml`; an event other than `push` or
  `workflow_dispatch`; an unprotected branch or tag; a self-hosted runner; a job naming no GitHub Actions
  environment; a repository not registered with Jive by its immutable `repository_id` and `repository_owner_id`.
- **Errors:** a token that isn't a JWT, is signed by another key, or has another audience is rejected by Convex
  before the function runs: `status: "error"`, for example `InvalidAuthHeader`.
- **The session** acts as the job's code repository, with its environment and workflow file. It lasts one hour and
  cannot be extended. A job that needs Jive later signs in again: GitHub mints a fresh ID token at any point in the
  job. The token is a bearer secret: never print it, and keep it no longer than the job.

## 2. `jive provision <kind>`: `provision`

**The call is named `provision`** (Alex, 2026-11-01: "there should be no resources:provision api right? the api is
provision"). It is the default export of the server's `convex/provision.ts`:
- Over the HTTP API, its path is `"provision"`.
- From the typed client, it is `api.provision.default`.

Convex names a default export by its module path alone: convex 1.48.0's `server/api.js` returns `path` when
`exportName === "default"`. Its client turns `"provision"` into `"provision:default"` (`browser/sync/udf_path_utils.js`).

"Make sure this resource instance exists". It is the one provision call for every kind of resource, and replaces
`packages:provision`, which is removed once jive-abstract-library stops calling it. Idempotent: every deploy calls it
right before it uses the instance, so a provisioning that failed is redone by the next deploy.

**The caller names the kind, never the implementation** (Alex, 2026-11-01: "it should probably only be
provisioning the abstract. so `jive provision connector-package-registry` and then it talks to the jive org which
should have one impl configured"). Each organization configures exactly one implementation per kind; for the
`jive-sh` organization, kind `connector-package-registry` is `jive-resource-connector-package-registry-npm`. The
server resolves the kind to that implementation and calls it.

- **Args:**

```ts
{
  sessionToken: string;   // a pipeline session (§1); a person's session is refused for now (open question 3)
  kind: string;           // the abstract's kind path: its name without "jive-abstract-resource-",
                          // e.g. "connector-package-registry" for jive-abstract-resource-connector-package-registry
  instance: unknown;      // the instance as the package's jive block declares it; the kind's contract defines its shape
}
```

  For kind `connector-package-registry`, `instance` is `{ "packageName": "@scope/name" }`: the package, created if
  missing, with a trusted publisher for the session's repository, `pipeline.yml` and environment. The kind's
  contract defines the instance shape, so it is the same whichever registry the organization configured.

- **Answer:**

| `value` | Meaning | What the CLI does |
| --- | --- | --- |
| `{ status: "ready", instanceId, instance }` | The instance exists and the caller may use it. `instanceId` is the implementation's id for it, stable across calls; `instance` is what the implementation records about it. | Continue the deploy. |
| `{ status: "inProgress", retryAfterSeconds }` | Another caller is provisioning the same instance. | Ask again after `retryAfterSeconds`; give up after 10 minutes. |
| `{ status: "personNeeded", reason, url }` | The outside system wants a person, for example npm's second factor before it creates a package. `url` is that system's own page. | Fail the deploy, printing `reason` and `url`. How the server answers npm's second factor is decided by the auto npm work (open question 4). |
| `{ status: "refused", reason }` | Provisioning is not allowed; `reason` says what to change. | Fail the deploy, printing `reason`. |

- **Refusals from the server**, whatever the kind:
  - the token opens no live session;
  - the session is a person's;
  - `kind` names no resource kind Jive knows;
  - the session's organization has no implementation configured for `kind`. The reason names the organization and
    the kind, for example: "the organization jive-sh has no implementation configured for connector-package-registry".
  - the configured implementation is not installed on the server;
  - for a connector kind, the organization has no connection for its configured implementation.
- **Refusals from the implementation:** `instance` doesn't match the kind's instance shape, and the implementation's
  own rules. For npm:
  - the package is bound to another code repository;
  - the package exists and the organization's npm account doesn't maintain it.
- **Errors:** missing or wrongly typed arguments (Convex's validation), and failures of the outside system; both come
  back as `status: "error"`.

## How the server answers it

1. Resolve the session. A pipeline session gives the code repository, its organization, the environment and the
   workflow file.
2. Look up the organization's configured implementation for `kind`: one record per organization and kind. Then find
   that implementation's installed component; one the server hasn't installed is refused.
3. For a connector, read the organization's connection from the `accountKeys` component (below). The npm
   connector stores no credentials, so the server passes the token on every call. When npm asks for its second
   factor, the connector answers `personNeeded`, and `provision` answers it with npm's page only: `{ status, reason,
   url }`. `packages:provision` goes through `provision` too.
4. Call the component's standard "make sure this exists" action with
   `{ instance, caller: { codeRepository: { id, owner, name }, environment, workflowFile }, account }`. Return its
   answer, which takes the four `value` shapes above.

The component's action is defined by `jive-abstract-resource` for every kind (design page: "each resource kind is a
connector abstract with a standard 'make sure this exists' call"; "instances are … held as records in that
component"). For npm, the steps `packages:provision` ran in the server moved into `jive-resource-connector-package-registry-npm`
0.2.0:
- claim the package;
- create the placeholder;
- keep or replace the trusted publisher;
- record the package.

## The accountKeys component

The component holds the organization's npm connection (connector `npm`), sealed under `CONNECTION_KEY`, and the
P-256 signing passkey registered on that npm account. `provision` calls these two after it has the
organization. Neither checks a session. They are not in the app's client API.

```ts
accountKeys.npmConnection.token({ organizationId: string }): { token: string } | null
accountKeys.npmConnection.sign({ organizationId: string, challenge: bytes }): { credentialId: string, signature: bytes }
```

`token` returns null when the organization has no npm connection. `sign`'s `signature` is the raw ECDSA P-256
SHA-256 signature, `r‖s`, not a WebAuthn assertion (no authenticator data, no clientDataJSON). It throws
`"This organization has no signing passkey yet."` when the organization has no passkey. `challenge` is the bytes
the connector asks to be signed.

A person with the organization's npm access creates that connection once, through the browser sign-in the daemon
already runs (`npmSessions:save`, naming the code repository). The app resolves the session and the repository's
organization, then calls the component.

## Open questions, with the defaults in effect

1. **Where components are installed** (design page, "Organization deployments"). Default in effect: in
   `@jive-sh/server`, as the npm connector is today, so step 2 is a lookup in the server's code. If each
   organization gets its own deployment, the server routes the call there; the contract above doesn't change.
2. **How an instance is declared in the jive block.** The CLI reads it and sends `kind` and `instance`. Default in
   effect: the CLI thread decides the block's shape; the server needs only those two.
3. **Whether a person's session may provision**, for example `jive provision` run locally. Default in effect:
   refused, because publisher-style resources need a pipeline's identity. Allowing it later adds a `person` caller to
   step 4 and doesn't change the args.
4. **How `provision` answers npm's second factor.** Decided by the auto npm work (Grok's and Alex's): whether it
   polls npm's doneUrl, signs with the organization's passkey, or retries with a one-time password. Until then the
   public answer is `personNeeded` with npm's page.
5. **How an organization configures its implementation for a kind.** There is no call for it yet. Default in
   effect: `convex run seed:resourceImplementation`, run once by hand on the server, as organizations and code
   repositories are registered today. `jive-sh` is set to `jive-resource-connector-package-registry-npm` on
   production (2026-11-01).
