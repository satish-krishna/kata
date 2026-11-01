// hooks --json --system <system> [--event <event>] [--master <path>] [--workspace <path>]
// Prints the hooks of a system as they will run, merged from `.ai-sdlc.json` and `intent/<system>/hooks.json` as
// committed on the master repository's base branch: `{ "revision", "gateRetries", "hooks", "problems" }`, each
// hook with its event, side, arguments, repositories, time limit, whether it blocks and what a failure asks for.
// Exit 0 when the configuration has no problems, 1 when it has.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { CouldNotRun, EXIT } from '../common/types.ts';
import { EVENTS, readHookConfig } from '../events/config.ts';
import { readMarker } from '../workspace/marker.ts';
import { resolveWorkspace } from '../workspace/resolve.ts';
import { join } from 'node:path';

export const hooks: Command = {
  usage: 'hooks --json --system <system> [--event <event>] [--master p] [--workspace p]',
  run(args) {
    const o = parseOptions(args, { values: ['system', 'event', 'master', 'workspace'], flags: ['json'] });
    const { system, event } = o.values;
    if (!o.flags.has('json') || !system || o.positional.length > 0) throw new UsageError();
    if (event !== undefined && !(EVENTS as readonly string[]).includes(event)) throw new UsageError();
    const r = resolveWorkspace(process.cwd(), { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) });
    if (r.master === null) throw new CouldNotRun(r.problems.join('\n'));
    if (!readMarker(join(r.master, '.ai-sdlc.json')).systems[system]) throw new CouldNotRun(`the marker lists no system ${system}`);
    const config = readHookConfig(r.master, system);
    const list = config.hooks.filter((h) => event === undefined || h.event === event);
    printJson({ revision: config.revision, gateRetries: config.gateRetries, hooks: list, problems: config.problems });
    return config.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
