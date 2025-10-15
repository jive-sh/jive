import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_NAME } from "./consts";

export const CLI_STATE_DIR = join(homedir(), `.${CLI_NAME}`);
