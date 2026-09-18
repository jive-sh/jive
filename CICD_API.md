# Jive's Universal CI/CD Contract

Jive's [reusable pipeline](.github/workflows/reusable-pipeline.yml) is architected such that any feasible type of package can implement its CI/CD pipeline without writing any unique github actions code at all. This is accomplished via Jive calling standard scripts defined in the package's `package.json` file. These scripts act as userland hooks and own build, validation (e.g. unit / end to end tests) and deployment logic; Jive merely orchestrates calling this logic.

## The CICD Hooks

Jive requires the following scripts be defined.

```json
{
  "scripts": {
    "jive:cicd:get-config": "jive-template cicd get-config",
    "jive:cicd:build": "jive-template cicd build",
    "jive:cicd:audit": "jive-template cicd audit",
    "jive:cicd:deploy:url": "jive-template cicd deploy-url",
    "jive:cicd:upload-artifacts": "jive-template cicd upload-artifacts",
    "jive:cicd:deploy": "jive-template cicd deploy"
  }
}
```

Those subcommands read the input variables described below and honor the stdout rules, so a
package that adopts a template unchanged has no hook code of its own to write. A package that
needs different behavior for one hook replaces that single script; the rest keep delegating.

`build` finishes by installing its own output into the workspace, so a later `audit` exercises
the package the way a consumer machine would rather than the way the source tree does. That
install is the `local` deploy environment: `local` and `preview` are both reserved, and a
package that names either in `cicd.deploy.branches` is rejected by the template's schema.

A template repo cannot install itself from the registry, so it bootstraps: its own
`jive:cicd:build` and `jive:cicd:get-config` run the CLI from source, and every later hook
uses the binary that build installed. That also makes each pipeline run an integration test
of the template against current source rather than its last release. A hook that bootstraps
must keep its build output off stdout when the pipeline parses it — `get-config` is the case
that matters, since a package manager's install progress would otherwise land in the JSON the
config job reads.

## Hook inputs

Every hook is invoked as `bun run <script-name>`, without positional arguments. `get-config`,
`build`, and `audit` receive no input at all — they derive everything from the repository
they are running in.

Two environment variables carry what the rest need.

`JIVE_PIPELINE_CONTEXT` describes the run, and goes to `upload-artifacts`, `deploy:url`,
and `deploy`. It is computed once per workflow and is identical in every job:

```json
{
  "provider": "Github",
  "repository": { "owner": "jive-sh", "name": "jive-template-library" },
  "sourceBranch": "feature/example",
  "sourceCommitSha": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  "event": { "type": "PULL_REQUEST", "id": "42", "destinationBranch": "main" }
}
```

| Field | Contract |
| --- | --- |
| `provider` | `"Github"` or `"Gitlab"`. |
| `repository` | `owner` and `name` of the repository being built. |
| `sourceBranch` | The branch the work is on — a pull request's source branch, otherwise the branch built. |
| `sourceCommitSha` | The commit that was pushed. Never a merge commit synthesized by the provider for a pull request. |
| `event` | Tagged union: `PULL_REQUEST` with `id` and `destinationBranch`, or `COMMIT`, or `DIRECT_WORKFLOW_RUN`. |

Because `event` is tagged, a field only exists where it is meaningful: there is no PR number
to ignore on a push, and no null branch to guard against.

`JIVE_DEPLOY_ENVIRONMENT` is a bare string, not JSON, and goes only to `deploy:url` and
`deploy`. It names the single target that invocation is for, such as `latest` or `Preview`.
Jive calls those hooks once per selected environment.

Neither variable carries configuration results, artifact contents, or credentials supplied
separately by secret setup. Future providers fill the same `PipelineContext` fields rather
than defining a shape of their own.

## Hook overview

Schemas below use TypeScript-style notation. `PipelineContext` is the object documented
above. The `get-config` output is JSON; the `deploy:url` output is a plain-text absolute
HTTP(S) URL. `void` means no return payload, and `none` means the hook is given no input.

