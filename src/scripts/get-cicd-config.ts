/**
 * Validates this repo's package.json `jive.cicd` block and prints the fully-resolved config
 * (defaults applied) to stdout as a single JSON object, for the "Jive Load CI/CD Config" composite
 * action (.github/actions/load-cicd-config) to fan out into GITHUB_OUTPUT entries.
 *
 * This validates the same `jive.cicd` shape as @ozyman42/ozy-cli's
 * src/modules/cli/package/cicd-config.ts (the canonical source for the generated JSON Schema
 * shown by that repo's `$schema` pointer). It's a hand-rolled duplicate rather than a shared
 * import because this repo is on Effect 3.x while ozy-cli is on the Effect 4 beta `Schema` API —
 * worth consolidating into one shared validator once the two are aligned on an Effect major version.
 */

type RunsOnLabels = string | ReadonlyArray<string>;
type RunsOn =
  | RunsOnLabels
  | { group: string; labels?: RunsOnLabels }
  | { group?: string; labels: RunsOnLabels };

type ResolvedCicdConfig = {
  deployVerb: string;
  runsOn: RunsOn;
  deployBranches: Record<string, ReadonlyArray<string>>;
  runOnPullRequests: boolean;
  enablePreviewDeploys: boolean;
};

function fail(message: string): never {
  console.error(`Invalid jive.cicd config in package.json:\n${message}`);
  process.exit(1);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRunsOnLabels(value: unknown): value is RunsOnLabels {
  return isNonEmptyString(value) || (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString));
}

function isRunsOn(value: unknown): value is RunsOn {
  if (isRunsOnLabels(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const { group, labels } = value as Record<string, unknown>;
  const groupOk = group === undefined || isNonEmptyString(group);
  const labelsOk = labels === undefined || isRunsOnLabels(labels);
  return groupOk && labelsOk && (group !== undefined || labels !== undefined);
}

function isDeployBranches(value: unknown): value is Record<string, ReadonlyArray<string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    branches => Array.isArray(branches) && branches.length > 0 && branches.every(b => typeof b === "string")
  );
}

const packageJsonText = await Bun.file("package.json").text();

let packageJson: unknown;
try {
  packageJson = JSON.parse(packageJsonText);
} catch (e) {
  fail(`Invalid JSON: ${(e as Error).message}`);
}

const jive = (packageJson as Record<string, unknown> | null)?.jive as Record<string, unknown> | undefined;
const cicd = jive?.cicd as Record<string, unknown> | undefined;
if (cicd === undefined) fail(`Missing "jive.cicd"`);

const { deployVerb, runsOn, deployBranches, runOnPullRequests, enablePreviewDeploys } = cicd;

if (deployVerb !== undefined && typeof deployVerb !== "string") {
  fail(`"deployVerb" must be a string`);
}
if (runsOn !== undefined && !isRunsOn(runsOn)) {
  fail(`"runsOn" must be a string, a non-empty string array, or a {group, labels} object`);
}
if (deployBranches !== undefined && !isDeployBranches(deployBranches)) {
  fail(`"deployBranches" must be an object mapping branch names to non-empty string arrays`);
}
if (typeof runOnPullRequests !== "boolean") {
  fail(`"runOnPullRequests" must be a boolean`);
}
if (typeof enablePreviewDeploys !== "boolean") {
  fail(`"enablePreviewDeploys" must be a boolean`);
}

const resolved: ResolvedCicdConfig = {
  deployVerb: (deployVerb as string | undefined) ?? "Deploy to",
  runsOn: (runsOn as RunsOn | undefined) ?? "ubuntu-latest",
  deployBranches: (deployBranches as Record<string, ReadonlyArray<string>> | undefined) ?? {},
  runOnPullRequests,
  enablePreviewDeploys
};

console.log(JSON.stringify(resolved));
