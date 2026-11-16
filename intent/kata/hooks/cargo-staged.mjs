// Runs a cargo command over the whole kata workspace for a build.finish hook, after staging the engine as the app's
// sidecar: app/src-tauri's build script fails on a clean checkout without it. The hook runs in the repository's root;
// the staged binary under app/src-tauri/binaries/ is git-ignored, so the check leaves the working tree clean.
//
// For `cargo test` it adds --no-fail-fast, so every test target runs even after one fails, and writes the name of each
// failing test to the file HOSHIN_FAILURES names, one per line, as "<crate> <source>::<test>". That lets the baseline
// tell a test that already failed on the base from a new one. A run that fails without a failing test (a compile error)
// writes nothing, so the plugin treats it as a failure that does not say what failed.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The failing tests in cargo's output, each named by the test binary it ran in and the test's own name. */
export function failingTests(output) {
  const ids = new Set();
  let target = '';
  for (const line of output.split(/\r?\n/)) {
    // "     Running tests\format_conformance.rs (target\debug\deps\format_conformance-0123abcd.exe)"
    // "     Running unittests src\lib.rs (target\debug\deps\kata_sdlc-0123abcd.exe)"
    const running = /^\s+Running (?:unittests )?(.+?) \((?:.*[\\/])?([^\\/]+?)-[0-9a-f]+(?:\.exe)?\)$/.exec(line);
    if (running) {
      target = `${running[2]} ${running[1].replaceAll('\\', '/')}`;
      continue;
    }
    // "   Doc-tests kata_core"
    const doc = /^\s+Doc-tests (\S+)$/.exec(line);
    if (doc) {
      target = `${doc[1]} doc-tests`;
      continue;
    }
    // "---- the_vendored_copy_matches_the_sibling_checkout stdout ----"
    const failed = /^---- (.+) stdout ----$/.exec(line);
    if (failed) ids.add(`${target}::${failed[1]}`);
  }
  return [...ids];
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('usage: node cargo-staged.mjs <cargo arguments>\n');
    process.exit(2);
  }
  const staged = spawnSync(process.execPath, ['app/scripts/stage-sidecar.mjs'], { stdio: 'inherit' });
  if (staged.status !== 0) {
    process.stderr.write(`cargo-staged: staging the sidecar failed (${staged.error?.message ?? `exit ${staged.status}`})\n`);
    process.exit(staged.status || 1);
  }

  const testing = args[0] === 'test';
  const cargoArgs = testing && !args.includes('--no-fail-fast') ? ['test', '--no-fail-fast', ...args.slice(1)] : args;

  let output = '';
  const child = spawn('cargo', cargoArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
  });
  child.on('error', (e) => {
    process.stderr.write(`cargo-staged: cannot run cargo (${e.message})\n`);
    process.exit(1);
  });
  child.on('close', (code) => {
    const failuresFile = process.env.HOSHIN_FAILURES;
    if (testing && code !== 0 && failuresFile) {
      const ids = failingTests(output);
      if (ids.length > 0) writeFileSync(failuresFile, `${ids.join('\n')}\n`);
    }
    process.exit(code ?? 1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
