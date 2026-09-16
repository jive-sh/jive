# CI/CD Script API

Jive's [reusable pipeline](.github/workflows/reusable-pipeline.yml) calls scripts defined
in the consuming repository's `package.json`. The package owns build, validation,
publishing, URL selection, and deployment logic; Jive owns when those scripts run.

## Shared input boundary

Every hook is invoked as `bun run <script-name>`, without positional arguments. All
hooks consume the same environment variable, `JIVE_CICD_INPUT`, containing a JSON
object conforming to the [shared schema](.github/cicd-input.schema.json):

```json
{
  "environment": "Preview",
  "context": {
    "provider": "github",
    "data": {
      "event_name": "pull_request",
      "head_ref": "feature/example",
      "ref_name": "42/merge",
      "event": { "pull_request": { "number": 42 } }
    }
  }
}
```

| Field | Contract |
| --- | --- |
| `environment` | Required. Target name for `deploy:url` and `deploy`; `null` for all other hooks. |
| `context.provider` | Required. Currently `"github"`, the only supported provider. |
| `context.data` | Required object. Full GitHub Actions `github` context; the example above is abbreviated. |

Scripts parse and validate the input at their entrypoint, then pass the decoded values
to their application logic. Read the branch from `context.data.head_ref` when present
and nonempty, otherwise `context.data.ref_name`. For PR runs, the PR number is
`context.data.event.pull_request.number`. Do not expect a PR number on push or manual runs.
Future providers can define their own `context.data` shape under a different provider tag;
they are not accepted by the current schema.

The input carries execution context, not configuration results, artifact contents, or
credentials supplied separately by secret setup. Avoid logging the whole input: the full
GitHub context can contain the workflow token. The workflow constructs the envelope;
it does not automatically run JSON Schema validation inside each script.

## Hook overview

Schemas below use TypeScript-style notation. Input is JSON in `JIVE_CICD_INPUT`.
`data` carries the provider's full context object. The `get-config` output is JSON;
the `deploy:url` output is a plain-text absolute HTTP(S) URL. `void` means no return payload.

| Script | Input | Output |
| --- | --- | --- |
| `jive:cicd:get-config` | `{ environment: null; context: { provider: "github"; data: Record<string, unknown> } }` | `{ deployVerb: string; runsOn: string \| string[] \| { group: string; labels?: string \| string[] } \| { group?: string; labels: string \| string[] }; deployBranches: Record<string, string[]>; runOnPullRequests: boolean; enablePreviewDeploys: boolean }` |
| `jive:cicd:build` | `{ environment: null; context: { provider: "github"; data: Record<string, unknown> } }` | `void` |
| `jive:cicd:audit` | `{ environment: null; context: { provider: "github"; data: Record<string, unknown> } }` | `void` |
| `jive:cicd:deploy:url` | `{ environment: string; context: { provider: "github"; data: Record<string, unknown> } }` | `string` |
| `jive:cicd:upload-artifacts` | `{ environment: null; context: { provider: "github"; data: Record<string, unknown> } }` | `void` |
| `jive:cicd:deploy` | `{ environment: string; context: { provider: "github"; data: Record<string, unknown> } }` | `void` |

All scripts must exit zero on success and nonzero on failure. A nonzero exit fails the
calling step. For the two hooks with consumed stdout, print only the documented result
there and send diagnostics to stderr. Other hooks may log to stdout or stderr; their
logs are not parsed as return values. Scripts do not write GitHub action outputs themselves.

Define every hook reached by your pipeline. Jive does not skip missing scripts. A hook
with no work can be an explicit successful no-op, except that `get-config` and `deploy:url`
must still return their required result when invoked.

## `jive:cicd:get-config`

Runs after checkout, Bun setup, and dependency installation in the configuration job,
before build eligibility is decided. This job uses `ubuntu-latest`; the returned runner
selection applies to the build and deployment jobs. Secret setup has not run yet.

Print one fully resolved JSON object, for example:

