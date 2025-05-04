import * as React from "react";
import { subcommandPropMap, SubcommandSelector, subcommandsFromList } from "../../../../common/subcommand-selector";
import { Exit } from "../../../../common/exit";
import { getSecret, getSecretsNamespaceFromPackageName, listSecrets } from "../../../../common/secrets-fetcher";

export type GetSecretProps = {
  packageName: string;
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

const GetSecretHandler: React.FC<{ secret: string; namespace: string; }> = ({ secret, namespace }) => {
  const [done, setDone] = React.useState(-1);
  React.useEffect(() => {
    (async () => {
      const secretResult = await getSecret(namespace, secret);
      if (!secretResult.success) {
        console.log(`Unable to fetch secret '${secret}' from namespace '${namespace}'`);
        console.log(`${secretResult.error}: ${secretResult.reason}`);
        setDone(1);
      } else {
        console.log(secretResult.value);
        setDone(0);
      }
    })();
  }, []);
  return <>
    {done >= 0 && <Exit code={done} />}
  </>;
}

enum FetchedSecretsStatus {
  Pending = 'Pending',
  Failed = 'Failed',
  Done = 'Done'
}

export const GetSecret: React.FC<GetSecretProps> = ({args, argCollected, packageName}) => {
  const [initialSecret, ...remainingArgs] = args;
  const [secretsFetchStatus, setSecretsFetchStatus] = React.useState(FetchedSecretsStatus.Pending);
  const [allSecrets, setAllSecrets] = React.useState<string[] | undefined>(undefined);
  const secretsNamespace = getSecretsNamespaceFromPackageName(packageName);
  React.useEffect(() => {
    (async () => {
      const allSecretsResult = await listSecrets(secretsNamespace);
      if (!allSecretsResult.success) {
        console.log(`Failed to fetch secrets for package '${packageName}' (namespace '${secretsNamespace}')`);
        console.log(`${allSecretsResult.error}: ${allSecretsResult.reason}`);
        setSecretsFetchStatus(FetchedSecretsStatus.Failed);
        return;
      }
      setAllSecrets(allSecretsResult.value);
      setSecretsFetchStatus(FetchedSecretsStatus.Done);
    })();
  }, []);
  if (allSecrets) {
    const possibleSubcommands = subcommandsFromList(allSecrets);
    const subcommandProperties = subcommandPropMap(possibleSubcommands, () => ({
      isTerminal: true,
      handler: ({ subcommand }) => {
        return <GetSecretHandler secret={subcommand} namespace={secretsNamespace} />
      },
      description: ''
    }));
    return <SubcommandSelector
      subcommands={possibleSubcommands}
      subcommandProperties={subcommandProperties}
      parentCommand='get-secret'
      subcommandArg={initialSecret}
      argCollected={argCollected}
    />
  }
  return <>
    {secretsFetchStatus === FetchedSecretsStatus.Failed && <Exit code={1} />}
  </>
}
