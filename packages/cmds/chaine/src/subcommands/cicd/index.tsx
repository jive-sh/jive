import * as React from 'react';
import { SubcommandSelector } from '../../common/subcommand-selector';
import { Docker } from './commands/docker';
import { Packages } from './commands/packages';

enum Subcommands {
  docker = 'docker',
  packages = 'packages',
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
        handler: () => <Docker />,
        description: 'all dockerfile which must be rebuilt/pushed'
      },
      [Subcommands.packages]: {
        isTerminal: false,
        handler: () => <Packages args={remainingArgs} argCollected={argCollected} />,
        description: 'all packages which must be rebuilt/published'
      }
    }}
    subcommandArg={initialSubcommand}
    argCollected={argCollected}
  />
}
