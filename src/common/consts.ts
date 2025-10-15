import { Schema } from "effect";
import { bin, version } from "../../package.json";

export const CLI_NAME = Schema.decodeUnknownSync(Schema.String)(Object.keys(bin).pop());
export const CLI_VERSION = version;