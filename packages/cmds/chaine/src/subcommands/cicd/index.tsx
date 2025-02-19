import * as React from 'react';
import { SubcommandSelector } from '../../common/subcommand-selector';
import { Docker } from './commands/docker';

enum Subcommands {
  docker = 'docker',
}

export type CICDCommandProps = {
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

export const CICDCommand: React.FC<CICDCommandProps> = ({args, argCollected}) => {
  const [initialSubcommand, ...remainingArgs] = args;
  return <SubcommandSelector
    subcommands={Subcommands}
    parentCommand='cicd'
    subcommandProperties={{
      [Subcommands.docker]: {
        isTerminal: true,
        handler: () => <Docker />
      }
    }}
    subcommandArg={initialSubcommand}
    argCollected={argCollected}
  />
}
