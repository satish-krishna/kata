// Parses `--name value` options and `--flag` switches. Anything else, a repeated option, or a missing value is a
// usage error. Positional arguments are kept in order.
import { UsageError } from './command.ts';

export type Parsed = { positional: string[]; values: Record<string, string>; flags: Set<string> };

export function parseOptions(args: string[], spec: { values?: string[]; flags?: string[] }): Parsed {
  const out: Parsed = { positional: [], values: {}, flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      out.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.flags?.includes(name)) {
      if (out.flags.has(name)) throw new UsageError();
      out.flags.add(name);
    } else if (spec.values?.includes(name)) {
      const value = args[++i];
      if (value === undefined || name in out.values) throw new UsageError();
      out.values[name] = value;
    } else throw new UsageError();
  }
  return out;
}
