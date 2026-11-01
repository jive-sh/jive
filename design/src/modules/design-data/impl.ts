import { Effect, FileSystem, Layer, Schema, SchemaIssue, pipe } from "effect";
import { DesignData, DesignDataFile, DesignDataInvalid, type IDesignDataFile } from "./interface";

const formatIssue = SchemaIssue.makeFormatterDefault();

class DesignDataFileImpl implements IDesignDataFile {
  constructor(private readonly fileSystem: FileSystem.FileSystem) {}

  *load(path: string): Effect.fn.Return<DesignData, DesignDataInvalid> {
    const json = yield* pipe(
      this.fileSystem.readFileString(path),
      Effect.mapError((error) => new DesignDataInvalid({ path, reason: error.message })),
    );
    const data = yield* pipe(
      Schema.decodeUnknownEffect(Schema.fromJsonString(DesignData), { onExcessProperty: "error" })(json),
      Effect.mapError((error) => new DesignDataInvalid({ path, reason: formatIssue(error.issue) })),
    );
    const groupLabels = new Set([...data.groups.map((group) => group.label), data.groupForOtherPackages.label]);
    const seenNames = new Set<string>();
    for (const note of data.packages) {
      if (seenNames.has(note.name)) {
        return yield* new DesignDataInvalid({ path, reason: `${note.name} is listed twice in packages` });
      }
      seenNames.add(note.name);
      if (note.group._tag === "Some" && !groupLabels.has(note.group.value)) {
        return yield* new DesignDataInvalid({
          path,
          reason: `${note.name} names group "${note.group.value}", which is neither in groups nor groupForOtherPackages`,
        });
      }
    }
    return data;
  }
}

export const DesignDataFileLive = Layer.effect(
  DesignDataFile,
  Effect.gen(function* () {
    return new DesignDataFileImpl(yield* FileSystem.FileSystem);
  }),
);
