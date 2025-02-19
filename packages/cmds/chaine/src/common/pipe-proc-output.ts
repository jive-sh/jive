import {ChildProcess} from "child_process";
import {EventIterator} from "event-iterator";

export enum StreamType {
  stdout = "stdout",
  stderr = "stderr",
}

export type StreamLine = {
  stream: StreamType;
  line: string;
};

export type PipeReturn<ToBuffer extends boolean> = ToBuffer extends true
  ? {
      done: Promise<{code: number; out: {[stream in StreamType]: string}}>;
      lines: AsyncIterable<StreamLine>;
    }
  : {done: Promise<{code: number}>};

/**
 * @return an async generator over each line and a done promise for when the child process finishes.
 */
export function pipeProcOutput<ToBuffer extends boolean>(
  childProc: ChildProcess,
  opts: {toConsole: boolean; toBuffer: ToBuffer}
): PipeReturn<ToBuffer> {
  const {toConsole, toBuffer} = opts;

  if (toConsole && childProc.stdin) {
    process.stdin.pipe(childProc.stdin);
  }

  type Buffers = {
    line: string;
    full: string;
  };

  const procStreams: {[stream in StreamType]: NodeJS.WriteStream} = {
    [StreamType.stdout]: process.stdout,
    [StreamType.stderr]: process.stderr,
  };

  const streamBuffs: {[stream in StreamType]: Buffers} = {
    [StreamType.stdout]: {
      line: "",
      full: "",
    },
    [StreamType.stderr]: {
      line: "",
      full: "",
    },
  };

  function processStreamData(
    data: string,
    stream: StreamType,
    push: (value: StreamLine) => void
  ) {
    if (toConsole) {
      procStreams[stream].write(data);
    }
    if (!toBuffer) {
      return;
    }
    const buffers = streamBuffs[stream];
    buffers.full += data;
    buffers.line += data;
    const lines = buffers.line.split("\n");
    // Set the line buffer to the unfinished (latest) line.
    buffers.line = lines.pop() ?? "";
    // Iterate through all the completed lines and yield them
    for (const line of lines) {
      push({stream, line});
    }
  }

  const result: PipeReturn<true> = {
    done: new Promise<{code: number; out: {[stream in StreamType]: string}}>(
      resolve => {
        childProc.on("close", code => {
          resolve({
            code: code ?? 0,
            out: {
              [StreamType.stderr]: streamBuffs.stderr.full,
              [StreamType.stdout]: streamBuffs.stdout.full,
            },
          });
        });
      }
    ),
    lines: new EventIterator<StreamLine>(
      ({push, stop}) => {
        let stopped = false;
        childProc.stdout?.on("data", data => {
          processStreamData(data.toString(), StreamType.stdout, push);
        });
        childProc.stderr?.on("data", data => {
          processStreamData(data.toString(), StreamType.stderr, push);
        });
        childProc.on("close", () => {
          // in case there was no newline at the end
          Object.values(StreamType).forEach(stream => {
            if (streamBuffs[stream].line.length > 0) {
              processStreamData("\n", stream, push);
            }
          });
          // end the async generator
          if (!stopped) {
            stop();
          }
        });
        if (!toBuffer) {
          stop();
          stopped = true;
        }
        return () => {};
      },
      {highWaterMark: undefined, lowWaterMark: undefined}
    ),
  };

  return result;
}