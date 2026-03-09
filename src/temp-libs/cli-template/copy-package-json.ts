import { promises } from "node:fs";
import { resolve } from "node:path";
import { TOOL_NAME } from "@/constants";

const PACKAGE_JSON_FILENAME = "package.json";
const OG_PATH = resolve(PACKAGE_JSON_FILENAME);
const DEST_PATH = resolve(`./build/${PACKAGE_JSON_FILENAME}`);

const contents = JSON.parse((await promises.readFile(OG_PATH)).toString());
delete contents.devDependencies;
delete contents.type;
delete contents.module;
delete contents.scripts;
delete contents.workspaces;
contents.bin[TOOL_NAME] = TOOL_NAME;

await promises.writeFile(DEST_PATH, JSON.stringify(contents, null, 2));
