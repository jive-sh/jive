import { execSync } from "child_process";
import { MONOREPO_ROOT } from "./paths";
import * as path from 'path';

export function run(cmd: string, cwd: string) {
  const pathInRepo = cwd.substring(MONOREPO_ROOT.length + path.sep.length);
  console.log(`Running '${cmd}' in ${pathInRepo}`);
  execSync(cmd, {cwd});
}
