// Reads the parity check's command-line options. `argv` is process.argv.slice(2).
// Returns { only, update }, where `only` is a Set of view names or null.
// Throws an Error whose message ends with the usage line on a refusal.
export const USAGE =
  'usage: npm run check:parity [-- --only name,name]\n' +
  '       npm run check:parity -- --update --only name,name';

export function parseOptions(argv, viewNames) {
  const update = argv.includes('--update');
  const onlyArg = argv.indexOf('--only');
  const onlyValue = onlyArg >= 0 ? argv[onlyArg + 1] : undefined;
  if (onlyArg >= 0 && (!onlyValue || onlyValue.startsWith('--'))) {
    throw new Error(`--only needs a comma-separated view list
${USAGE}`);
  }
  if (update && onlyArg < 0) {
    throw new Error(`--update needs --only
${USAGE}`);
  }
  const only = onlyArg >= 0 ? new Set(onlyValue.split(',').filter(Boolean)) : null;
  if (only) {
    const unknown = [...only].filter((n) => !viewNames.includes(n));
    if (unknown.length || only.size === 0) {
      throw new Error(`unknown view(s): ${unknown.join(', ') || '(none given)'}
valid views: ${viewNames.join(', ')}
${USAGE}`);
    }
  }
  return { only, update };
}
