import * as path from "path";
import {exec, type ExecOptions, ChildProcess} from "child_process";
import * as fs from 'fs';
import { fileURLToPath } from 'url';

export type ExecDependencyCLIConfig = {
  /**
   * Package which CLI is in
   */
  dependency: string;
  /**
   * If undefined, assumes that the cli is the same name as the package itself.
   * If cli name is different from package name, this must be included.
   */
  cliName?: string;
  args?: string[];
  envVars?: Record<string, string>;
  dir?: string;
};

/**
 * Execute the cli exported by a node dependency
 * @param param0 dependency is the "name" field of package in package.json.
 *               cliName is name of cli in case it's different from package name.
 *               args are the CLI args.
 */
export function execDependencyCLI({
  dependency,
  cliName,
  args,
  envVars,
  dir
}: ExecDependencyCLIConfig): ChildProcess {
  // TODO: do we need to do a module.parent so we're require resolving from one level up?
  const depPath = path.dirname(fileURLToPath(import.meta.resolve('pnpm')));
  const depPackageJSONPath = path.resolve(depPath, 'package.json');
  const depPackageJSON: {
    bin?: Record<string, string> | string;
  } = JSON.parse(fs.readFileSync(depPackageJSONPath).toString());
  const cliEntry = (() => {
    // https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin
    if (cliName === undefined || cliName === dependency) {
      if (typeof depPackageJSON.bin === "string") return depPackageJSON.bin;
      else if (typeof depPackageJSON.bin?.[dependency] === "string")
        return depPackageJSON.bin[dependency];
      else throw new Error(`Package ${dependency} exports no CLI`);
    } else {
      if (
        typeof depPackageJSON.bin === "object" &&
        typeof depPackageJSON.bin[cliName] === "string"
      )
        return depPackageJSON.bin[cliName];
      else
        throw new Error(
          `Package ${dependency} exports no CLI named ${cliName}`
        );
    }
  })();
  const cliPath = path.resolve(depPath, cliEntry);
  const argsStr = args ? " " + args.join(" ") : "";
  // console.log(`running '${dependency ?? cliName}${argsStr}'...`);
  const opts: ExecOptions = {};
  if (envVars) {
    opts.env = Object.assign({}, process.env, envVars);
  }
  if (dir) {
    opts.cwd = dir;
  }
  return exec(`node ${cliPath}${argsStr}`, opts);
}