import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as e from "effect";
import { PlanHook, decodeDeployPlan, planDeployments, selectEnvironments } from "./sequence-deploys";

const SCRIPT = resolve(import.meta.dir, "sequence-deploys.ts");

const decode = (stdout: string) => e.Effect.runSync(e.Effect.result(decodeDeployPlan("latest", stdout)));

describe("decodeDeployPlan", () => {
  test("accepts nothing to deploy, or a deploy with an absolute HTTP(S) URL, around surrounding whitespace", () => {
    expect(decode('{"deploy":false}\n')).toEqual(e.Result.succeed({ deploy: false }));
    expect(decode('  {"deploy":true,"url":"https://www.npmjs.com/package/x/v/1.0.0"}\n'))
      .toEqual(e.Result.succeed({ deploy: true, url: "https://www.npmjs.com/package/x/v/1.0.0" }));
  });

  test("rejects anything else, naming the environment and quoting what was printed", () => {
    for (const stdout of [
      "https://example.com",
      "",
      '{"deploy":true}',
      '{"deploy":true,"url":"ftp://example.com"}',
      '{"deploy":true,"url":"/relative"}',
      '{"deploy":"false"}',
      '{"deploy":false,"url":"https://example.com"}',
      '{"deploy":true,"url":"https://example.com","extra":1}',
      '{"deploy":false}\n{"deploy":false}',
      "Saved lockfile\n{\"deploy\":false}",
    ]) {
      const result = decode(stdout);
      expect(e.Result.isFailure(result)).toBe(true);
      if (e.Result.isFailure(result)) {
        expect(result.failure).toStartWith("jive:cicd:deploy:plan printed an invalid plan for latest: ");
        expect(result.failure).toEndWith(`it printed:\n${stdout}`);
      }
    }
  });
});

describe("selectEnvironments", () => {
  const branch = e.Option.some(["Staging", "Production"]);
  test("uses the branch's environments, in order, for a push", () => {
    expect(selectEnvironments({ branchEnvironments: branch, isPullRequest: false, previews: true })).toEqual(["Staging", "Production"]);
  });
  test("gives a pull request or an unmapped branch only a preview, when previews are on", () => {
    expect(selectEnvironments({ branchEnvironments: branch, isPullRequest: true, previews: true })).toEqual(["Preview"]);
    expect(selectEnvironments({ branchEnvironments: e.Option.none(), isPullRequest: false, previews: true })).toEqual(["Preview"]);
    expect(selectEnvironments({ branchEnvironments: branch, isPullRequest: true, previews: false })).toEqual([]);
    expect(selectEnvironments({ branchEnvironments: e.Option.none(), isPullRequest: false, previews: false })).toEqual([]);
  });
});

describe("planDeployments", () => {
  /** Plans `environments` with the hook printing `printed[environment]`, returning the outcome and the log. */
  const plan = (environments: ReadonlyArray<string>, printed: Record<string, string>) => {
    const logs: string[] = [];
    const result = e.Effect.runSync(e.pipe(
      e.Effect.gen(() => planDeployments(environments)),
      e.Effect.provide(e.Layer.succeed(PlanHook, {
        *run(environment: string) {
          const stdout = printed[environment];
          if (stdout === undefined) return yield* e.Effect.fail(`jive:cicd:deploy:plan exited with code 1 for ${environment}`);
          return stdout;
        },
      })),
      e.Effect.provide(e.Logger.layer([e.Logger.make(({ message }) => { logs.push(String(message)); })])),
      e.Effect.result,
    ));
    return { result, logs };
  };

  test("drops environments with nothing to deploy and keeps the rest in order", () => {
    const { result, logs } = plan(["Staging", "Canary", "Production"], {
      Staging: '{"deploy":true,"url":"https://staging.example.com"}',
      Canary: '{"deploy":false}',
      Production: '{"deploy":true,"url":"https://example.com"}',
    });
    expect(result).toEqual(e.Result.succeed([
      { name: "Staging", url: "https://staging.example.com" },
      { name: "Production", url: "https://example.com" },
    ]));
    expect(logs).toContain("Canary: nothing to deploy");
  });

  test("plans no deployment when every environment has nothing to deploy", () => {
    expect(plan(["latest"], { latest: '{"deploy":false}' }).result).toEqual(e.Result.succeed([]));
  });

  test("fails on an invalid plan or a failing hook", () => {
    expect(e.Result.isFailure(plan(["latest"], { latest: "https://example.com" }).result)).toBe(true);
    expect(plan(["latest"], {}).result).toEqual(e.Result.fail("jive:cicd:deploy:plan exited with code 1 for latest"));
  });
});

describe("the action's script", () => {
  /** Runs the script as the action does, in a package whose plan hook prints `plan`, returning its exit code and outputs. */
  const runAction = (plan: string) => {
    const dir = mkdtempSync(join(tmpdir(), "sequence-deploys-test-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "jive:cicd:deploy:plan": `echo '${plan}'` } }));
    const result = Bun.spawnSync(["bun", SCRIPT], {
      cwd: dir,
      env: {
        ...process.env,
        BRANCH: "main",
        DEPLOY_ENVIRONMENTS: '["latest"]',
        PREVIEWS: "false",
        IS_PR: "false",
        PIPELINE_CONTEXT: '{"provider":"Github"}',
        SEQUENTIAL_DEPLOYMENTS: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  test("schedules no deploy job when the only environment has nothing to deploy", () => {
    const { exitCode, stdout, stderr } = runAction('{"deploy":false}');
    expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "environments=[]\nwill-deploy=false\n" });
    expect(stderr).toContain("latest: nothing to deploy");
  });

  test("schedules the deploy job with the planned URL", () => {
    const { exitCode, stdout } = runAction('{"deploy":true,"url":"https://www.npmjs.com/package/x/v/1.0.1"}');
    expect({ exitCode, stdout }).toEqual({
      exitCode: 0,
      stdout: 'environments=[{"name":"latest","url":"https://www.npmjs.com/package/x/v/1.0.1"}]\nwill-deploy=true\n',
    });
  });

  test("fails the step when the hook prints the old plain URL", () => {
    const { exitCode, stdout, stderr } = runAction("https://www.npmjs.com/package/x");
    expect({ exitCode, stdout }).toEqual({ exitCode: 1, stdout: "" });
    expect(stderr).toContain("✗ jive:cicd:deploy:plan printed an invalid plan for latest");
  });
});
