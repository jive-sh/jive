# Jive API v1: core resources, and provisioning a package from a pipeline

**Status:** the first slice (§12) is built up to the npm connection, which Alex stores by hand. Released:
`jive-abstract-connector-package-registry` 0.3.0, `jive-connector-package-registry-npm` 0.2.0 and
`jive-abstract-library` 0.3.0. `@jive-sh/server` is committed but not pushed or deployed to production; it runs on
the dev deployment `adorable-giraffe-46` in project `jive-server`, team `jive`. On 2026-10-26 Alex set the
framing and decided ten of the eleven questions, set the direction on question 4, and the coordinating thread
decided question 7's mechanism (§2). Within each section, what he left open has options and my recommendation.
**As of:** October 26, 2026
**Builds on (settled, not re-decided here):** [architecture discussion §22–25](jive_architecture_discussion.md#22-decisions-package-model-and-naming-2026-10-22)
and the [Convex migration plan](convex_migration_plan.md). In short: the central server, `@jive-sh/server`, is a
Convex deployment that holds every credential; a CI job proves who it is with its GitHub OIDC ID token; connector
implementations are Convex components the server installs; a new npm package is provisioned as placeholder →
trusted publisher → CI publishes by OIDC ([§25.6](jive_architecture_discussion.md#256-provisioning-a-new-npm-package-2026-10-26)).

**How claims are marked.** "Decided" quotes Alex's own words, dated. Every statement about npm, GitHub or Convex
links the passage it rests on. "My inference" marks a reading of a source; "my idea" marks a proposal of mine that
no source or decision contains; "the coordinating thread's idea" marks a proposal from the agent thread that put
these questions to Alex. Code links are pinned to a commit.

---

## 1. What v1 has to do

Alex's target (2026-10-26): a workflow contacts the Jive API to provision a package; the organization's
package-registry connector does the provisioning (for npm: log in, publish a stub package, set up trusted
publishing); then the deploy resumes. Long term, GitHub Actions holds no secrets: static settings come from the
package's `jive` config in `package.json`, outside systems are reached through connectors, and the pipeline sends
Jive only its OIDC ID token.

What exists today:

| Piece | State |
| --- | --- |
| `jive-connector-package-registry-npm` | Implemented and tested against a fake registry, never run against npm ([README](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/b7442097c9d94262b5bccb43a7c725ae66251e74/README.md#how-it-is-verified)). Version 0.1.0 is on npm (`npm view`, checked 2026-10-26). Its four actions take `account: { token }` and answer `secondFactorRequired`, optionally with npm's browser-approval page ([`packageRegistry.ts`](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/b7442097c9d94262b5bccb43a7c725ae66251e74/src/component/packageRegistry.ts#L54-L107)). |
| The contract it implements | [`PackageRegistryComponentApi`](https://github.com/jive-sh/jive-abstract-connector-package-registry/blob/23f7134b303e94dbdcda0402b30727c69022abaf/src/internal/public/contract.ts#L24-L53): `packageExists`, `createPlaceholder`, `listTrustedPublishers`, `registerTrustedPublisher`. No login, no removal of a publisher, no publisher status. |
| `@jive-sh/server` | Designed, not built ([migration plan §3](convex_migration_plan.md#3-the-central-deployment)). Not on npm. |
| The pipeline | Every hook runs from Jive's reusable workflow. The build job (build, audit, `deploy:plan`) has no `environment`; the deploy job runs in the GitHub environment named after its target with `id-token: write` ([reusable-pipeline.yml](https://github.com/jive-sh/jive/blob/025e667f408bf982662edeeeb18b33751f19037a/.github/workflows/reusable-pipeline.yml#L76-L92)). A caller grants `id-token: write` in its own `pipeline.yml` ([example](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/b7442097c9d94262b5bccb43a7c725ae66251e74/.github/workflows/pipeline.yml#L12-L21)). |
| Publishing | `jive-abstract-library`'s `publishPackage` publishes with `NPM_TOKEN` when set, else by trusted publishing ([npm module](https://github.com/jive-sh/jive-abstract-library/blob/5b1a2606c1e194fb6921affb26e42e6d3f211611/src/internal/modules/npm/impl.ts#L66-L75)); the Convex backend abstract publishes its client through the same function ([migration plan §3.1](convex_migration_plan.md#31-deployment-through-the-two-abstracts)). |

### npm facts that shape every decision below

- **Every change to trusted publishing needs an interactive second factor.** Since July 31, 2026 a token that
  bypasses 2FA can no longer change "package access, maintainers, or trusted publishing configuration"; those
  "require an interactive 2FA challenge" ([GitHub changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/#what-now-requires-an-interactive-2fa-challenge)).
  `npm trust` itself needs 2FA on the account and rejects bypass-2FA tokens ([npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust#prerequisites)).
  So every new package costs at least one second-factor answer; under §8's decision, a code from the account's
  authenticator-app (TOTP) secret, which Jive holds, gives it.
- **npm's second factor is a security key.** npm's 2FA page says "You will be prompted to authenticate with a
  security-key" ([about 2FA](https://docs.npmjs.com/about-two-factor-authentication#:~:text=prompted%20to%20authenticate%20with%20a%20security%2Dkey)),
  and a security key "can only be configured from the web" ([configuring 2FA](https://docs.npmjs.com/configuring-two-factor-authentication#enabling-2fa-from-the-command-line)).
  The docs I read describe no authenticator-app codes. §8's decision relies on npm accepting one, which is the open
  risk recorded there.
- **One answer can cover several calls.** During the 2FA approval "you'll see an option on the npm website to skip
  two-factor authentication for the next 5 minutes" ([npm trust, bulk usage](https://docs.npmjs.com/cli/v11/commands/npm-trust#bulk-usage)).
- **Direct publishing with an access token is ending.** "The ability to publish new package versions directly
  with a granular access token will be removed in January 2027"; automation should use stage-only tokens, whose
  versions "must be reviewed and promoted by a maintainer with two-factor authentication" ([npm access tokens](https://docs.npmjs.com/about-access-tokens#direct-publishing-is-being-deprecated),
  [stage-only tokens](https://docs.npmjs.com/about-access-tokens#about-stage-only-tokens)). The GitHub changelog
  scopes the same change to 2FA-bypass tokens only ([coming next](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/#coming-next)).
  The two sources disagree on scope; my reading is that the connector's placeholder publish (a token plus a
  one-time password) may stop working in January 2027 and should be proven against the staged route (§8).
- **Staged publishing can now create a package.** Since October 2, 2026, `npm stage publish` can create a new
  package "using a local session or a granular access token, including a stage-only token"; the first version
  "requires a maintainer to promote it" ([GitHub changelog](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages#:~:text=You%20can%20now%20create%20a%20new%20npm%20package)).
- **A trusted publisher must publish within 2 days** or it "expires and can no longer be used or edited"; the
  remedy is to "delete the expired configuration, create a new one" ([npm](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)).
  "Expired configurations remain visible in trusted publisher settings but don't count toward per-package
  limits" ([GitHub changelog](https://github.blog/changelog/2026-10-02-unvalidated-npm-trusted-publishing-configurations-now-expire#:~:text=Expired%20configurations%20remain%20visible)).
- **npm matches the calling workflow, not the reusable one.** With `workflow_call`, "validation checks the calling
  workflow's name" ([npm](https://docs.npmjs.com/trusted-publishers#:~:text=validation%20checks%20the%20calling%20workflow)),
  which is why every Jive publisher names `pipeline.yml`.
- **How many publishers a package may have: sources disagree.** The trusted-publishing page says "up to 10"
  ([limitations](https://docs.npmjs.com/trusted-publishers#limitations-and-future-improvements)); `npm trust`'s
  page says "the registry only supports one configuration per package" ([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust#description)).
  This matters for a package that deploys to two environments (§5) and for two jobs registering at once (§9).
- Trusted publishing works only on cloud-hosted runners ([limitations](https://docs.npmjs.com/trusted-publishers#limitations-and-future-improvements)).

---

## 2. Where each decision stands

The coordinating thread asked Alex eleven questions on 2026-10-26. His answers are quoted in full in the sections
listed.

| # | Question | Status | Section |
| --- | --- | --- | --- |
| 1 | The shape of the v1 API | **Decided:** core resources, each created as an instance; call names open | §3 |
| 2 | How a pipeline authenticates | **Decided:** Jive checks the GitHub ID token of a registered repository; mechanism open | §4 |
| 3 | Where in the pipeline the call happens | **Decided:** in `deploy`, an idempotent call right before every npm publish | §5 |
| 4 | Which token claims authorize provisioning | **Direction set:** use the token's environment; branch protection set up when a code repository is provisioned. To iterate | §6 |
| 5 | How a repository is registered | **Decided:** through a GitHub connector, whose connection may be an employee's login. GitHub App versus login open | §7 |
| 6 | How npm's second factor is answered | **Decided:** Jive holds the npm account's authenticator-app (TOTP) secret, sealed with `CONNECTION_KEY`; the connector computes the code. Whether npm allows an authenticator app beside a security key is an open risk | §8 |
| 7 | Concurrency and retries | **Built as the coordinating thread decided:** a per-package claim row taken in a mutation before the action calls npm; no workflow component | §9 |
| 8 | The 2-day trusted-publisher expiry | **Decided:** registered in the deploy, re-set up next time. Build item: replace an expired publisher | §10 |
| 9 | Bootstrapping `@jive-sh/server`'s own deploy | **Decided:** a Convex deploy key to bootstrap; long term a Convex connection like any other | §11 |
| 10 | Which package goes first | **Decided:** one throwaway test package, reused for every test run | §12 |
| 11 | Raising to 20 minutes the wait between a platform package being published and npm serving it for download | **Decided:** stays at 15 minutes; monitoring later; past 15 minutes means optimizing, not raising the limit | §12 |

---

## 3. Core resources, and the v1 calls on each

**Decided (Alex, 2026-10-26):** "You need to think of core resources that Jive manages. Jive manages packages, it
managers organizations, it manages code repositories. You create instances of different resources. I think there'll
probably be APIs for creating connections too (initializing a connector for a given user). Creating workflows (this
will add the convex component to that persons org). In the package case, I think a deploy script it will start by
provisioning the package with Jive, then it will publish the package."

Three things are called "workflow" in this design, so to keep them apart: a **Jive workflow** is the resource below;
a **GitHub Actions workflow** is a `.yml` file like `pipeline.yml`; the **Convex workflow component** is the durable
step runner the earlier draft of §9 proposed and this one no longer uses.

**Decided (Alex, 2026-10-28):** "All actions are callable by person or machine. That's the vision we're heading
towards", and "There's no 'kind of caller'. There's a session token. That's it". So every call below takes a
Jive session token and nothing else; how the token was obtained (a person's `jive.sh` passkey, or a pipeline
exchanging its GitHub OIDC ID token, §4 option c) is sign-in, separate from every API call. The "Who calls it"
column says only who calls it first. Today `packages:provision` takes the GitHub ID token directly (§4 option a),
so it does not match this yet.

**Decided (Alex, 2026-11-01):** resource types are open-ended, not a fixed core set: "What we don't have is a
standard for defining new types of resources that can belong to a jive organization", and "Each resource [type] would
be a convex component". So a resource type is an abstract (a library); its implementation is a library that ships a Convex component, the way a
connector does; and its instances are records in that component, in the organization's deployment (Alex's summary, same day). Proposed: `jive-abstract-resource`, so `jive create resource` creates a new
resource type, as `jive-abstract-library` does for libraries. Open: the standard calls every resource component
exposes, and how a new type reaches a deployment (today `@jive-sh/server` installs components statically in
`convex/convex.config.ts`, so a new type needs a server deploy).

**Decided (Alex, 2026-11-01):** names follow the extends path, "resource" included (`jive-abstract-resource-connector`,
`jive-resource-connector-package-registry-npm`), 'because `jive provision` needs a list of packages to choose from in the
same way `jive create` looks at the [abstract] prefix'. Also (direction, same day): "there'll be a jive provision command which will have us choose one
of the packages which is a resource and if that component isn't installed in the convex server for that specific jive
organization, it'll run an install". So each organization has its own Convex deployment. Convex 1.48.0 has no install
call: a component is installed by `app.use` in `convex/convex.config.ts` and a deploy, so the install step regenerates
that organization's config and deploys it. This settles the page's earlier open decision "Creating outside resources"
(one connector abstract per kind, not one server endpoint per kind).

The call names below are my proposal, one namespace per resource.

| Resource | What an instance is | v1 call | Who calls it | In the first slice (§12) |
| --- | --- | --- | --- | --- |
| Organization | The owner of the connections, code repositories, packages and Jive workflows below | `organizations.create({ name })` | A person | One, seeded by hand |
| Connection | A connector initialised for a user: Alex's words, "initializing a connector for a given user". For npm, the npm account's token and its authenticator-app secret, held sealed by Jive (§8); for GitHub, an App installation or a person's login (§7) | `connections.create({ organizationId, connector })` | A person | The npm connection, seeded by hand |
| Code repository | A GitHub repository registered to an organization by its immutable ids. Registering it makes Jive accept its ID tokens (§4) and sets up branch protection (§6) | `codeRepositories.provision({ organizationId, connectionId, owner, name })` | A person | One, seeded by hand |
| Package | A registry package bound to one code repository | `packages.provision({ registry: "npm", packageName })` | The deploy job | Built first |
| Jive workflow | Alex's words: "this will add the convex component to that persons org" | `workflows.create({ organizationId, component })` | A person | No |

**`packages.provision`**, in order, on every call (my idea, assembled from §5 to §10):

1. Verify the caller's ID token (§4) and its claims (§6); find its code repository and, through it, the
   organization. An unregistered repository is refused.
2. Claim the package so a parallel deploy job does not act at the same time (§9).
3. Through the organization's npm connection: publish the placeholder if the package does not exist; confirm the
   account maintains the package; make sure an unexpired publisher matching the calling job exists, deleting an
   expired one first (§10). Each step reads npm before it writes, so a repeated call changes nothing.
4. Record what was done, release the claim, and answer `ready` or `refused { reason }`.

The deploy job then publishes by OIDC itself; publishing is not a Jive call. A call never answers `ready` from
the record alone, because npm can change underneath it (a publisher expires, a maintainer is removed).

**Open within §3:**

- Whether a connection belongs to a person or to an organization. Alex's words say "for a given user", and for
  Convex (§11) "connector from user to convex account, org uses user's connection"; the earlier
  draft gave each organization one npm connection used by all its repositories
  ([§7.5](jive_architecture_discussion.md#75-a-librarys-instance-binding) covers choosing among several).
- What a Jive workflow instance holds beyond the component it installs, and whether v1 needs one at all.
- Whether `packages.provision` returns only when finished or answers at once and the job asks again. It depends on
  how long npm's steps take (unmeasured) and on what a job that loses the claim does (§9).
  The earlier draft's `waitingForPerson` state is gone, since §8 removes the person-step.
- Whether connector operations are also exposed through a generic call (the `invoke({ resource, operation, args })`
  shape `@jive-sh/app` designed but never built, [api.md](app/docs/api.md#not-implemented)). Not needed for v1.

Inside the server, every resource reaches a connector through one internal function (my idea): given a verified
caller and a connector kind, it finds the caller's organization, that organization's connection of that kind and
its credential, and calls the component with the credential filled in.

---

## 4. How a pipeline authenticates to the server

**Decided (Alex, 2026-10-26):** "Jive checks the Github ID token. We'll build out various means of authenticating
requests. Once a repo is registered in Jive, Jive will authorize the ID tokens from that repo."

**Open:** the mechanism that checks it. GitHub's issuer is `https://token.actions.githubusercontent.com`, its keys
are at `https://token.actions.githubusercontent.com/.well-known/jwks`, and it signs with RS256 only
([openid-configuration](https://token.actions.githubusercontent.com/.well-known/openid-configuration)). A job asks
for a token with its own audience through `ACTIONS_ID_TOKEN_REQUEST_URL`
([GitHub](https://docs.github.com/en/actions/reference/security/oidc#methods-for-requesting-the-oidc-token)).

- **a. Convex verifies GitHub's token itself** *(recommended)*: `auth.config.ts` lists GitHub as a `customJwt`
  provider with that issuer, JWKS URL, `RS256`, and `applicationID: "https://api.jive.sh"`, which Convex checks
  against `aud` ([custom JWT](https://docs.convex.dev/auth/advanced/custom-jwt#server-side-integration)). GitHub's
  claims arrive on `ctx.auth.getUserIdentity()`: "Any additional fields are custom claims"
  ([UserIdentity](https://docs.convex.dev/api/interfaces/server.UserIdentity#:~:text=Any%20additional%20fields%20are%20custom%20claims)).
  Buys: no verification code of ours, the typed published client. Costs: people and pipelines then sign in to
  the same deployment through two issuers, so every public function must check `identity.issuer` before trusting
  any claim (one shared helper, my idea); and the token is short-lived (GitHub's example token has `exp` 300
  seconds after `iat`, [example](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows#how-the-token-works-with-reusable-workflows),
  my inference), so a job that calls more than once fetches a fresh token before each call.
- **b. An HTTP action verifies the token by hand** and serves a REST route. Costs: our own JWT verification and no
  typed client, for no gain over (a).
- **c. Exchange it for a Jive-issued JWT** ([migration plan §8 question 4](convex_migration_plan.md#8-decisions-for-alex)
  recommends Jive JWTs for every caller). Buys: one issuer, claims mapped once, and a natural place for Alex's
  "various means of authenticating requests". Costs: a signing key and an extra call before the first real one.

Convex's plain "OIDC provider" entry does not fit GitHub: it requires `${domain}/.well-known/jwks.json`
([custom OIDC](https://docs.convex.dev/auth/advanced/custom-auth#server-side-integration)), and GitHub answers that
path with 404 while `/.well-known/jwks` answers 200 (checked with curl, 2026-10-26). Hence `customJwt`.

---

## 5. Where in the pipeline the call happens

**Decided (Alex, 2026-10-26):** "In `deploy`. It's an idempotent API call that always runs right before the actual
npm publish."

What this changes from the earlier draft: the call runs on every deploy, not only when the package is missing from
the registry. That is what lets each deploy repair an expired publisher (§10) and retry a provisioning that failed
last time (§9).

Where in `deploy`, concretely (my recommendation, unchanged): in `jive-abstract-library`'s `publishPackage`, which
the Convex backend abstract also uses for its client
([source](https://github.com/jive-sh/jive-abstract-library/blob/5b1a2606c1e194fb6921affb26e42e6d3f211611/src/internal/public/release.ts#L56)).
The deploy job is the only job with an `environment` and `id-token: write`
([reusable-pipeline.yml](https://github.com/jive-sh/jive/blob/025e667f408bf982662edeeeb18b33751f19037a/.github/workflows/reusable-pipeline.yml#L76-L92)),
so the token says which environment publishes. A package that skips `publishPackage` must make the call itself.

**Open:** a package deploying to two environments (say `latest` and `next`) needs one publisher per environment,
or one with no environment, which admits any job of `pipeline.yml`
([contract](https://github.com/jive-sh/jive-abstract-connector-package-registry/blob/23f7134b303e94dbdcda0402b30727c69022abaf/src/internal/public/contract.ts#L99-L108)).
Which works depends on the one-versus-ten disagreement in §1; the first live run settles it.

---

## 6. Which token claims authorize provisioning

**Direction set (Alex, 2026-10-26):** "I think the ID token includes things like the environment. We can iterate
more on this. I do think there'll be some kind of protected branches setup that occurs when provisioning a code
repo."

Claims available include `repository_id`, `repository_owner_id`, `environment`, `event_name`, `ref`,
`ref_protected`, `workflow_ref`, `job_workflow_ref` and `runner_environment`
([GitHub claims](https://docs.github.com/en/actions/reference/security/oidc#custom-claims-provided-by-github)).
`environment` is present only when the job references one
([GitHub](https://docs.github.com/en/actions/reference/security/oidc#filtering-for-a-specific-environment)).
In a reusable workflow, `workflow_ref` describes the caller and `job_workflow_ref` the called workflow
([GitHub](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows#how-the-token-works-with-reusable-workflows)).
Names can be recycled; GitHub moved new repositories to an owner-ID and repository-ID subject for that reason
([immutable subject claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)).

The checks his direction points to (my reading of it, to iterate on):

- `repository_id` and `repository_owner_id` match a registered code repository (never names).
- `environment` is present, and the publisher is registered for exactly that environment.
- `ref_protected` is true. `codeRepositories.provision` sets up the branch protection that makes it so; without
  that step, a repository whose GitHub environment allows every branch lets a deploy job on any pushed branch
  provision.
- `event_name` is `push` or `workflow_dispatch` (not a pull request, and not Dependabot's `dynamic`,
  [GitHub](https://docs.github.com/en/actions/reference/security/oidc#oidc-claims-used-to-define-trust-conditions-on-cloud-roles)).
- The file in `workflow_ref` is `pipeline.yml`, and `runner_environment` is `github-hosted`, since npm refuses a
  self-hosted runner's trusted publish anyway (§1).

**Open:** what "protected branches setup" configures (which branches, which rules); which GitHub permission the
GitHub connection needs to change branch protection (unverified, and it bears on §7's App-versus-login
comparison); and whether pinning `job_workflow_ref` to Jive's reusable pipeline adds anything (by my inference
little, since the package's own scripts run inside that same job).

Under any of these, the first successful provisioning binds the package name to its code repository; another
repository asking for that name is refused (my idea).

---

## 7. How a code repository is registered

**Decided (Alex, 2026-10-26):** "I think, in order to handle cases where someone doesn't have the ability to
install a github app to their org, it'll happen through a connector to Github where a connection might even just be
an employee's login at a company. We can game out what github app would give us versus a normal login."

So `codeRepositories.provision` acts through a GitHub connection, and a GitHub connection is either a GitHub App
installation or a person's own GitHub login. This replaces the earlier draft's options (a person typing in each
repository, a GitHub App only, an organization named in `package.json`, a whole GitHub owner linked).

**Open:** the comparison Alex asked to game out, GitHub App versus a person's login. Not yet researched. The
questions it must answer for each:

- Can it read repository ids and set up branch protection (§6)?
- Who has to approve it: an organization admin, or the person alone?
- What happens when the person leaves the company or loses access?
- How long does its credential last, and how does the server renew it?
- What does it let a breach of the server do to the person's or organization's repositories?

---

## 8. How npm's second factor is answered, and how it is protected

**Decided (Alex, 2026-10-26, replacing the security-key decision below):** "for blocker 1, option a, we'll hold the
totp secret in jive". Option a was the held authenticator-app (TOTP) secret, against approval in the person's
Chrome through an extension, or a person approving each package.

So:

- Connecting an npm account stores its token and the shared secret of its authenticator app (RFC 6238, base32 as
  npm's two-factor setup shows it) in `@jive-sh/server`, in the `connections` table. Both are sealed together at
  rest the way `@jive-sh/app` seals connection payloads: AES-256-GCM under `CONNECTION_KEY`, stored as
  `<nonce>.<ciphertext>` base64url beside the version of the key that sealed it
  ([app crypto](app/src/modules/crypto/impl.ts), [db-model `sealed_payload`, `key_version`](app/docs/db-model.md),
  [system-design cryptography](app/docs/system-design.md#cryptography)). `CONNECTION_KEY` is `<version>:<base64 32
  bytes>`, which `jive-abstract-backend-convex` generates once per deployment
  ([generate-once keys](https://github.com/jive-sh/jive-abstract-backend-convex/blob/ff09f78b3cd3d63ec86c97062ed47b21ecd8b836/README.md#generate-once-keys)).
- The server opens the credential only inside the provisioning action and passes it to the npm connector as
  `account: { token, secondFactor: { type: "totp", secret } }`. The connector sends each request without a code;
  when npm refuses it for want of a one-time password (its EOTP: a 401 whose `www-authenticate` lists `otp`, or
  whose body mentions one), it computes the current 6-digit code (HMAC-SHA-1, 30-second steps) and sends the
  request once more with it as `npm-otp`. A second refusal fails the call. Nothing logs or returns the secret
  or a code.
- Provisioning never waits for a person, which is what the security-key decision was for.

**Open risk, unverified:** whether npm lets an account use an authenticator app alongside a security key, and
accepts its code as `npm-otp` for `npm trust` and the placeholder publish. npm's 2FA docs describe security keys
only (§1). It is checked when Alex connects the npm account by hand; until then nothing has sent a TOTP code to
npm. If npm refuses, the connector's error says the one-time password was refused, and this decision reopens.

**Open:** how the stored secret is protected beyond `CONNECTION_KEY` sealing: a breach of the deployment's
variables and data exposes both the token and the second factor (the risk §24.4 of the architecture discussion
records).

**Superseded (kept for its reasoning):** Alex's earlier decision, also 2026-10-26: "Option b: Jive will have a
security key. That's the only way I can foresee a fully automated process where the human never has to be present.
We'll need to think carefully about how to do this. Probably when connecting Jive someone will be forced to install
Jive's security key into their npm account." Under it, a software security key would answer npm's web approval page
in a browser outside Convex; the TOTP decision needs no browser.

What to prove, in order:

1. **The connection, by hand:** Alex adds an authenticator app to the npm account, and its secret and a token are
   stored with `bun run connect-npm` in `@jive-sh/server`, which prompts for both without echoing them (§12). This settles the open risk above.
2. The connector's `createPlaceholder` and `registerTrustedPublisher`, called live, are refused with EOTP and pass
   with the computed code. Tested so far only against a fake registry.
3. How long the account's token lasts, and how the server renews it.
4. The staged route: `npm stage publish` of the placeholder creating the package, then promotion with the second
   factor, since the direct route may close in January 2027 (§1).

---

## 9. Concurrency and retries

**Alex's question (2026-10-26):** "I don't quite understand the concern here if provisioning is idempotent and
convex serializes requests on the same resource automaically."

Convex does serialize mutations: its concurrency control "provides true serializability", and conflicting
transactions are retried "without developer intervention" ([OCC](https://docs.convex.dev/database/advanced/occ)).
That guarantee covers only what runs in a mutation, and the npm calls cannot:

- Mutations "must be deterministic, and cannot call third party APIs"
  ([mutations, transactions](https://docs.convex.dev/functions/mutation-functions#transactions)). Every npm call
  runs in an action.
- Actions "can't be automatically retried by Convex when errors occur"
  ([actions, error handling](https://docs.convex.dev/functions/actions#error-handling)).
- "Unlike mutations, actions from a single client are parallelized"
  ([calling actions from clients](https://docs.convex.dev/functions/actions#calling-actions-from-clients)). Two
  deploy jobs are two clients, so by my inference nothing orders their actions either.

What follows:

- **Retries: covered by Alex's model.** Because `packages.provision` runs on every deploy and each step reads npm
  first (§3), a provisioning that fails is redone by the next deploy, or by the job calling again. No durable
  workflow is needed for this.
- **Two jobs at once: not covered.** Two deploy jobs for the same package (two environments, or two pushes in quick
  succession) run two actions at the same time. Both read npm before either writes, so both act. The connector's
  `registerTrustedPublisher` lists publishers, then adds one if none matches
  ([source](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/c5a54edceefe7c2e2182296bb8c102472e6f7579/src/component/packageRegistry.ts#L93-L107)),
  so two calls can both find none and both add. By my inference the result is two identical publishers, or a
  refusal where npm allows one per package (§1), and two browser sessions answering npm with the same key at once.

**Proposal (the coordinating thread's idea):** before the action calls npm, a mutation claims a per-package row; a
second caller sees the claim and does not act. Because the claim is a mutation, Convex's serializability means only
one caller wins it. This needs no Convex workflow component and keeps Alex's idempotent model; it replaces the
earlier draft's recommendation of one durable workflow run per package.

**Built (2026-10-26):** `@jive-sh/server`'s `provisioningClaims` table. The losing caller gets `inProgress`, and
`jive-abstract-library` asks again every 10 seconds for up to 10 minutes. A claim lasts 5 minutes, after which
another caller may take it over, since an action that dies never releases it.

**Build item, still open from the earlier draft:** `createPlaceholder` answers `alreadyExists` for any existing
package, including one somebody else owns
([source](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/b7442097c9d94262b5bccb43a7c725ae66251e74/src/component/packageRegistry.ts#L58-L76)),
so `packages.provision` must confirm the account maintains the package before registering a publisher.
**Built:** `createPlaceholder` (contract 0.3.0) answers `maintainedByAnotherAccount` instead, comparing npm's
`/-/whoami` with the package's maintainers, and `packages.provision` refuses.

---

## 10. npm's 2-day trusted-publisher expiry

**Decided (Alex, 2026-10-26):** "I mean it'll happen immediately since it'll be part of the deploy step. And it's
idempotent so if somehow the trusted setup completes but the actual npm publish doesn't it'll just be set up again
next time."

**Build item: the idempotent call must also replace an expired publisher.** npm says an expired configuration
"can no longer be used or edited", and the remedy is to "delete the expired configuration, create a new one"
([npm](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)). "Set up again next time"
therefore means: find the expired publisher, delete it, register a new one.

The connector cannot do that today:

- `listTrustedPublishers` keeps only each publisher's id and claims and drops anything else npm returns
  ([source](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/c5a54edceefe7c2e2182296bb8c102472e6f7579/src/component/npm/impl.ts#L90-L112)),
  and `registerTrustedPublisher` answers `alreadyRegistered` for any publisher with the same claims
  ([source](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/c5a54edceefe7c2e2182296bb8c102472e6f7579/src/component/packageRegistry.ts#L93-L107)).
  If npm's trust API lists expired publishers, which is unverified (the settings page shows them, §1), then by my
  inference every later deploy would find the expired one, call it registered, and fail at publish.
- The same function's doc comment says "npm deletes a new publisher whose first publish hasn't happened within 2
  days" ([source](https://github.com/jive-sh/jive-connector-package-registry-npm/blob/c5a54edceefe7c2e2182296bb8c102472e6f7579/src/component/packageRegistry.ts#L88-L92));
  npm's docs say it stays, expired. The comment is fixed with this change.

**Built (2026-10-26):**

- Contract 0.3.0 adds `removeTrustedPublisher` (npm's `npm trust revoke` request) and a `status` on each listed
  publisher: `validated` when some version of the package names it in `_npmUser.trustedPublisher.oidcConfigId`
  (seen on `effective-modules`' versions; that this is the trust API's id is my inference), `unvalidated`
  otherwise. Neither npm's docs nor `npm trust list`'s source (npm 11.12.1) show an expiry field, so the
  registry cannot say whether an unvalidated publisher is waiting or expired.
- So `packages.provision` judges by its own record: it keeps an unvalidated publisher it registered less than 47
  hours ago, and removes and re-registers one that is older or that Jive has no record of.
- The connector logs the field names (never values) of npm's trust list, so the first live call shows whether npm
  marks expiry after all.
- The doc comment is fixed.

---

## 11. Bootstrapping `@jive-sh/server`'s own deploy

**Decided (Alex, 2026-10-26):** "Yeah just to bootstrap stuff we'll have that convex deploy key. Long term it'll all
probably work the same way everything else does: connector from user to convex account, org uses user's connection"

So, to bootstrap, the server's repository holds a Convex deploy key as its one GitHub secret (option a below). Long
term, the server's deploy reaches Convex like any other outside system: a person's connection to their Convex
account through a Convex connector, which the organization uses (§3).

**Built (2026-10-26):** `jive-abstract-backend-convex` 0.3.0+ deploys with a production `CONVEX_DEPLOY_KEY`. The
server's production deployment is `adventurous-viper-740` (reference `latest`), and its key, allowed only
`deployment:deploy`, `deployment:env:view`, `deployment:env:write` and the `runInternal*` actions, waits in an
owner-only file on Alex's machine until `jive-sh/server` exists. The server's client publish provisions through the
same deployment (0.4.0's `provisionWithJive`), so before that publish can succeed the production deployment needs
its own organization, the `jive-sh/server` repository's ids, and an npm connection whose account maintains
`@jive-sh`.

**Open (my questions):** whether the bootstrap secret is a deploy key from the start or the migration plan's team
access token, from which each deploy mints one; when the long-term route replaces it; and what a deploy does when
the server it is deploying is the one that holds that connection (the circularity option b below runs into).

The options as weighed before the decision, kept for their costs. The server's deploy needs a Convex credential:
`CONVEX_TEAM_ACCESS_TOKEN`, from which each deploy mints and deletes a deploy key ([migration plan §3.1](convex_migration_plan.md#31-deployment-through-the-two-abstracts)). Convex's
documentation index lists deploy keys and access tokens as deploy credentials and nothing that accepts a GitHub
OIDC token ([llms.txt](https://docs.convex.dev/llms.txt), my reading).

- **a. The server's own repository keeps its Convex credential as GitHub's one standing secret** *(recommended)*,
  narrowed after the first deploy from the team token to a deploy key for the production deployment only (my
  idea). Its client package needs no `NPM_TOKEN`: its deploy job calls the server it just deployed to provision
  the package, then publishes by OIDC. That order assumes the backend abstract pushes functions before publishing
  the client, which is unverified. Buys: no circular dependency; one secret, on the one package that is the root
  of trust. Costs: that secret stays, and until per-phase secrets exist it is visible to pull-request builds
  ([`requiredSecrets` gap](convex_migration_plan.md#31-deployment-through-the-two-abstracts)).
- **b. After the first deploy, each deploy asks the running server for a deploy key.** Buys: no standing secret.
  Costs: a deploy that breaks the API breaks its own fix, so a fallback secret is still needed; and a compromised
  server can redeploy itself.
- **c. A second, tiny Convex deployment that only holds the server's deploy credential.** Costs: moves the same
  secret one level down.

---

## 12. First slice

The smallest end-to-end path: one new npm package created and published by its own pipeline with no npm secret in
GitHub and no person present. Build order and where each step stands:

1. **The npm connection** (§8 proof 1): the test npm account's token and authenticator-app secret, stored by Alex
   with `bun run connect-npm` on the deployment the test package calls. **Not done; Alex's step.**
2. **`@jive-sh/server`, minimal**, extending `jive-abstract-backend-convex`: GitHub as a `customJwt` provider
   (§4a); tables for organizations, connections, code repositories and packages, with the package claim (§9); the
   npm connector installed; `packages.provision` with the §6 checks. No Convex workflow component. **Built and
   tested** against a local backend; committed, not pushed (its first push deploys production and publishes its
   client to npm). Running on the dev deployment `adorable-giraffe-46`.
3. **Seeded by hand, once:** one organization, its npm connection, and the test repository's ids, through internal
   functions run with `convex run`. Scaffolding until `organizations.create`, `connections.create` and
   `codeRepositories.provision` exist; it is in `docs/lacking-durable-workflows.md`. **Done on the dev deployment**
   for organization `chaine-dance` and `chaine-dance/jive-test-package`, except the npm connection.
4. **The connector:** removing a publisher and reporting its status (§10), confirming the account maintains a
   package (§9), and answering the second factor with a TOTP code (§8). **Released** (connector 0.2.0, contract
   0.3.0).
5. **`jive-abstract-library`:** on every deploy, request an ID token with audience `https://api.jive.sh`, call
   `packages.provision`, then publish by OIDC, behind `jive.library.provisionWithJive`. **Released** (0.3.0).
6. **Live run:** a push to `main` ends with the package on npm, its `0.0.0` placeholder, a publisher for
   `pipeline.yml` and `latest`, and the real version published by OIDC. **Run as far as the npm connection:** the
   test package's pipeline called the dev deployment with its real ID token; Convex verified it, every §6 check
   passed, the repository was found by its ids, the claim was taken and released, and provisioning stopped at
   "the repository's organization has not connected an npm account to Jive", so the deploy failed with nothing
   published ([run](https://github.com/chaine-dance/jive-test-package/actions/runs/40421016740)).

**Decided: which package goes first** (Alex, 2026-10-26): "It doesn't matter really we have a bunch. We can do a
throw away. I just don't want us to create a ton of those; could look bad". So the slice uses one throwaway test
package, created once and reused for every test run, never one per run. Consequence: only its first run creates a
package and its placeholder; later runs exercise the already-provisioned path (publisher checks and replacing an
expired publisher, §10).

**Decided: the wait between a platform package being published and npm serving it for download stays at 15
minutes** (question 11; this is not build time). Alex, 2026-10-26: "Let's just leave it at 15 minutes for now; we
can start monitoring this later. I think past 15 minutes it's probably worth looking into optmizations because the
UX is pretty bad". So the limit is not raised; monitoring the wait comes later; a wait past 15 minutes is a reason
to optimize, not to raise the limit. Today `jive-abstract-library` waits up to 15 minutes for npm to
serve every platform package before it publishes the base package (`PLATFORM_PACKAGES_TIMEOUT_SECONDS = 900`,
[source](https://github.com/jive-sh/jive-abstract-library/blob/840a0a39fbfae997be2c15a478a61b15ec986e33/src/internal/modules/deployer/impl.ts#L17)).

Out of the slice: the GitHub connection and the App-versus-login comparison (§7), Jive workflows, person sign-in
on the server, notifications, deprecating the placeholder, and the January 2027 staged route beyond §8 proof 4.
