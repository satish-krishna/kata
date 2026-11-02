// A stand-in for the GitHub command-line tool, preloaded with `NODE_OPTIONS=--require=<this file>` into a copy of
// Node.js named `gh`: the preload runs before Node resolves `auth` or `pr` as a script, answers `auth status`,
// `pr list`, `pr create` and `pr view`, and exits. Pull requests are kept in the file named by FAKE_GH_STATE.
// FAKE_GH_AUTH=fail fails `auth status` and FAKE_GH_CREATE=fail fails `pr create`. Under any other program name it does
// nothing, so the plugin's own Node.js processes run as usual. The unit tests in src/done.rs read this file too.
const path = require('path');
if (path.basename(process.execPath).replace(/\.exe$/i, '') === 'gh') {
  const fs = require('fs');
  // Node expanded the subcommand into a path; its last part is the word.
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];
  const repo = path.basename(process.cwd());
  const stateFile = process.env.FAKE_GH_STATE;
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { prs: [] };
  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ repo, args }) + '\n');
  const opt = (name) => args[args.indexOf(name) + 1];
  const say = (text) => fs.writeSync(1, text + '\n');
  if (args[0] === 'auth') process.exit(process.env.FAKE_GH_AUTH === 'fail' ? 1 : 0);
  if (args[0] === 'pr' && args[1] === 'list') {
    say(JSON.stringify(state.prs.filter((p) => p.repo === repo && p.head === opt('--head')).map(({ number, url }) => ({ number, url })).slice(0, 1)));
  } else if (args[0] === 'pr' && args[1] === 'create') {
    if (process.env.FAKE_GH_CREATE === 'fail') { fs.writeSync(2, 'GraphQL: something went wrong\n'); process.exit(1); }
    const number = state.prs.length + 1;
    const url = 'https://github.com/example/' + repo + '/pull/' + number;
    state.prs.push({ repo, number, url, head: opt('--head'), base: opt('--base'), title: opt('--title') });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    say(url);
  } else if (args[0] === 'pr' && args[1] === 'view') {
    say(JSON.stringify({ state: 'OPEN' }));
  } else process.exit(3);
  process.exit(0);
}
