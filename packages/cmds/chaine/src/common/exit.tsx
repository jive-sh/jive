import * as React from 'react';

export const Exit: React.FC<{code?: number}> = ({code}) => {
  React.useEffect(() => {
    setTimeout(() => {
      process.exit(code ?? 0);
    }, 200);
  }, []);
  return <></>
}