```json
{
  "deployVerb": "Deploy to",
  "runsOn": "ubuntu-latest",
  "deployBranches": {
    "main": ["Staging", "Production"]
  },
  "runOnPullRequests": true,
  "enablePreviewDeploys": true
}
```

| Output field | Meaning |
| --- | --- |
| `deployVerb` | String used in deployment job display names. |
| `runsOn` | Runner string, array of runner labels, or object containing `group` and/or `labels`. |
| `deployBranches` | Object mapping branch names to arrays of deployment environment names. |
| `runOnPullRequests` | Boolean enabling build work for PR events. |
| `enablePreviewDeploys` | Boolean enabling Preview deployment for PRs or unmapped manual-run branches. |

The script owns loading, validation, and defaults. Return all five fields; the action
parses the JSON and exposes the values as workflow outputs rather than applying defaults.
A package may derive this object from its `package.json` `jive.cicd` configuration.

## `jive:cicd:build`

Runs after checkout, Bun setup, secret setup, and dependency installation in an eligible
build job. Compile, bundle, or otherwise prepare the package here. There is no structured
stdout result. Files needed by deployment must remain available for artifact transfer.

The current pipeline runs this job for enabled PRs, manual (`workflow_dispatch`) runs,
and pushes whose branch has a non-null entry in `deployBranches`.

## `jive:cicd:audit`

Runs after a successful build. Perform unit tests, linting, or other checks here. There
is no structured stdout result; exit nonzero to prevent URL resolution, artifact upload,
and deployment from proceeding. There is no separate unit-test or integration-test hook
in the current workflow.

## `jive:cicd:deploy:url`

Runs during deployment sequencing, after audit and before artifact upload or deployment.
Jive calls it once per selected environment, passing that name in `JIVE_CICD_INPUT`.
Print exactly one absolute HTTP(S) URL, for example:

```text
https://pr-42.example.com
```

The script owns the mapping from environment, branch, and PR context to a URL. For example,
`Preview` plus PR 42 can resolve to the URL above, while `Production` resolves to the
canonical application URL. It must be possible to resolve the URL before deployment;
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
- A mapped branch uses its configured names. An empty array selects no environments.

## `jive:cicd:upload-artifacts`

Runs after successful sequencing in the build job, including when no deployment was
selected. Use it for package-owned publishing or artifact preparation. Inspect the shared
context to decide whether the current event should publish; do not expect an event argument.
There is no structured stdout result.

After this hook succeeds, Jive separately uploads `path: .` as the `build-output` workflow
artifact if a deployment is selected. The hook does not return an artifact path or name.
The deploy job downloads that artifact into its working directory. Prepare the files the
deploy command needs; the deploy job currently performs neither checkout nor dependency
installation. Artifact inclusion is controlled by the upload action's settings, not this API.

## `jive:cicd:deploy`

Runs for each selected matrix entry after artifact download, Bun setup, and secret setup.
Read the target name from `JIVE_CICD_INPUT.environment` and perform the deployment.
There is no structured stdout result; printing a URL here does not update the deployment
link, which was resolved by `deploy:url` earlier.

The matrix is configured with `max-parallel: 1`. Sequencing preserves the configured
array order, but the script API does not provide a promotion/approval protocol between
matrix jobs. The current GitHub Actions environment name is the literal `deploy`; it is
separate from the target name passed in `JIVE_CICD_INPUT`.

## Trying a hook locally

Supply the same envelope manually when testing a script outside CI. For example, after
defining a URL hook in your package:

```sh
JIVE_CICD_INPUT='{"environment":"Preview","context":{"provider":"github","data":{"event_name":"pull_request","head_ref":"feature/example","event":{"pull_request":{"number":42}}}}}' \
  bun run jive:cicd:deploy:url
```

This is an abbreviated fixture, not a full GitHub context. Include any additional fields
your script validates or consumes. Build, upload, and deploy hooks can have side effects;
this example invokes only URL resolution.
