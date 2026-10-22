/** A scenario step split into its keyword (`Given`, `When`, ...) and the rest of the line. */
export function splitStep(step: string): [string, string] {
  const space = step.indexOf(' ');
  return space < 0 ? [step, ''] : [step.slice(0, space), step.slice(space + 1)];
}
