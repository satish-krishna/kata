// Copies the hoshin plugin's program (its tools/ folder) into crates/kata-sdlc/tests/hoshin-tools/ so
// Kata's tests run a pinned copy, never the plugin repository. The running Workbench never uses this
// copy; it always runs the installed plugin's program.
//
// Source: ../hoshin, or the folder named by KATA_HOSHIN_PLUGIN. Copies everything the program
// needs to run (hoshin.ts, commands/, documents/, changes/, workspace/, events/, git/, common/, schema/,
// vendor/) and examples/ for the tests. Development files (node_modules, test/, package.json,
// package-lock.json, tsconfig.json, scripts/, coverage/, CLIENTS.md) are left out. Writes the plugin's version into VERSION.
// Line endings are normalized to LF, because this repository is checked out with LF everywhere
// (.gitattributes) while the sibling checkout may have CRLF.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = resolve(process.env.KATA_HOSHIN_PLUGIN ?? join(repo, '..', 'hoshin'));
const source = join(plugin, 'tools');
const target = join(repo, 'crates', 'kata-sdlc', 'tests', 'hoshin-tools');
const left = new Set(['node_modules', 'test', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'coverage', 'CLIENTS.md']);

if (!existsSync(join(source, 'hoshin.ts'))) {
  console.error(`no hoshin program at ${source}; set KATA_HOSHIN_PLUGIN to the plugin folder`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
if (typeof manifest.version !== 'string') {
  console.error(`${plugin}/.claude-plugin/plugin.json has no version`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// A text file is copied with LF endings; anything else (none today) byte for byte.
const text = /\.(ts|mts|mjs|js|json|md|txt|yml|yaml|feature)$/;
function copyNormalized(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (from === source && left.has(name)) continue;
      copyNormalized(join(from, name), join(to, name));
    }
    return;
  }
  const bytes = readFileSync(from);
  writeFileSync(to, text.test(from) ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes);
}

copyNormalized(source, target);
// The program reads its workspace instructions templates from <plugin>/references/templates, which is
// tests/references/templates relative to the vendored tools.
const templates = join(repo, 'crates', 'kata-sdlc', 'tests', 'references', 'templates');
rmSync(templates, { recursive: true, force: true });
mkdirSync(templates, { recursive: true });
for (const name of ['workspace.md', 'workspace-single-repo.md']) {
  copyNormalized(join(plugin, 'references', 'templates', name), join(templates, name));
}
writeFileSync(join(target, 'VERSION'), manifest.version + '\n');
console.log(`vendored hoshin tools ${manifest.version} from ${source}`);
