# Moving Jive's Cloudflare services to Convex: migration plan

**Status (November 1, 2026):** §5 is built except the cutover. `@jive-sh/server` is deployed (`adventurous-viper-740`,
project `jive-server`) with passkey sign-in, sessions passed as a `sessionToken` argument (§8 question 4 went to
opaque tokens, not JWTs) and program sign-in requests; Alex's skill-sync passkey is imported as his account.
`@jive-sh/app` is an Expo app on `jive-abstract-app-expo` 0.3.0, live at `https://jive-sh.expo.app/`, reading the
server's address from `@jive-sh/server-client` (§8 question 7). Registering `jive.sh` on EAS was refused: the `jive-sh`
Expo account is on Free and its `jive-ci` robot is a Developer. So `jive.sh` still serves the Cloudflare Worker, and
§5.4's DNS move and Worker retirement wait. §4 (skill-sync) is not started.  
**As of:** October 26, 2026 (status above: November 1)  
**Decision this implements:** [§23 of the architecture discussion](jive_architecture_discussion.md#23-decisions-central-server-and-local-servers-2026-10-26)

Two services run on Cloudflare today and move to the central Jive Convex deployment. On the way,
`@jive-sh/app` splits in two: its backend becomes a new package, `@jive-sh/server`, and `@jive-sh/app` keeps
only the frontend at `jive.sh` (§5).

- **`@jive-sh/skill-sync-service`**, live at `skill-sync.jive.sh`: the server every skill-sync daemon and
  dashboard talks to. Code in [`skill-sync-service/`](skill-sync-service/) (not yet committed to any repo).
- **`@jive-sh/app`**, live at `jive.sh` and `api.jive.sh`: the credential custodian. Code in [`app/`](app/),
  design in [`app/docs/system-design.md`](app/docs/system-design.md). Its GitHub repo, `jive-sh/app`, is empty,
  so nothing below links to it by commit.

Both hostnames answered `200` on October 26 (`/`, `/api/health` on both app hosts).

Every Convex claim below links the passage it rests on. Each one is marked **documented** (a Convex page says
it), **inferred** (my reading of a source, with the source), or **unverified** (no source found; the check that
would settle it is named).

---

## 1. Settled inputs

- The central server is Convex, not Cloudflare (§23).
- Jive's central server lives in the Convex team `jive` (id 551884), which Alex created and moved to Pro on
  October 26. Pro costs $25 per developer per month and lists custom domains among its features
  ([pricing](https://www.convex.dev/pricing#:~:text=per%20developer%2Fmonth)); custom domains require it
  ([custom domains](https://docs.convex.dev/production/custom-domains#:~:text=Custom%20domains%20require%20a%20Convex%20Pro%20plan)).
- `api.jive.sh` is the API domain, separate from the app at `jive.sh`.
- The WebAuthn relying party stays `jive.sh`, so one passkey keeps covering every `*.jive.sh` origin
  (`skill-sync-service/src/auth.ts:24-30`).
- Package split (Alex, October 26):
  - `@jive-sh/server` is only the backend. It extends `jive-abstract-backend-convex`, and its build publishes
    the generated Convex client to npm and deploys the functions, both from one commit.
  - `@jive-sh/app` is only the frontend at `jive.sh`. It extends `jive-abstract-app-expo` and imports
    `@jive-sh/server`'s client.
  - `@jive-sh/server`'s published client replaces `@jive-sh/app-client`.
- Each abstract owns its package's deployment and CI/CD (§3.1). This plan says what each package needs from it,
  not how it deploys.

## 2. The four questions, answered

### 2.1 Can a daemon hold a live Convex subscription in place of the Hub?

**Yes for Node, documented; Bun not documented.** `ConvexClient` "provides subscriptions to queries in Node.js
and any JavaScript environment that supports WebSockets"
([JavaScript clients](https://docs.convex.dev/client/javascript#convex-client)), with `onUpdate`
([API](https://docs.convex.dev/api/classes/browser.ConvexClient#onupdate)) and connection-state callbacks
([`subscribeToConnectionState`](https://docs.convex.dev/api/classes/browser.ConvexClient#subscribetoconnectionstate)).
The daemon ships as a Bun-compiled binary; Bun is not named anywhere I read. Bun has a global `WebSocket`, which
the daemon already uses ([`connect()`](https://github.com/jive-sh/skill-sync/blob/3851a8650e78f660b860bf108994d16e24b60931/src/daemons/skill-sync-daemon.ts#L135-L172)),
so my inference is that it works. **Unverified** until a compiled binary subscribes to a local backend (§7).

Three things the Hub does that a subscription does not do by itself:

1. **Authentication needs a JWT.** `setAuth` takes "an async function returning the JWT-encoded OpenID Connect
   Identity Token" ([`setAuth`](https://docs.convex.dev/api/classes/browser.ConvexClient#setauth)). The daemon's
   device token is an opaque bearer string, so the server must mint JWTs and Convex must trust them as a
   custom JWT provider: RS256 or ES256 only, with the key set at a URL or inlined as a data URI
   ([custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt#server-side-integration)). Documented.
2. **"Online" becomes a heartbeat.** The Hub knows a machine is online because its socket is open
   (`skill-sync-service/src/hub.ts:12-13`). No API in the docs I read tells a Convex function which clients are connected (inferred). The presence component keeps
   a list of who is here from heartbeats with a session timeout
   ([presence README](https://github.com/convex/presence/blob/a7640e7e8e062a747e5a38d1320bd51e3ad8aea7/README.md)).
   Visible change: a machine that drops shows as online until its timeout passes.
3. **No WebSocket server.** HTTP actions "take in a Request and return a Response"
   ([HTTP actions](https://docs.convex.dev/functions/http-actions#defining-http-actions)); no upgrade is
   documented, so my inference is that the daemon's `/daemon` socket and the dashboard's `/dashboard/live`
   socket cannot be kept. Both are replaced by subscriptions, which means a daemon release (§4.4).

### 2.2 File storage limits against R2 usage

**Fits, documented.** Convex file storage has no file-size limit, only a 2-minute upload timeout
([upload limits](https://docs.convex.dev/file-storage/upload-files#limits)). Storage is 1 GB on Free and 100 GB
included on Professional; egress 1 GB and 50 GB a month
([limits](https://docs.convex.dev/production/state/limits#file-storage)). Every stored file's metadata
carries its SHA-256 ([file metadata](https://docs.convex.dev/file-storage/file-metadata#:~:text=sha256)),
which is the hash skill-sync addresses content by.

R2 today: content is put under its hash and never deleted
(`skill-sync-service/src/index.ts:229-237`), so the bucket holds every version ever pushed. Only the current
version of each path is referenced (`files.hash`). The synced skills are 67 live files, about 327 KB, the
largest 78 KB (measured on this Mac's synced skill folders; `skill-sync list` shows 7 skills). I did not read
the R2 bucket's size. Only referenced content needs migrating.

One rule changes. Convex storage ids are random, not the hash, so a `blobs` table maps hash to storage id.
Today any authorised caller can read any hash at `/content/<hash>`; that stays, served from an HTTP action
([serving from HTTP actions](https://docs.convex.dev/file-storage/serve-files#serving-files-from-http-actions)).
Storage URLs from `getUrl()` are bearer URLs that cannot be revoked except by deleting the file
([security model](https://docs.convex.dev/file-storage#security-model)), so the plan does not hand them out.

### 2.3 Passkey sign-in on a `jive.sh` subdomain, and one domain for both surfaces

**One custom domain cannot serve both the client API and HTTP actions**, inferred from the Management API: a
custom domain record has exactly one required `requestDestination`, either `convexCloud` (queries, mutations
and subscriptions over WebSocket) or `convexSite` (HTTP actions)
([OpenAPI spec](https://api.convex.dev/v1/openapi.json), schema `RequestDestination`;
[create custom domain](https://docs.convex.dev/management-api/create-custom-domain)). The custom domains page
treats them as two settings, `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL`
([changing your default domain](https://docs.convex.dev/production/custom-domains#changing-your-default-domain)).
The list endpoint returns an array, so my inference is that a deployment can hold several custom domains.

**Passkeys work with `api.jive.sh` on HTTP actions**, inferred. WebAuthn checks the page's origin and the
relying party, not where the subscription WebSocket goes. A page served from `api.jive.sh` or `jive.sh` can
sign with relying party `jive.sh`, and the verify call runs in an HTTP action. The realtime client can stay on
the default `<deployment>.convex.cloud` URL, authenticated by JWT (2.1).

Two code changes follow:

- The expected origin must come from configuration. `skill-sync-service/src/auth.ts:34` reads it from
  `request.url`; what `request.url` holds in an HTTP action reached through a custom domain is **unverified**.
  The app already configures it (`app/src/modules/secrets/impl.ts:29-38`, from `WEBSITE_DOMAIN`).
- WebAuthn verification runs in an HTTP action, not in a query or mutation, because those must be
  deterministic ([restrictions](https://docs.convex.dev/functions/runtimes#restrictions-on-queries-and-mutations)).
  The default runtime has Web Crypto ([Web Crypto APIs](https://docs.convex.dev/functions/runtimes#web-crypto-apis))
  and `@simplewebauthn/server` uses only Web Crypto (`app/docs/system-design.md:271-272`), so my inference is
  that it runs there.

Routing a domain through Vercel to `*.convex.site` avoids registering it with Convex
([Vercel in front](https://docs.convex.dev/production/abuse-protection#putting-vercel-in-front)). With Pro
approved, the plan does not use it.

### 2.4 Does the workflow component run on self-hosted Convex (the local servers)?

**Not documented either way.** The workflow component's README never mentions self-hosting
([workflow README](https://github.com/convex/workflow/blob/35257a7f1eeaa1bc772cb50bfde61f68783c95a4/README.md)).
What points to yes:

- Self-hosted Convex "runs the open-source backend, and contains the same fully up-to-date code the cloud
  service uses" ([self-hosting](https://docs.convex.dev/self-hosting#open-source-convex-backend)).
- It "supports all the free-tier features of the cloud-hosted product"
  ([self-hosted README](https://github.com/convex/convex-backend/blob/bb31399c8704ceb6c19003936f6e144375b2c3bc/self-hosted/README.md#limitations)).
- Component support is in the open-source backend
  ([`crates/model/src/components`](https://github.com/convex/convex-backend/tree/bb31399c8704ceb6c19003936f6e144375b2c3bc/crates/model/src/components)),
  and a self-hosted user's dashboard calls `listForAllComponents`
  ([issue #341](https://github.com/convex/convex-backend/issues/341)).

My inference is that it runs. It stays **unverified** until the spike in §7 runs a workflow on a local
backend. Related limits: components cannot use the Node runtime
([issue #335](https://github.com/convex/convex-backend/issues/335)), so any Node action a workflow step calls
lives in `@jive-sh/server`'s own functions, not a component.

---

## 3. The central deployment

`@jive-sh/server` is the central Convex deployment's code, matching §23's single central server:

```text
@jive-sh/server/
  convex/
    convex.config.ts   the server's functions plus the skill-sync component (alternative in §8, question 1)
    auth.config.ts     trusts Jive-issued JWTs (customJwt, ES256)
    accounts/, projects/, integrations/, sessions/, …   today's app modules as tables and functions
    http.ts            whatever still needs raw HTTP (§8, question 2)
    skillSync/         skill-sync's tables and functions, as a component
```

- **The published client is the main way in.** `@jive-sh/app` in the browser, and by my inference agents and
  pipelines, call the server's functions through it. Those calls go over Convex's realtime API (`convexCloud`),
  not HTTP actions.
- **Which surface `api.jive.sh` serves is re-opened** (§8, question 2). One custom domain serves one surface
  (§2.3). Before the split I recommended HTTP actions, because the app's REST contract and passkey routes lived
  there. With the REST contract replaced by the client, I now recommend the realtime API: every client then
  bakes in `api.jive.sh`, which Jive owns, instead of a `*.convex.cloud` host, which is the case Convex warns
  about ([native clients](https://docs.convex.dev/production/abuse-protection#native-clients-and-custom-domains)).
- **DNS stays in the `jive.sh` Cloudflare zone.** A Convex custom domain needs a `CNAME` to `convex.domains`
  and a `TXT` at `_convex_domains.<domain>` ([setup](https://docs.convex.dev/production/abuse-protection#setup)).
  Creating them is the backend abstract's custom-domain wiring (§3.1).
- **The default URLs stay reachable.** I found no setting that turns off `*.convex.site`; the docs mention a
  deployment that "stop[s] serving the default" endpoints without saying how
  ([native clients](https://docs.convex.dev/production/abuse-protection#native-clients-and-custom-domains)).
  **Unverified.** Today's reason for `workers_dev: false` still holds: passkey sign-in fails on a non-`jive.sh`
  host anyway.

### 3.1 Deployment through the two abstracts

Each package's six `jive:cicd:*` hooks come from its abstract, designed and built in its own thread. This plan
designs no deployment of its own. Both package names are settled; neither config shape is yet, and this section
names them once they exist.

**`@jive-sh/server` through `jive-abstract-backend-convex`** (CLI `jive-backend-convex`;
[repo](https://github.com/jive-sh/jive-abstract-backend-convex/blob/d1ef0fc3b6349bbed283bb6c272ba5530b7f0558/README.md), at commit `d1ef0fc`). Its thread reports it implemented, with every hook run end to end against
a throwaway project in team `jive`, since deleted. Version 0.1.0 was not yet on npm on October 26.

`@jive-sh/server`'s six scripts are `jive-backend-convex cicd <get-config|build|audit|deploy-url|upload-artifacts|deploy>`.
`audit` is a placeholder that the server replaces with its own tests. The settings sit beside `jive.cicd` as
`jive["backend-convex"]`, and every field is required ([reference](https://github.com/jive-sh/jive-abstract-backend-convex/blob/d1ef0fc3b6349bbed283bb6c272ba5530b7f0558/README.md#the-backend-convex-block)):

```jsonc
"cicd": {
  "deploy": { "verb": "Deploy to", "branches": { "main": ["latest"] }, "previews": false, "sequentially": true },
  "runsOnPullRequests": true,
  "runsOn": "ubuntu-latest",
  "requiredSecrets": ["CONVEX_TEAM_ACCESS_TOKEN", "NPM_TOKEN"]
},
"backend-convex": {
  "team": 551884,
  "project": "jive-server",
  "region": "aws-us-east-1",
  "environments": {
    "latest": {
      "environmentVariables": {
        "WEBSITE_DOMAIN": { "value": "jive.sh" },
        "CONNECTION_KEY": { "generateOnce": { "type": "randomBytes", "bytes": 32, "prefix": "1:" } },
        "JWT_PRIVATE_KEY": { "generateOnce": { "type": "es256KeyPair", "publicJwksVariable": "JWT_JWKS" } }
      },
      "customDomains": [{ "domain": "api.jive.sh", "destination": "convexCloud", "canonical": true }]
    }
  },
  "afterDeploy": { "function": "deploys:record" }
}
```

- **Production is named `latest`,** not `Production` as `@jive-sh/app` names it today. Only `latest` publishes
  the client under its bare version, so `npm i @jive-sh/server` resolves to production
  ([published client](https://github.com/jive-sh/jive-abstract-backend-convex/blob/d1ef0fc3b6349bbed283bb6c272ba5530b7f0558/README.md#the-published-client)).
- **`destination` follows question 2 in §8.** `convexCloud` is my recommendation; `convexSite` is the
  alternative. A `canonical` domain becomes the deployment's URL only once Convex reports it verified. The
  abstract never touches DNS; the deploy log prints the records to create
  ([custom domains](https://github.com/jive-sh/jive-abstract-backend-convex/blob/d1ef0fc3b6349bbed283bb6c272ba5530b7f0558/README.md#custom-domains)).
- **The WebAuthn origin is derived from `WEBSITE_DOMAIN`**, as `app/src/modules/secrets/impl.ts:29-38` does
  today, rather than set as a second variable that could disagree.
- **`project`, `region`:** `jive-server` and `aws-us-east-1` are the abstract's example values; the project is
  created on the first deploy.
- **Credentials:** `CONVEX_TEAM_ACCESS_TOKEN` is the only Convex secret: a long-lived team token, from which
  each deploy mints a deploy key for that one deployment and deletes it afterwards. Publishing the client also
  needs npm auth. It goes through `jive-abstract-library`'s `publishPackage`, the same code as a library release,
  which uses `NPM_TOKEN` when that secret is set and npm trusted publishing otherwise (that thread's account;
  fixed in the README in 0.1.1, committed as `6aee9ec` and not yet on npm when I checked). npm configures a
  trusted publisher on an existing package's settings page ([trusted publishers](https://docs.npmjs.com/trusted-publishers)),
  so `@jive-sh/server`'s first publish needs `NPM_TOKEN` until the npm connector's provisioning exists
  ([design doc §25.6](jive_architecture_discussion.md#256-provisioning-a-new-npm-package-2026-10-26): a placeholder
  published as the user's npm account, then trusted publishing); after it, a trusted publisher (workflow
  `pipeline.yml`, environment `latest`) replaces the token and `NPM_TOKEN` leaves `requiredSecrets`. Until
  then both secrets are exposed to every pull-request build, the known `requiredSecrets` gap
  ([limitations](https://github.com/jive-sh/jive-abstract-backend-convex/blob/d1ef0fc3b6349bbed283bb6c272ba5530b7f0558/README.md#limitations-and-open-questions)). Both are scaffolding: per
  [§24 of the design doc](jive_architecture_discussion.md#24-decisions-credentials-on-the-server-ci-by-oidc-2026-10-26),
  CI is to hold no provider secrets and instead authenticate to `@jive-sh/server` with its GitHub OIDC token.

How it meets the needs sent to its thread:

1. **Target.** Met. Team, project and environments come from `package.json`; each environment is its own
   deployment, and each package its own project, so question 1 in §8 can go either way.
2. **Custom domain.** Met. The destination is set per domain.
3. **Environment variables.** Met. A `generateOnce` value is written only after the deployment's variable
   list was read and shows it absent; an unreadable list or a half-present key pair stops the deploy
   ([generate-once keys](https://github.com/jive-sh/jive-abstract-backend-convex/blob/d1ef0fc3b6349bbed283bb6c272ba5530b7f0558/README.md#generate-once-keys)). The ES256 pair also writes `JWT_JWKS`, a data URI that
   `auth.config.ts` reads as `jwks: process.env.JWT_JWKS` (§4.3). **Risk, reported by that thread:** Convex's
   spec says listing environment variables "in the future might not include secret environment variables".
   If that happens, the absence check would wrongly pass and could overwrite `CONNECTION_KEY`, making every
   stored credential unreadable. **Proposed fix, with Alex:** write a plain, non-secret marker variable
   (such as `CONNECTION_KEY_GENERATED_AT`) in the same update as each generated key. A marker present with
   its key missing from the list then stops the deploy rather than regenerating, and a key found without a
   marker gets one on the next deploy. It still assumes a future "secret" classification would not hide the
   marker too. Until Alex decides, this stays a risk.
4. **After deploy.** Met. `deploys:record` runs after every push with `{ sourceCommitSha, environment }`
   (§4.1).
5. **Bundling.** Plain `convex deploy`. **Components are untested** through the abstract (§7 check 5).
6. **Client and functions from one commit.** Met. The deploy publishes `@jive-sh/server` with `api`, the types
   `DataModel`, `Doc`, `Id` and `TableNames`, `convexUrl`, `convexSiteUrl` and `deployment`. That needs
   `convex.json` with `codegen.staticApi` and `codegen.staticDataModel`, which are beta. Every deploy publishes,
   so every change meant to deploy bumps the version; the deploy checks this before touching Convex.
7. **Self-hosted.** Not yet an environment kind.
8. **Previews.** Supported, one deployment per pull request; off for `@jive-sh/server`.

**Open, raised to Alex by that thread:** how installed clients keep working when a deploy changes a function
they call. It reaches this plan through skill-sync daemons, which run an installed client and upgrade up to
five minutes after a release (§4.4), and through `@jive-sh/app`, which ships whichever client version it was
built with.

**`@jive-sh/app` through `jive-abstract-app-expo`** (CLI `jive-app-expo`; [draft PR #1](https://github.com/jive-sh/jive-abstract-app-expo/pull/1), head
`15daf0d`). Its thread reports it implemented and unit-tested. The live test on EAS waits for the `jive-sh`
organisation's Expo token.

The host is **EAS Hosting**, Expo's web host, which that thread reports runs on Cloudflare Workers
([EAS Hosting](https://docs.expo.dev/eas/hosting/introduction/)). The scripts are `jive-app-expo cicd <hook>`,
and the settings sit beside `jive.cicd` as `jive["app-expo"]`:

```jsonc
"app-expo": {
  "web": { "subdomain": "jive-sh", "customDomain": "jive.sh" },
  "native": { "platforms": [], "distribution": "internal" },
  "environments": {
    "Production": {
      "web": "production",
      "easEnvironment": "production",
      "variables": {}            // see "The server's address" below
    }
  },
  "preview": null
}
```

How it meets the needs sent to its thread:

1. **Served at `https://jive.sh`.** Production serves at `https://jive-sh.expo.app`. `customDomain: "jive.sh"`
   makes the URL hook report `https://jive.sh/`. Attaching the domain is a step in the EAS Hosting dashboard. A
   custom domain is "a premium feature and isn't available on the free plan"
   ([custom domains](https://docs.expo.dev/eas/hosting/custom-domain/#assigning-a-custom-domain)); that thread
   gives Starter at $19 a month ([pricing](https://expo.dev/pricing)). For an apex domain, Expo's dashboard
   typically recommends an A record to `172.66.0.241`, plus a TXT and an SSL CNAME
   ([DNS records](https://docs.expo.dev/eas/hosting/custom-domain/#custom-domain-dns-records)). Whether to pay
   for that and move `jive.sh` goes to Alex from that thread. Nothing touches `jive.sh` DNS.
2. **Single-page web build.** Set `expo.web.output: "single"` in `@jive-sh/app`'s `app.json`.
3. **The server's address.** Two ways, and the threads disagree (§8 question 7):
   - **Import `convexUrl`** from `@jive-sh/server`'s client *(my recommendation)*. The address then has one
     source, the server's own deploy. That thread's objection: an app imports one client version, and this
     abstract builds every environment from one commit, so a Staging and a Production would get the same
     address. Today there is only one environment.
   - **Set `EXPO_PUBLIC_SERVER_URL` in each environment's `variables`** *(that thread's recommendation)*. Expo
     inlines `EXPO_PUBLIC_*` values when it exports the web build; that thread verified this. It works for any
     number of environments, but the address is then written in `@jive-sh/app` as well as owned by the server's
     deploy.
4. **No previews.** `"previews": false` with `"preview": null`.

The one-off copy of D1 rows and R2 blobs (§4.4 step 5) is neither abstract's job.

---

## 4. `@jive-sh/skill-sync-service`

This section keeps skill-sync's REST routes as HTTP actions, which fits `api.jive.sh` on HTTP actions. If
question 2 in §8 puts `api.jive.sh` on the realtime API instead, the daemon calls functions through the
published client for everything, including uploads (function arguments may be 16 MiB,
[limits](https://docs.convex.dev/production/state/limits#functions)); `/skill-sync/` routes remain only on the
default `*.convex.site` host; and the dashboard moves into `@jive-sh/app` at `jive.sh`, since passkey pages need
a `jive.sh` origin.

### 4.1 Piece by piece

| Cloudflare piece (`wrangler.jsonc`) | Convex equivalent | Source | What Convex can't do |
| --- | --- | --- | --- |
| Worker `jive-skill-sync`, the `fetch` router (`src/index.ts`) | HTTP actions in the component's `http.ts`, mounted at `/skill-sync/` | [HTTP actions](https://docs.convex.dev/functions/http-actions#defining-http-actions), [component routes](https://docs.convex.dev/components/using#http-routes) | Component HTTP actions have no `ctx.auth` and no app environment variables, so authenticated routes are defined in `@jive-sh/server`'s own `http.ts` and call the component ([authoring](https://docs.convex.dev/components/authoring#http-actions)) |
| D1 `jive-skill-sync-db`, nine tables (`src/schema.sql`) | Convex tables with indexes. Each `DB.batch` becomes one mutation, which is a real transaction | [transactions](https://docs.convex.dev/functions/mutation-functions#transactions), [OCC](https://docs.convex.dev/database/advanced/occ) | No SQL. `json_each`, `MAX(seq)+1` and the `skillOf` `CASE` become TypeScript. A transaction reads at most 16 MiB and 32,000 documents ([limits](https://docs.convex.dev/production/state/limits#transactions)); the dashboard snapshot reads every `files` row, tombstones included, so it is paginated or split once that grows |
| R2 `jive-skill-sync-content`, content by hash | File storage plus a `blobs` table (hash → storage id); stored from an action, served from an HTTP action | [storing in actions](https://docs.convex.dev/file-storage/store-files#storing-files-in-actions), [serving](https://docs.convex.dev/file-storage/serve-files#serving-files-from-http-actions) | Ids are not content addresses (hence `blobs`). A write refused with 409 after its bytes were stored leaves an orphan, which the action deletes |
| Durable Object `Hub`: every daemon's and dashboard's live connection | Subscriptions (`ConvexClient.onUpdate`), mutations for status and dashboard changes, presence for "online" | §2.1 | No WebSocket server; "online" is heartbeat-based; Bun unverified |
| Hub's npm `latest` lookup (`hub.ts:240-252`) | A cron action every minute writes the version to a table the snapshot reads | [`fetch` is actions-only](https://docs.convex.dev/functions/runtimes#network-apis), [crons](https://docs.convex.dev/scheduling/cron-jobs#defining-your-cron-jobs) | Queries cannot fetch |
| `version_metadata` (dashboard reloads after a deploy) | The backend abstract's `afterDeploy` runs `deploys:record` with the commit sha; the page compares (§3.1) | none found | No built-in deployed-version id in the docs I read |
| `observability` | Dashboard logs; log streams to Axiom, Datadog, PostHog or a webhook | [log streams](https://docs.convex.dev/production/integrations/log-streams#configuring-log-streams) | None |
| Custom domain `skill-sync.jive.sh` | `api.jive.sh/skill-sync/` on the shared `convexSite` domain | §2.3, §3 | Daemons' saved endpoint changes (4.4) |
| `workers_dev: false` | none | §3 | Default URLs cannot be shown to be off |
| Passkey RP `jive.sh`, `@simplewebauthn/server` | Same library in an HTTP action; expected origin from an environment variable | §2.3 | `request.url` under a custom domain unverified |
| Challenges table with expiry | Table plus a scheduled delete at expiry | [scheduling from mutations](https://docs.convex.dev/scheduling/scheduled-functions#scheduling-from-mutations) | No TTL; the scheduler stands in |
| `DEV_TOKEN` in `.dev.vars` | Environment variable set only on the dev deployment | [environment variables](https://docs.convex.dev/production/environment-variables#setting-environment-variables) | None |
| `test/e2e.ts` against `wrangler dev` | The same test against a local self-hosted backend | §6 | None |

### 4.2 The Hub's messages, mapped

| Today (Hub message, `@jive-sh/skill-sync` `wire.ts`) | After |
| --- | --- |
| Hub → daemon `prefs` | Daemon subscribes to `prefsFor(machine)`; a dashboard change re-runs it |
| Hub → daemon `changed` | Daemon subscribes to the highest `seq`; a rise starts a cycle. The 5-minute poll stays as the fallback |
| Daemon → hub `status` | Mutation `reportStatus` |
| Daemon connects (online, version header) | Presence heartbeat carrying the daemon version |
| Dashboard `setFolder`, `setSkill`, `renameMachine` | Three mutations |
| Hub → dashboard `snapshot` on every change | Dashboard subscribes to a `snapshot` query; Convex re-runs it on change |

The REST routes (`/folders`, `/files`, `/skills`, `/content/*`, `/cli/token`, `/login/*`, `/register/*`) keep
their shapes, under `/skill-sync/`, still authorised by the device token, hashed as today.

### 4.3 Authentication

- **Daemon.** It keeps its device token for REST. For subscriptions it trades the token at
  `/skill-sync/session-jwt` for a short-lived ES256 JWT (`sub` = machine), and `setAuth` refetches it on expiry
  ([`setAuth`](https://docs.convex.dev/api/classes/browser.ConvexClient#setauth)). Revoking a device token stops
  new JWTs; an issued one lives until it expires.
- **Dashboard.** The `SameSite=Strict` cookie still guards the HTTP routes on `api.jive.sh`. The page trades it
  for the same kind of JWT, because a cookie does not travel to `*.convex.cloud`.
- **Keys.** The backend abstract generates the pair once: `JWT_PRIVATE_KEY` signs, and `JWT_JWKS` is a data URI
  that `auth.config.ts` reads as `jwks: process.env.JWT_JWKS` (§3.1), so no JWKS endpoint has to be up for
  Convex to verify
  ([custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt#server-side-integration)).

### 4.4 Cutover

1. Build the component and functions; run `test/e2e.ts` against a local backend.
2. Build daemon 0.5.0: `ConvexClient` for live updates, presence heartbeats, the realtime URL fetched from
   `api.jive.sh`, and a saved endpoint of `https://skill-sync.jive.sh` rewritten to `https://api.jive.sh/skill-sync`.
3. Deploy through the abstract, which creates the deployment and the `api.jive.sh` custom domain (§3.1).
   **Outward-facing:** `api.jive.sh`
   serves the app's Worker today. Nothing in the app's browser client uses it, since the client calls `/api` on
   its own host (`app/src/server/handler.ts:40-50`). Whether anything else calls `api.jive.sh` is unknown; the
   zone's analytics would show it.
4. Freeze the Worker: every write returns "upgrade skill-sync". Old daemons upgrade themselves within about five
   minutes, because auto-upgrade asks the package manager every 5 minutes and does not depend on the server
   ([daemon header](https://github.com/jive-sh/skill-sync/blob/3851a8650e78f660b860bf108994d16e24b60931/src/daemons/skill-sync-daemon.ts#L35-L36)).
5. Copy D1 rows (credentials, device tokens, folders, skills, synced skills, machines, files) and every blob
   referenced by `files.hash`. Machines stay signed in and the passkey keeps working. Sessions are dropped, so
   the dashboard asks to sign in once.
6. Publish daemon 0.5.0. Edits made during the freeze stay on disk and win on the next cycle, because the latest
   edit wins.
7. Once the dashboard shows every machine on 0.5.0, delete the Worker, D1 and R2. **Irreversible.**

Changes users will see: the dashboard moves to `https://api.jive.sh/skill-sync/`; a dropped machine stays online
until its heartbeat times out; one dashboard sign-in after cutover.

---

## 5. `@jive-sh/app` splits into `@jive-sh/server` and `@jive-sh/app`

### 5.1 What goes where

| Today in `@jive-sh/app` | After |
| --- | --- |
| `src/modules/*` (accounts, passkeys, projects, integrations, connections, sessions, grants, crypto, WebAuthn) | `@jive-sh/server`: tables plus queries, mutations and actions |
| `src/api/handlers/*` and their authority checks (`requireProject`, `requireOwner`, `requireStepUp`) | `@jive-sh/server`: public functions, each checking authority itself. My inference: any client of the deployment can call a public function by name, so the check lives in the function, as it lives in each handler today |
| `src/api/contract.ts`, the Effect `HttpApi`, and the published `@jive-sh/app-client` | Replaced by `@jive-sh/server`'s generated client. The shared vocabulary (`ActorKind`, `ProjectRole`, `Grant`) moves into the server's function argument and return types |
| `src/pages/*` (react-native components through react-native-web) | `@jive-sh/app`, extending `jive-abstract-app-expo`, importing the server's client |
| `src/server/*`, `src/bindings.ts`, `src/modules/sql`, `src/modules/database`, `effect-qb` and its patch, `src/scripts/*`, `dist/wrangler.jsonc` | Removed. The two abstracts replace the scripts |

### 5.2 Piece by piece

| Cloudflare piece (`app/dist/wrangler.jsonc`, `system-design.md`) | Convex equivalent | Source | What Convex can't do |
| --- | --- | --- | --- |
| Worker `jive-sh-app` serving `/api/*` through Effect `HttpApi` | `@jive-sh/server`'s public functions, called through its client; no HTTP router | [JavaScript clients](https://docs.convex.dev/client/javascript#convex-client) | Effect 4 inside Convex functions is unverified; the runtime supports most libraries that work on Workers ([supported APIs](https://docs.convex.dev/functions/runtimes#supported-apis)) |
| `ASSETS` (the built SPA, `run_worker_first`) | `@jive-sh/app`, deployed by `jive-abstract-app-expo` to EAS Hosting (§3.1) | [custom hosting](https://docs.convex.dev/production/hosting/custom#:~:text=any%20static%20hosting%20provider) | **Convex does not host frontends**, so the frontend is the Expo abstract's to deploy |
| D1 `jive-sh-app-db` through `effect-qb` → `SqlDriver` → D1 | Convex tables. The module interfaces (`Accounts`, `Projects`, `Sessions`, `Integrations`, …) stay; their implementations become queries and mutations | [transactions](https://docs.convex.dev/functions/mutation-functions#transactions) | **No SQL.** This is the largest piece of work. Each use case that must not half-apply, registration first, is one mutation, which gives real transactions where D1 offered only `batch` (`app/docs/db-model.md:11-15`) |
| WebAuthn through `@simplewebauthn/server` | Verification in actions, since queries and mutations must be deterministic; challenges generated there too | [restrictions](https://docs.convex.dev/functions/runtimes#restrictions-on-queries-and-mutations), [Web Crypto](https://docs.convex.dev/functions/runtimes#web-crypto-apis) | None found; §7 check 3 |
| KV `EPHEMERAL` (challenges with a TTL) | A table plus a scheduled delete | [scheduling](https://docs.convex.dev/scheduling/scheduled-functions#scheduling-from-mutations) | No TTL. Gain: KV's eventual consistency (`system-design.md:38-40`) goes; a spent challenge is deleted in the same transaction that checks it |
| Bearer session tokens (`jive_…`, resolved per request) | Jive-issued JWTs set on the client (§8, question 4) | [`setAuth`](https://docs.convex.dev/api/classes/browser.ConvexClient#setauth), [custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt#server-side-integration) | Revocation: today removing a member stops their minted tokens at once (`system-design.md:134-137`). A JWT stays valid until it expires unless each function also checks the session row, so every function keeps that check |
| Worker secret `CONNECTION_KEY` | Environment variable (values up to 8 KiB) | [env vars](https://docs.convex.dev/production/environment-variables#setting-environment-variables), [limits](https://docs.convex.dev/production/state/limits#environment-variables) | None. Generated once by the backend abstract (§3.1 item 3) |
| Vars `WEBSITE_DOMAIN`, `API_DOMAIN`, and the CORS for a split API host (`handler.ts:51-122`) | `WEBSITE_DOMAIN` as an environment variable for the expected WebAuthn origin. `API_DOMAIN` and the CORS code go, since there is no HTTP API of the server's own | same | None |
| Custom domains as wrangler routes, plus the zone-access check (`cloudflare-access.ts`) | Convex custom domain `api.jive.sh`, created by the backend abstract | §3, §3.1 | Pro only (team `jive` is on Pro) |
| The six hooks (`src/scripts/*`), including publishing `@jive-sh/app-client` | `jive-abstract-backend-convex`'s hooks for `@jive-sh/server`, which also publish its client; `jive-abstract-app-expo`'s for `@jive-sh/app` | §3.1 | None |
| Tests over `bun:sqlite` and a `Map` (`src/testing/bindings.ts`) | Tests against a local backend; Convex lists "a testing harness" among its open-source projects ([self-hosting](https://docs.convex.dev/self-hosting#open-source-convex-backend)) | | Which harness fits is not researched |

### 5.3 Other changes

- The schema migration "applied once per isolate" (`system-design.md:191-194`) goes with D1; how Convex
  validates and migrates a schema on deploy is not researched here.
- Passkey ceremonies still run on `jive.sh` pages with relying party `jive.sh`, verified against the origin
  `https://jive.sh`, as today.

### 5.4 Cutover

Whether the app's D1 holds anything worth keeping is unchecked (reading it needs Cloudflare access). If it
holds only test accounts, the plan re-registers rather than migrating D1; otherwise rows are copied as in §4.4.
Moving `jive.sh` to EAS Hosting (its DNS records in §3.1) and retiring the Worker are outward-facing and wait
for a yes at that time.

---

## 6. Local Convex on each machine

Per §23, each machine runs its own Convex for running work and showing tasks.

- **Self-hosted backend, not `convex dev --local`.** Local deployments are a beta development feature that
  runs as a subprocess of `npx convex dev` and is "not recommended for production use"
  ([local deployments](https://docs.convex.dev/cli/local-deployments#local-deployments-vs-production)). The
  self-hosted `convex-local-backend` binary runs on its own, stores SQLite in its working directory, and
  listens on `127.0.0.1:3210` (API) and `:3211` (HTTP actions)
  ([running the binary](https://github.com/convex/convex-backend/blob/bb31399c8704ceb6c19003936f6e144375b2c3bc/self-hosted/advanced/running_binary_directly.md),
  [README](https://github.com/convex/convex-backend/blob/bb31399c8704ceb6c19003936f6e144375b2c3bc/self-hosted/README.md#self-hosting-convex)).
- **A Jive daemon runs it.** Starting at login is what Jive daemons already do; the daemon generates the
  instance secret and admin key on first start so no person handles them.
- **Builds.** Every precompiled release is marked pre-release, for macOS arm64 and x86_64, Linux arm64 and
  x86_64, and Windows x86_64 ([releases](https://github.com/convex/convex-backend/releases)).
- **License.** The backend is FSL Apache 2.0: anything Apache-2.0 allows "except create another product designed
  to compete with the hosted Convex Cloud" ([self-hosting](https://docs.convex.dev/self-hosting#open-source-convex-backend)).
  My reading is that running it inside Jive does not compete with Convex Cloud. That is a reading, not advice.
- **Known self-hosted issues.** About four and a half minutes of rejected queries after a deploy while sessions
  are connected ([#466](https://github.com/convex/convex-backend/issues/466)); deploys timing out
  ([#341](https://github.com/convex/convex-backend/issues/341)); files and logs not deleted
  ([#93](https://github.com/convex/convex-backend/issues/93)). All open.
- **Workflow component:** §2.4.

---

## 7. Checks before building

Checks 1 to 3 run on this Mac against a local self-hosted backend, so nothing is created on Convex Cloud:

1. A Bun-compiled binary using `ConvexClient` subscribes with a custom JWT, gets updates, and survives the
   backend restarting (§2.1).
2. An app using the workflow component runs a two-step workflow with a sleep, and resumes after the backend
   restarts (§2.4).
3. Effect 4 runs inside Convex queries, mutations and actions, and `@simplewebauthn/server` inside an action
   (§5.2).
4. If skill-sync keeps HTTP routes: what `request.url` and the `Host` header hold in an HTTP action. On the
   cloud this needs the custom domain, so it runs right after step 3 of §4.4.
5. A backend that mounts a local component and the presence component deploys through
   `jive-abstract-backend-convex` (§3.1 item 5). This needs a throwaway project in team
   `jive`, deleted afterwards, as that thread's tests did.

---

## 8. Decisions for Alex

1. **Should skill-sync's backend live inside `@jive-sh/server`, in the same central deployment?**
   - Yes, as a component *(recommended)*. Buys: one central server as §23 states, skill-sync's tables sealed
     off from stored credentials, one passkey store later. Costs: daemons' saved endpoint changes, and its
     authenticated routes are written in `@jive-sh/server` (component HTTP actions have no `ctx.auth`).
   - Its own package and deployment at `skill-sync.jive.sh`. Buys: no endpoint change, independent cutover.
     Costs: two central servers.
2. **Should `api.jive.sh` serve the realtime API, which the published client calls?** This replaces my earlier
   recommendation of HTTP actions; the package split removed the REST contract that justified it.
   - Realtime *(recommended)*. Buys: every client (browser, daemon, agent) bakes in a Jive-owned host. Costs:
     skill-sync's daemon moves wholly onto the client, and its dashboard moves into `@jive-sh/app` (§4).
   - HTTP actions. Buys: skill-sync's REST routes and pages keep a `jive.sh` host unchanged. Costs: the
     published client bakes in a `*.convex.cloud` host.
3. **Is the central copy of workflow definitions synced from git, or is the central server their source?**
   §10.4 has git owning definitions; §23 has the central server syncing them.
4. **Should every caller of the server (browser, daemon, agent, pipeline) sign in with a Jive-issued JWT?**
   - JWTs *(recommended)*. Buys: Convex's documented auth, one mechanism for every caller. Costs: a signing
     key, a token exchange, and a session check in each function so revocation stays immediate (§5.2).
   - A session token passed as a function argument. Buys: today's token model unchanged. Costs: a secret in
     every call's arguments, and whether Convex logs arguments is unchecked.
5. **Should skill-sync's own passkey table merge into the server's accounts during this migration, or after?**
   After *(recommended)*: one change at a time, and the relying party is already shared.
6. **Are you comfortable shipping Convex's FSL-licensed backend inside Jive on every machine?** §6.

7. **Should `@jive-sh/app` take the server's address from `@jive-sh/server`'s client (`convexUrl`), or from a
   per-environment variable?**
   - The client's `convexUrl` *(my recommendation)*. Buys: one source for the address, the server's deploy.
     Costs: with a second environment, such as Staging, the app has to import that environment's client
     version too.
   - `EXPO_PUBLIC_SERVER_URL` per environment *(the Expo thread's recommendation)*. Buys: any number of
     environments from one build. Costs: the address is copied into `@jive-sh/app`'s settings and can drift.

Where `jive.sh` is hosted is settled by `jive-abstract-app-expo`: EAS Hosting. Whether to pay for Expo's plan
that allows a custom domain goes to Alex from that thread.
