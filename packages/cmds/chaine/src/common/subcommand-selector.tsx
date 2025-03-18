import * as React from 'react';
import { Options } from './options';
import { Text } from 'ink';
import { Exit } from './exit';

export type SubcommandProperties<HandlerProps> = {
  isTerminal: boolean;
  handler: React.FC<HandlerProps>;
}

export function subcommandsFromList(list: string[]): Record<string, string> {
  return Object.fromEntries(list.map(entry => [entry, entry]));
}

export function subcommandPropMap<Subcommands extends Record<string, string>>(
  subcommands: Subcommands,
  map: (subcommand: string) => SubcommandProperties<{subcommand: keyof Subcommands}>
): SubcommandSelectorProps<Subcommands>['subcommandProperties'] {
  const result = Object.fromEntries(Object.entries(subcommands).map(([k, v]) => [k, map(v)]));
  return result as unknown as SubcommandSelectorProps<Subcommands>['subcommandProperties'];
}

export type SubcommandSelectorProps<Subcommands extends Record<string, string>> = {
  subcommands: Subcommands;
  subcommandSubset?: (keyof Subcommands)[];
  subcommandProperties: {[subcommand in keyof Subcommands]:
    SubcommandProperties<{subcommand: subcommand}>};
  subcommandArg: string | undefined;
  parentCommand: string;
  argCollected: (all: boolean, latest?: string) => void;
}

export const SubcommandSelector = <Subcommands extends Record<string, string>,> (props: SubcommandSelectorProps<Subcommands>) => {
  const {subcommands, subcommandProperties, subcommandArg, parentCommand, argCollected, subcommandSubset} = props;
  const [subcommand, setSubcommand] = React.useState<string | undefined>(subcommandArg);
  const [isInitialized, setIsInitialized] = React.useState(false);
  React.useEffect(() => {
    if (subcommandArg === undefined) {
      argCollected(false);
    } else {
      argCollected(false, subcommandArg);
    }
    setIsInitialized(true);
  }, []);
  React.useEffect(() => {
    const cur = subcommandProperties[subcommand as keyof Subcommands];
    if (cur && cur.isTerminal) {
      argCollected(true);
    }
  }, [subcommand]);
  const possibleSubcommands = subcommandSubset ?? Object.values(subcommands);
  return <>
    {isInitialized && <>
      {subcommandArg === undefined &&
        <Options
          options={possibleSubcommands as string[]}
          onChosen={selection => {
            setSubcommand(selection);
            argCollected(false, selection);
          }}
          prompt={`'${parentCommand}' subcommand`}
        />
      }
      {subcommand && (() => {
        // validate subcommand
        if (!possibleSubcommands.includes(subcommand)) {
          const validOptions = possibleSubcommands.map(subcommand => `'${subcommand as string}'`).join(', ');
          return <>
            <Text>Invalid subcommand '{subcommand}' for '{parentCommand}'.</Text>
            <Text>Valid options are {validOptions}</Text>
            <Exit />
          </>
        }
        return subcommandProperties[subcommand].handler({subcommand});
      })()}
    </>}
  </>
}
