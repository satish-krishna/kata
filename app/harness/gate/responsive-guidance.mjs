// The corrective message for the responsive gate. Hands back the documented
// definition of failure and the documented fix, per the corrective-message
// convention (see harness/README.md). No guidance is invented here that the
// house-style responsive-correctness section does not already state.
export function formatCorrectiveMessage(failures) {
  const lines = failures.map(
    (f) => `  - [${f.breakpoint}px] ${f.kind}: ${f.selector} (${f.detail})`,
  );
  return [
    'Responsive check failed. The house-style responsive-correctness rule requires',
    'that at 375px, 768px, and 1280px the page does not scroll horizontally, no element',
    'escapes the viewport, and no element clips its own content (intentional overflow:auto',
    'or overflow:scroll containers are exempt).',
    '',
    'Failures:',
    ...lines,
    '',
    'Fix by letting the layout reflow at narrow widths: use a responsive grid',
    '(grid-cols-1 sm:grid-cols-2), wrap button rows (flex-wrap), and drop fixed pixel',
    'widths that cannot shrink. Re-run: npm run check:responsive',
  ].join('\n');
}