| Script | Input | Output |
| --- | --- | --- |
| `jive:cicd:get-config` | `none` | `JivePackageConfig` — the package's `jive` block, validated (see below) |
| `jive:cicd:build` | `none` | `void` |
| `jive:cicd:audit` | `none` | `void` |
| `jive:cicd:deploy:url` | `JIVE_DEPLOY_ENVIRONMENT: string` + `JIVE_PIPELINE_CONTEXT: PipelineContext` | `string` |
| `jive:cicd:upload-artifacts` | `JIVE_PIPELINE_CONTEXT: PipelineContext` | `void` |
| `jive:cicd:deploy` | `JIVE_DEPLOY_ENVIRONMENT: string` + `JIVE_PIPELINE_CONTEXT: PipelineContext` | `void` |

All scripts must exit zero on success and nonzero on failure. A nonzero exit fails the
calling step. For the two hooks with consumed stdout, print only the documented result
there and send diagnostics to stderr. Other hooks may log to stdout or stderr; their
logs are not parsed as return values. Scripts do not write GitHub action outputs themselves.

Define every hook reached by your pipeline. Jive does not skip missing scripts. A hook
with no work can be an explicit successful no-op, except that `get-config` and `deploy:url`
must still return their required result when invoked.

## `jive:cicd:get-config`

Runs after checkout, Bun setup, and dependency installation in the context job, before build
eligibility is decided. That job uses `ubuntu-latest`; the runner this returns applies to the
build and deployment jobs. Secret setup has not run yet.

Print the package's `jive` block as one JSON object, validated against the template's schema:

```json
{
  "cicd": {
    "deploy": {
      "verb": "Deploy to",
      "branches": { "main": ["Staging", "Production"] },
      "previews": true,
      "sequentially": true
    },
    "runsOnPullRequests": true,
    "runsOn": "ubuntu-latest"
  }
}
```

| Field | Meaning |
| --- | --- |
| `cicd.deploy.verb` | Verb used in deployment job display names. |
| `cicd.deploy.branches` | Maps branch names to ordered, non-empty arrays of deployment environment names. `{}` means no branch ever deploys. |
| `cicd.deploy.previews` | Enables a `Preview` deployment for pull requests and unmapped manual-run branches. |
| `cicd.deploy.sequentially` | Deploys a branch's environments one at a time in listed order when true; all at once when false. |
| `cicd.runsOnPullRequests` | Enables build work for pull request events. |
| `cicd.runsOn` | Runner string, array of runner labels, or object containing `group` and/or `labels`. |

This hook owns validation. The `load-context` action passes the result through as its
`package-config` output without interpreting any field, so a malformed config fails here
rather than somewhere downstream. Nothing is optional, so there are no defaults to apply.

## `jive:cicd:build`

Runs after checkout, Bun setup, secret setup, and dependency installation in an eligible
build job. Compile, bundle, or otherwise prepare the package here. There is no structured
stdout result. Files needed by deployment must remain available for artifact transfer.

A template's `build` may also install its own output into the workspace so that `audit` runs
against the installed package rather than the source tree. `jive-template-library` does this,
building every platform but installing only the host's.

The current pipeline runs this job for enabled PRs, manual (`workflow_dispatch`) runs,
and pushes whose branch has a non-null entry in `cicd.deploy.branches`.

## `jive:cicd:audit`

Runs after a successful build. Perform unit tests, linting, or other checks here. There
is no structured stdout result; exit nonzero to prevent URL resolution, artifact upload,
and deployment from proceeding. There is no separate unit-test or integration-test hook
in the current workflow.

## `jive:cicd:deploy:url`

Runs during deployment sequencing, after audit and before artifact upload or deployment.
Jive calls it once per selected environment, passing that name in `JIVE_DEPLOY_ENVIRONMENT`.
Print exactly one absolute HTTP(S) URL, for example:

