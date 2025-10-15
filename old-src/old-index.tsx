import { DevCommand } from './subcommands/pkg/index';
import { render, Text, Newline } from 'ink';
import * as React from 'react';
import { TOOL_NAME } from './common/consts';
import { CICDCommand } from './subcommands/cicd';
import { SubcommandSelector } from './common/subcommand-selector';

const args = process.argv.slice(2);
const initialSubcommand = args.splice(0, 1)[0];

enum Subcommands {
  pkg = 'pkg',
  cicd = 'cicd',
}

const FULL_COMMAND = `${TOOL_NAME}` + 
  (initialSubcommand ? ` ${initialSubcommand}` : '') +
  (args.length ? ` ${args.join(' ')}` : '');

const ChaineCommand: React.FC<{}> = ({}) => {
  const [nextTime, setNextTime] = React.useState(TOOL_NAME);
  const [collectedAllArgs, setCollectedAllArgs] = React.useState(false);
  const [isInitialized, setIsInitizlized] = React.useState(false);
  function argCollected(all: boolean, latest?: string) {
    setCollectedAllArgs(all);
    // console.log(`here!! all=${all} latest=${latest} nextTime=${nextTime}`);
    let curNextTime = nextTime;
    if (latest) {
      curNextTime += ` ${latest}`;
    }
    if (nextTime !== curNextTime) {
      setNextTime(curNextTime);
    }
  }
  React.useEffect(() => {
    setIsInitizlized(true);
  }, []);
  // TODO: don't show next time when invalid subcommand is entered
  const showNextTime = isInitialized && 
    (nextTime !== FULL_COMMAND || !collectedAllArgs);
  return <>
    {showNextTime && 
      <Text><Newline />
        next time run <Text color='blueBright'>{nextTime}</Text>{collectedAllArgs ? '' : ' …'}
      </Text>
    }
    <SubcommandSelector
      subcommandArg={initialSubcommand}
      subcommands={Subcommands}
      subcommandProperties={{
        [Subcommands.pkg]: {
          isTerminal: false,
          handler: () => <DevCommand args={args} argCollected={argCollected} />,
          description: ''
        },
        [Subcommands.cicd]: {
          isTerminal: false,
          handler: () => <CICDCommand args={args} argCollected={argCollected} />,
          description: ''
        }
      }}
      parentCommand={TOOL_NAME}
      argCollected={argCollected}
    />
  </>
}

render(<ChaineCommand />);
