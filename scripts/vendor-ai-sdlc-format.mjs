// Copies the ai-sdlc plugin's format program into crates/kata-sdlc/tests/ai-sdlc-format/ so Kata's tests
// read a pinned copy, never the plugin repository. The running Workbench never uses this copy; it always
// runs the installed plugin's program.
//
// Source: ../ai-sdlc/plugin, or the folder named by KATA_AI_SDLC_PLUGIN. Copies check.mjs,
// THIRD_PARTY_LICENSES.txt (the licenses of the packages the bundle contains, which ship with every copy),
// schema/ and examples/, and writes the plugin's version into VERSION. Line endings are normalized to LF,
// because this repository is checked out with LF everywhere (.gitattributes) while the sibling checkout
// may have CRLF.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = resolve(process.env.KATA_AI_SDLC_PLUGIN ?? join(repo, '..', 'ai-sdlc', 'plugin'));
const source = join(plugin, 'format');
const target = join(repo, 'crates', 'kata-sdlc', 'tests', 'ai-sdlc-format');

if (!existsSync(join(source, 'check.mjs'))) {
  console.error(`no format program at ${source}; set KATA_AI_SDLC_PLUGIN to the plugin folder`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
if (typeof manifest.version !== 'string') {
  console.error(`${plugin}/.claude-plugin/plugin.json has no version`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

function copyNormalized(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyNormalized(join(from, name), join(to, name));
    return;
  }
  writeFileSync(to, readFileSync(from, 'utf8').replace(/\r\n/g, '\n'));
}

for (const entry of ['check.mjs', 'THIRD_PARTY_LICENSES.txt', 'schema', 'examples']) copyNormalized(join(source, entry), join(target, entry));
writeFileSync(join(target, 'VERSION'), manifest.version + '\n');
console.log(`vendored ai-sdlc format ${manifest.version} from ${source}`);
