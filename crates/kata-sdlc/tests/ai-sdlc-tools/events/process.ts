// Runs one hook: a program and its arguments, with no shell, in the repository the event runs in. It gets the event
// as environment variables and as JSON on standard input. Exit 0 passes; any other exit fails. A program that cannot
// start, or runs past its time limit (its whole process tree is then killed), could not run: a fault of the machine,
// never something the agent is sent to fix.
import { spawn, spawnSync } from 'node:child_process';

export type ProcessResult = { outcome: 'passed' | 'failed' | 'could-not-run'; exitCode: number | null; output: string };

const KEEP_LINES = 200;
const KEEP_BYTES = 256 * 1024;

/** Kills a process and everything it started. */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** The last lines of the output, which is all the agent or the engineer needs to see. */
export function tail(text: string, lines = KEEP_LINES): string {
  const all = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return (all.length > lines ? [`… ${all.length - lines} earlier lines left out`, ...all.slice(-lines)] : all).join('\n');
}

export function runProcess(argv: string[], options: { cwd: string; env: Record<string, string>; input: string; timeoutSeconds: number }): Promise<ProcessResult> {
  const [program, ...args] = argv as [string, ...string[]];
  return new Promise((done) => {
    let output = '';
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > KEEP_BYTES * 2) output = output.slice(-KEEP_BYTES);
    };
    let child;
    try {
      child = spawn(program, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      return done({ outcome: 'could-not-run', exitCode: null, output: `cannot start ${program}: ${(e as Error).message}` });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, options.timeoutSeconds * 1000);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ outcome: 'could-not-run', exitCode: null, output: `cannot start ${program}: ${e.code ?? e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return done({ outcome: 'could-not-run', exitCode: null, output: tail(output + `\nstopped: ran past its time limit of ${options.timeoutSeconds} seconds`) });
      done({ outcome: code === 0 ? 'passed' : 'failed', exitCode: code, output: tail(output) });
    });
  });
}
