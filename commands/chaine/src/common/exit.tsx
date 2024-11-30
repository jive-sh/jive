import * as React from 'react';

export const Exit = () => {
  React.useEffect(() => {
    setTimeout(() => {
      process.exit();
    }, 200);
  }, []);
  return <></>
}