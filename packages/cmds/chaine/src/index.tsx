import { DevCommand } from './subcommands/dev/index';
import { render, Text } from 'ink';
import * as React from 'react';
import { COMPANY_NAME } from './common/consts';
import { CICDCommand } from './subcommands/cicd';
import { SubcommandSelector } from './common/subcommand-selector';

const args = process.argv.slice(2);
const initialSubcommand = args.splice(0, 1)[0];

enum Subcommands {
  dev = 'dev',
  cicd = 'cicd'
}

export const COMMAND_NAME = COMPANY_NAME;

const ChaineCommand: React.FC<{}> = ({}) => {
  const noInitialSubcommand = initialSubcommand === undefined;
  const INITIAL_NEXT_TIME = COMMAND_NAME;
  const [nextTime, setNextTime] = React.useState<string | undefined>(noInitialSubcommand ? INITIAL_NEXT_TIME : undefined);
  const [collectedAllArgs, setCollectedAllArgs] = React.useState(false);
  function argCollected(all: boolean, latest?: string) {
    setCollectedAllArgs(all);
    let curNextTime = nextTime;
    if (!all && curNextTime === undefined) {
      curNextTime = INITIAL_NEXT_TIME
    }
    if (latest) {
      curNextTime += ` ${latest}`;
    }
    if (nextTime !== curNextTime) {
      setNextTime(curNextTime);
    }
  }
  return <>
    {nextTime && 
      <Text>next time run <Text color='blueBright'>{nextTime}</Text>{collectedAllArgs ? '' : ' …'}</Text>
    }
    <SubcommandSelector
      subcommandArg={initialSubcommand}
      subcommands={Subcommands}
      subcommandProperties={{
        [Subcommands.dev]: {
          isTerminal: false,
          handler: () => <DevCommand args={args} argCollected={argCollected} />
        },
        [Subcommands.cicd]: {
          isTerminal: false,
          handler: () => <CICDCommand args={args} argCollected={argCollected} />
        }
      }}
      parentCommand={COMMAND_NAME}
      argCollected={argCollected}
    />
  </>
}

render(<ChaineCommand />);
