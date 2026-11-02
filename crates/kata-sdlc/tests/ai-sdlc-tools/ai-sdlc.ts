// The ai-sdlc plugin's program. Skills, and tools that drive them such as Kata, run it as
//   node <plugin>/tools/ai-sdlc.ts <command> [arguments]
// It needs Node.js 22.18 or later, which runs TypeScript as it is: there is no build step, and this folder is the
// code that runs. README.md in this folder maps the code. This file only picks the command; each command is one
// file in commands/, which starts with its usage and what it prints.
//
// Exit codes, the same for every command: 0 passed, 1 found problems (printed on standard output), 2 could not
// run (the reason on standard error).
import { UsageError, type Command } from './common/command.ts';
import { CouldNotRun, EXIT } from './common/types.ts';
import { branchName } from './commands/branch-name.ts';
import { change } from './commands/change.ts';
import { check } from './commands/check.ts';
import { commit } from './commands/commit.ts';
import { fixState } from './commands/fix-state.ts';
import { gate } from './commands/gate.ts';
import { guard } from './commands/guard.ts';
import { hooks } from './commands/hooks.ts';
import { instructions } from './commands/instructions.ts';
import { naming } from './commands/naming.ts';
import { read } from './commands/read.ts';
import { resolve } from './commands/resolve.ts';
import { run } from './commands/run.ts';
import { scope } from './commands/scope.ts';
import { stale } from './commands/stale.ts';
import { state } from './commands/state.ts';
import { status } from './commands/status.ts';

const COMMANDS: Record<string, Command> = {
  check,
  read,
  'fix-state': fixState,
  state,
  stale,
  naming,
  'branch-name': branchName,
  scope,
  resolve,
  instructions,
  run,
  hooks,
  status,
  change,
  commit,
  gate,
  guard,
};

const USAGE = 'usage: ' + Object.values(COMMANDS).map((c) => `node ai-sdlc.ts ${c.usage}`).join('\n       ');

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command === undefined) throw new UsageError();
  return await command.run(args);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(USAGE + '\n');
  } else if (e instanceof CouldNotRun) {
    process.stderr.write(e.message + '\n');
  } else {
    process.stderr.write(`internal error: ${(e as Error).stack ?? e}\n`);
  }
  process.exitCode = EXIT.COULD_NOT_RUN;
}
