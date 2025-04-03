import * as React from 'react';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { Text } from 'ink';

export type OptionsProps = {
  options: Record<string, string>;
  prompt: string;
  onChosen: (selection: string) => void;
  isValid?: (text: string) => Promise<boolean>;
}

export const Options: React.FC<OptionsProps> = ({options, prompt, onChosen, isValid}) => {
  const optionKeys = Object.keys(options);
  const longestOptionLen = Math.max(...optionKeys.map(opt => opt.length));
  const [text, setText] = React.useState(optionKeys[0] ?? "");
  const [validEval, setValidEval] = React.useState(true);
  const [highlighted, setHighlighted] = React.useState<string | undefined>();
  const [choice, setChoice] = React.useState<string | undefined>();
  const filteredOptions = optionKeys.filter(option => option.includes(text));
  const validationFn = (async (textToValidate: string) => {
    if (filteredOptions.includes(textToValidate)) return true;
    if (isValid && (await isValid(textToValidate))) return true;
    return false;
  });
  React.useEffect(() => {
    (async () => {
      const valid = await validationFn(text);
      setValidEval(valid);
    })();
  }, [text, isValid]);
  const icon = (
    (choice || validEval) ? <Text color='green'>✔</Text> :
    <Text color='red'>✖</Text>
  );
  async function handleTextSubmit() {
    const valid = await validationFn(text);
    if (valid) {
      setChoice(text);
      onChosen(text);
    }
  }
  const textToDisplay = (
    choice ? 
      <Text color={'green'}>{choice}</Text> :
      <TextInput value={text} onChange={setText} showCursor={true} onSubmit={handleTextSubmit} />
  );
  const preciseMatch = filteredOptions.length === 1 && filteredOptions[0] === text;
  return <>
    <Text>
      {icon} {prompt}: {textToDisplay}
    </Text>
    {!choice && optionKeys.length > 0 &&
      <>
        <Text>{filteredOptions.length} matches</Text>
        <SelectInput
          items={optionKeys.map(option => ({label: option, value: option}))}
          onSelect={({value}) => { }}
          onHighlight={({value}) => { setText(value); setHighlighted(value); }}
          itemComponent={({isSelected, label}) => {
            const idx = label.indexOf(text);
            const start = idx === -1 ? label : label.substring(0, idx);
            const mid = idx === -1 ? "" : text;
            const end = idx === -1 ? "" : label.substring(idx + text.length);
            const isMatch = idx !== -1;
            const spaceToAdd = (longestOptionLen - label.length) + 4;
            const spaces = "".padStart(spaceToAdd, ' ');
            const description = options[label];
            const exactMatch = text === label;
            return <>
              {(exactMatch) ?
                <Text color="green">  ❯ </Text> :
              (mid.length > 0) ?
                <Text>{(filteredOptions.indexOf(label) + 1).toString().padStart(3)} </Text> :
                <Text color="gray">  · </Text>
              }
              <Text color={isMatch ? "gray" : "gray"}>{start}</Text>
              <Text color="green">{mid}</Text>
              <Text color={isMatch ? "gray" : "gray"}>{end}</Text>
              {description && <>
                <Text color={'grey'}>{spaces} | </Text>
                <Text color={exactMatch ? 'white' : 'gray'}>{description}</Text>
              </>}
            </>
          }}
          indicatorComponent={({isSelected}) => {
            return <Text color={highlighted === text && preciseMatch && isSelected ? 'gray' : 'gray'}></Text>
          }}
        />
      </>
    }
  </>
}