```text
https://pr-42.example.com
```

It also receives `JIVE_PIPELINE_CONTEXT`, and owns the mapping from environment, branch, and
pull request to a URL. For example, `Preview` plus PR 42 can resolve to the URL above, while
`Production` resolves to the canonical application URL. It must be possible to resolve the URL before deployment;
this hook is not a callback that receives the completed deploy's output.

Jive trims surrounding whitespace, rejects empty output, invalid URLs, non-HTTP(S)
protocols, or remaining whitespace, and fails sequencing on a nonzero exit. It combines
the results into an array such as:

```json
[
  { "name": "Staging", "url": "https://staging.example.com" },
  { "name": "Production", "url": "https://example.com" }
]
```

That array is the action's `environments` output, not the script's output. The deployment
matrix uses each entry's URL for the GitHub deployment link. No URL script runs if no
environment is selected.

Selection uses these rules:

- PR runs select only `Preview` when preview deployments are enabled; otherwise none.
- An unmapped branch on a manual run also selects `Preview` when enabled; otherwise none.
- A mapped branch uses its configured names, in order. Each mapped branch must name at least one environment; to stop a branch deploying, remove its entry rather than mapping it to an empty array.

## `jive:cicd:upload-artifacts`

Runs after successful sequencing in the build job, including when no deployment was
selected. Use it for whatever the package needs done once per build. It receives
`JIVE_PIPELINE_CONTEXT` but no environment, since it runs once for the whole build rather than
once per target. There is no structured stdout result.

After this hook succeeds, Jive separately uploads `path: .` as the `build-output` workflow
artifact if a deployment is selected. The hook does not return an artifact path or name.
The deploy job downloads that artifact into its working directory. Prepare the files the
deploy command needs; the deploy job currently performs neither checkout nor dependency
installation. Artifact inclusion is controlled by the upload action's settings, not this API.

## `jive:cicd:deploy`

Runs for each selected matrix entry after artifact download, Bun setup, and secret setup.
Read the target name from `JIVE_DEPLOY_ENVIRONMENT`, and the run's details from
`JIVE_PIPELINE_CONTEXT`, then perform the deployment. `jive-template-library` publishes to
npm from here, for example, because the environment is what selects the version and dist-tag
to release under — but where a package does its publishing is its own call.
There is no structured stdout result; printing a URL here does not update the deployment
link, which was resolved by `deploy:url` earlier.

`cicd.deploy.sequentially` decides whether the matrix runs one environment at a time
(`max-parallel: 1`) or all of them at once. Sequencing preserves the configured array
order, but the script API does not provide a promotion/approval protocol between matrix
jobs. The current GitHub Actions environment name is the literal `deploy`; it is separate
from the target name passed in `JIVE_DEPLOY_ENVIRONMENT`.

## Trying a hook locally

Supply the same input manually when testing a script outside CI. For example, after
defining a URL hook in your package:

```sh
JIVE_DEPLOY_ENVIRONMENT=Preview \
  JIVE_PIPELINE_CONTEXT='{"provider":"Github","repository":{"owner":"jive-sh","name":"example"},"sourceBranch":"feature/example","sourceCommitSha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","event":{"type":"PULL_REQUEST","id":"42","destinationBranch":"main"}}' \
  bun run jive:cicd:deploy:url
```

`JIVE_PIPELINE_CONTEXT` is a complete value, not an abbreviation — every field above is
present in a real run, and there are no others. Build, upload, and deploy hooks can have side
effects; this example invokes only URL resolution.

## Template Package.json Validation

A package's `package.json` is validated against the JSON Schema of the Jive template that package is based on — a library package, for example, is based on `jive-template-library`. The template's build renders that schema to `package.schema.json`, a gitignored sibling of `package.json`, and points the manifest's `$schema` at it so an editor validates the config as you type. Rebuilding refreshes it.

```json
{
  "$schema": "./package.schema.json"
}
```
