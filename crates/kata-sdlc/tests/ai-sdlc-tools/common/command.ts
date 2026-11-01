// How a command is shaped, the usage error, and JSON output: what every file in commands/ shares.
import { CouldNotRun } from './types.ts';

/** One command of the program: its usage line (the words after the program's name) and what it does. */
export type Command = {
  usage: string;
  /** Runs the command with the arguments after its name, prints its output, and returns the exit code. */
  run(args: string[]): number | Promise<number>;
};

/** Arguments that fit no usage line. The program prints the usage of every command and exits with 2. */
export class UsageError extends CouldNotRun {
  constructor() {
    super('usage');
  }
}

/** Prints one line of JSON, the output format of every --json command. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}
