import { DevCommand } from './subcommands/dev/index';
import { Options } from './common/options';
import { render, Text } from 'ink';
import * as React from 'react';
import { Exit } from './common/exit';
import { COMPANY_NAME } from './common/projects';

const args = process.argv.slice(2);
const initialSubcommand = args.splice(0, 1)[0];

enum Subcommands {
  dev = 'dev',
  cicd = 'cicd'
}

export const COMMAND_NAME = COMPANY_NAME;

const ChaineCommand: React.FC<{}> = ({}) => {
  const [subcommand, setSubcommand] = React.useState<string | undefined>(initialSubcommand);
  const noInitialSubcommand = initialSubcommand === undefined;
  const INITIAL_NEXT_TIME = COMMAND_NAME;
  const [nextTime, setNextTime] = React.useState<string | undefined>(noInitialSubcommand ? INITIAL_NEXT_TIME : undefined);
  const [collectedAllArgs, setCollectedAllArgs] = React.useState(false);
  const collectArg = (subcommand: Subcommands) => (all: boolean, latest?: string) => {
    setCollectedAllArgs(all);
    let curNextTime = nextTime;
    if (!all && curNextTime === undefined) {
      curNextTime = `${INITIAL_NEXT_TIME} ${subcommand}`;
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
    {initialSubcommand === undefined &&
      <Options
        options={Object.values(Subcommands)}
        onChosen={selection => {
          setSubcommand(selection);
          setNextTime(`${nextTime} ${selection}`);
          // TODO: remove this clause once cicd is implemented w/ multiple options
          if (selection === Subcommands.cicd) {
            setCollectedAllArgs(true);
          }
        }}
        prompt={`'${COMMAND_NAME}' subcommand`}
      />
    }
    {subcommand && (() => {
      switch (subcommand as Subcommands) {
        case Subcommands.dev:
          return <DevCommand args={args} argCollected={collectArg(Subcommands.dev)} />;
        case Subcommands.cicd:
          return <>
            <Text>cicd not yet implemented</Text>
            <Exit />
          </>
        default:
          const validOptions = Object.values(Subcommands).map(subcommand => `'${subcommand}'`).join(', ');
          return <>
            <Text>Invalid subcommand '{subcommand}'. Valid options are {validOptions}</Text>
            <Exit />
          </>
      }
    })()}
  </>
}

render(<ChaineCommand />);
