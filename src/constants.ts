import { bin } from "../package.json";

export const TOOL_NAME = "jive" satisfies keyof typeof bin;
export const GIT_CREDENTIAL_HELPER_NAME = "git-credential-jive" satisfies keyof typeof bin;