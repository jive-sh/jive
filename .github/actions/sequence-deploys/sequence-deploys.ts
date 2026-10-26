import * as e from "effect";

/**
 * Resolves which environments this run deploys to, in order. For each environment the branch selects, the
 * package's `jive:cicd:deploy:plan` hook says whether there is anything to deploy and where; environments
 * with nothing to deploy are dropped. Prints the action's outputs as `GITHUB_OUTPUT` lines on stdout, so
 * every log line goes to stderr. CICD_API.md is the contract this implements.
 */

const HttpUrl = e.Schema.String.check(e.Schema.makeFilter(
  (url: string) => URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol) && !/\s/.test(url)
    ? undefined
    : `"${url}" is not an absolute HTTP(S) URL`,
));

/** What `jive:cicd:deploy:plan` prints for one environment. */
export const DeployPlan = e.Schema.Union([
  e.Schema.Struct({ deploy: e.Schema.Literal(false) }),
  e.Schema.Struct({ deploy: e.Schema.Literal(true), url: HttpUrl }),
]);
export type DeployPlan = typeof DeployPlan.Type;

/** One entry of the `environments` output, which the deploy job's matrix runs. */
export interface Deployment {
  readonly name: string;
  readonly url: string;
}

const PLAN_HOOK = "jive:cicd:deploy:plan";
const PREVIEW_ENVIRONMENT = "Preview";

const formatSchemaError = e.SchemaIssue.makeFormatterDefault();

/**
 * The environments a run considers. A pull request, or a manual run on a branch absent from
 * `deploy.branches` (`branchEnvironments` is none), gets only a preview, and only when previews are on;
 * otherwise the branch's own list, in order.
 */
export function selectEnvironments(input: {
  readonly branchEnvironments: e.Option.Option<ReadonlyArray<string>>;
  readonly isPullRequest: boolean;
  readonly previews: boolean;
}): ReadonlyArray<string> {
  if (input.isPullRequest || e.Option.isNone(input.branchEnvironments)) {
    return input.previews ? [PREVIEW_ENVIRONMENT] : [];
  }
  return input.branchEnvironments.value;
}

/** Decodes the hook's stdout for `environment`, failing with what it printed when that is not exactly one plan. */
export function decodeDeployPlan(environment: string, stdout: string): e.Effect.Effect<DeployPlan, string> {
  const invalid = (reason: string) =>
    `${PLAN_HOOK} printed an invalid plan for ${environment}: ${reason}\n`
    + `It must print exactly {"deploy":false} or {"deploy":true,"url":"https://…"}; it printed:\n${stdout}`;
  return e.pipe(
    e.Schema.decodeUnknownEffect(e.Schema.fromJsonString(DeployPlan), { onExcessProperty: "error" })(stdout.trim()),
    e.Effect.mapError((error) => invalid(formatSchemaError(error.issue))),
  );
}

export interface IPlanHook {
  /** Runs `jive:cicd:deploy:plan` for one environment and returns its stdout; its stderr goes to the job log. */
  run(environment: string): e.Effect.fn.Return<string, string>;
}
export class PlanHook extends e.Context.Service<PlanHook, IPlanHook>()("PlanHook") {}

/** Runs the hook in the package being built, with the run's context and one environment, as CICD_API.md specifies. */
export const planHookLayer = (pipelineContext: string) => e.Layer.succeed(PlanHook, {
  *run(environment) {
    const result = yield* e.Effect.sync(() => Bun.spawnSync(["bun", "run", PLAN_HOOK], {
      env: { ...process.env, JIVE_DEPLOY_ENVIRONMENT: environment, JIVE_PIPELINE_CONTEXT: pipelineContext },
      stdout: "pipe",
      stderr: "inherit",
    }));
    if (result.exitCode !== 0) {
      return yield* e.Effect.fail(`${PLAN_HOOK} exited with code ${result.exitCode} for ${environment}`);
    }
    return result.stdout.toString();
  },
});

/** Asks the hook about each environment, in order, and keeps those it plans to deploy. */
export function* planDeployments(environments: ReadonlyArray<string>): e.Effect.fn.Return<ReadonlyArray<Deployment>, string, PlanHook> {
  const hook = yield* PlanHook;
  const deployments: Deployment[] = [];
  for (const name of environments) {
    const plan = yield* decodeDeployPlan(name, yield* hook.run(name));
    if (!plan.deploy) {
      yield* e.Effect.log(`${name}: nothing to deploy`);
      continue;
    }
    yield* e.Effect.log(`${name}: deploying to ${plan.url}`);
    deployments.push({ name, url: plan.url });
  }
  return deployments;
}

const ActionInputs = e.Schema.Struct({
  BRANCH: e.Schema.String,
  // A branch with no entry in deploy.branches arrives as the JSON literal null.
  DEPLOY_ENVIRONMENTS: e.Schema.fromJsonString(e.Schema.NullOr(e.Schema.Array(e.Schema.String))),
  PREVIEWS: e.Schema.Literals(["true", "false"]),
  IS_PR: e.Schema.Literals(["true", "false"]),
  PIPELINE_CONTEXT: e.Schema.NonEmptyString,
  SEQUENTIAL_DEPLOYMENTS: e.Schema.Literals(["true", "false"]),
});

function* main(): e.Effect.fn.Return<void, string> {
  const inputs = yield* e.pipe(
    e.Schema.decodeUnknownEffect(ActionInputs)(process.env),
    e.Effect.mapError((error) => `sequence-deploys was given invalid inputs: ${formatSchemaError(error.issue)}`),
  );
  const isPullRequest = inputs.IS_PR === "true";
  const previews = inputs.PREVIEWS === "true";
  const branchEnvironments = e.Option.fromNullOr(inputs.DEPLOY_ENVIRONMENTS);
  yield* e.Effect.log(`cicd config specified the following deploy environments for branch ${inputs.BRANCH}: ${JSON.stringify(inputs.DEPLOY_ENVIRONMENTS)}`);
  yield* e.Effect.log(isPullRequest ? "is a pull request" : "is not a pull request");
  yield* e.Effect.log(previews ? "previews deploys enabled" : "preview deploys disabled");

  const deployments = yield* e.pipe(
    e.Effect.gen(() => planDeployments(selectEnvironments({ branchEnvironments, isPullRequest, previews }))),
    e.Effect.provide(planHookLayer(inputs.PIPELINE_CONTEXT)),
  );
  const concurrency = inputs.SEQUENTIAL_DEPLOYMENTS === "true" ? "sequentially" : "in parallel";
  yield* e.Effect.log(deployments.length > 0
    ? `Deploying to ${JSON.stringify(deployments)} ${concurrency} (${deployments.length} total).`
    : "Scheduling no deployments for this pipeline run.");
  yield* e.Effect.sync(() => {
    process.stdout.write(`environments=${JSON.stringify(deployments)}\n`);
    process.stdout.write(`will-deploy=${deployments.length > 0}\n`);
  });
}

const stderrLogger = e.Logger.make(({ message }) => {
  process.stderr.write(`${Array.isArray(message) ? message.join(" ") : String(message)}\n`);
});

if (import.meta.main) {
  const result = await e.Effect.runPromise(e.pipe(
    e.Effect.gen(main),
    e.Effect.provide(e.Logger.layer([stderrLogger])),
    e.Effect.result,
  ));
  if (e.Result.isFailure(result)) {
    process.stderr.write(`✗ ${result.failure}\n`);
    process.exit(1);
  }
}
