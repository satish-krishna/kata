/* Build start and checks prototype (change 2026-11-16-build-checks-workbench). Plain JS, no modules, no network:
   opens from disk. Every screen is a function in SCREENS; the switcher at the top reaches each one, and the buttons
   on each screen move between them the way the Workbench would. Recreate in Angular, never copy. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var code = function (s) { return '<code class="bc-mono">' + esc(s) + '</code>'; };
  var status = function (tone, text) { return '<span class="k-status k-status--' + tone + '"><span class="k-status__dot"></span>' + esc(text) + '</span>'; };
  var btn = function (label, kind, attrs) { return '<button class="k-btn k-btn--' + (kind || 'secondary') + ' k-btn--sm" type="button" ' + (attrs || '') + '>' + label + '</button>'; };
  var badge = function (tone, text) { return '<span class="k-badge k-badge--' + tone + '">' + esc(text) + '</span>'; };

  var CHANGE = '2026-11-16-add-single-repo-workspace';
  var BRANCH = 'change/' + CHANGE;
  var BASE = '3c504eb';

  /* The team's checks, in the order hoshin runs them, with how long each took on the base. */
  var CHECKS = [
    { id: 'app-responsive', what: 'Every route at 1280 and 1600', secs: 212 },
    { id: 'app-interaction', what: 'Every overlay opens and closes', secs: 141 },
    { id: 'app-build-page', what: 'The build page at 1280 by 800', secs: 96 },
    { id: 'app-start-flow', what: 'The light track routes', secs: 88 },
    { id: 'app-boot', what: 'Every route renders', secs: 174 },
    { id: 'app-wiring', what: 'No orphaned members', secs: 31 },
    { id: 'app-speed', what: 'The Workbench speed targets', secs: 158 },
    { id: 'rust-fmt', what: 'Rust formatting', secs: 6 },
    { id: 'rust-clippy', what: 'Rust lints', secs: 402 },
    { id: 'rust-test', what: 'Rust tests, whole workspace', secs: 1384 },
    { id: 'app-unit', what: 'Frontend unit tests', secs: 117 },
    { id: 'app-lint', what: 'Frontend lint', secs: 44 }
  ];
  var TOTAL_SECS = CHECKS.reduce(function (a, c) { return a + c.secs; }, 0);
  var fmt = function (s) { return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60 < 10 ? '0' : '') + (s % 60) + 's' : s + 's'; };

  var SPEED_OUT = [
    '   Compiling kata-app v4.0.0 (D:\\workspaces\\.hoshin\\copies\\' + CHANGE + '\\app\\src-tauri)',
    '    Finished `test` profile [unoptimized + debuginfo] target(s) in 2m 06s',
    '     Running unittests src\\lib.rs',
    '',
    'running 1 test',
    'speed_targets: 3 open, 19 finished: every open change\'s name: 1.2078517s (limit 1 s)',
    'speed_targets: 3 open, 19 finished: every open change\'s name: retry 1.2276638s',
    'speed_targets: 3 open, 19 finished: every open change\'s stage: 2.5267346s (limit 3 s)',
    'speed_targets: 3 open, 97 finished: every open change\'s stage: 3.2942186s (limit 3 s)',
    'speed_targets: 3 open, 97 finished: every open change\'s stage: retry 2.7998515s',
    '',
    'thread \'sdlc_home::tests::speed_targets\' panicked at app\\src-tauri\\src\\sdlc_home.rs:1022:9:',
    'speed targets missed: ["3 open, 19 finished: every open change\'s name took 1.2078517s, then 1.2276638s, limit 1 s"]',
    'test sdlc_home::tests::speed_targets ... FAILED',
    '',
    'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 196 filtered out; finished in 32.77s'
  ].join('\n');
  var PLAYWRIGHT_OUT = [
    '> kata-workbench@4.0.0 check:responsive',
    '> node scripts/check-responsive-desktop.mjs',
    '',
    'node:internal/modules/package_json_reader:301',
    '  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);',
    '        ^',
    '',
    'Error [ERR_MODULE_NOT_FOUND]: Cannot find package \'playwright\' imported from',
    '  D:\\workspaces\\.hoshin\\copies\\' + CHANGE + '\\app\\harness\\playwright\\serve-and-visit.mjs',
    '',
    'Node.js v24.18.0'
  ].join('\n');

  var state = {
    screen: 'checking',
    at: 0,            // index of the check running now, in the live screen
    elapsed: 0,       // seconds into the check running now
    accepted: {},     // check id -> true
    open: {},         // check id -> output shown
    dialog: null,     // { kind, id? }
    many: false,      // nine failing, the broken-setup case
    refreshed: false, // the stale screen, after the window regained focus
    activity: 0,      // the active-changes screen: which example list is shown
    listOpen: true    // the active-changes screen: the list is open
  };

  /* The top bar's list of active changes (D10): the label counts each kind by name and never calls the list "running". */
  var ACTIVITY = [
    [{ change: 'build-checks-workbench', state: 'finished', tone: 'success' }],
    [{ change: 'add-single-repo-workspace', state: 'build in kata', tone: 'running' },
     { change: 'open-changes-home', state: 'spec', tone: 'running' },
     { change: 'parity-baselines', state: 'needs an answer', tone: 'warning' }],
    [{ change: 'add-single-repo-workspace', state: 'build in kata', tone: 'running' },
     { change: 'open-changes-home', state: 'spec', tone: 'running' },
     { change: 'parity-baselines', state: 'needs an answer', tone: 'warning' },
     { change: 'build-checks-workbench', state: 'finished', tone: 'success' }]
  ];
  function activityLabel(list) {
    var n = function (tone) { return list.filter(function (e) { return e.tone === tone; }).length; };
    return [[n('running'), 'running'], [n('warning'), 'needs you'], [n('success'), 'finished']]
      .filter(function (p) { return p[0] > 0; }).map(function (p) { return p[0] + ' ' + p[1]; }).join(' · ');
  }
  function activityFor(screen) {
    if (screen === 'activity') return ACTIVITY[state.activity];
    if (screen === 'checking' || screen === 'running' || screen === 'running-finish') return [{ change: 'add-single-repo-workspace', state: screen === 'checking' ? 'preparing kata' : 'build in kata', tone: 'running' }];
    return [];
  }
  var timer = null;

  /* ---------- Shell ---------- */
  function toolbar() {
    return '<div class="wb-brand"><div class="wb-seal">型</div><span class="bc-eyebrow">AI-SDLC</span></div>' +
      '<div class="wb-sep"></div>' +
      '<div class="bc-change"><span class="bc-change__name">' + esc(CHANGE) + '</span>' +
      '<span class="bc-change__meta">' + esc(BRANCH) + ' · copy D:/workspaces/.hoshin/copies/' + esc(CHANGE) + '</span></div>' +
      activityButton() +
      '<div class="wb-toolbar__spacer"></div>';
  }

  function activityButton() {
    var list = activityFor(state.screen);
    if (list.length === 0) return '';
    var label = activityLabel(list);
    var open = state.screen === 'activity' && state.listOpen;
    var pop = open ? '<div class="bc-pop" role="dialog" aria-label="' + esc(label) + '"><p class="bc-pop__title">' + esc(label) + '</p>' +
      '<ul class="bc-pop__list" aria-label="Changes with activity">' + list.map(function (e) {
        return '<li><span class="bc-row__name">' + esc(e.change) + '</span><span class="bc-faint bc-mono">kata</span>' + status(e.tone, e.state) + '</li>';
      }).join('') + '</ul></div>' : '';
    return '<div class="wb-sep"></div><div class="bc-act">' + btn(esc(label), 'secondary', 'data-list aria-expanded="' + open + '"') + pop + '</div>';
  }

  function strip(middle, actions) {
    return '<div class="bc-tabs" role="tablist"><span class="bc-tab">Intent</span><span class="bc-tab">Spec</span><span class="bc-tab">Plan</span><span class="bc-tab bc-tab--on" aria-selected="true">Build</span></div>' +
      '<div class="wb-sep"></div>' + (middle || '') + '<div class="bc-spacer"></div>' + (actions || '');
  }

  /* ---------- The check list ---------- */
  function rowFor(c, i, mode) {
    var cls = 'bc-row', right = '', when = '';
    if (mode === 'live') {
      if (i < state.at) { right = c.id === 'app-speed' ? status('error', 'failed') : status('success', 'passed'); when = fmt(c.secs); }
      else if (i === state.at) { cls += ' bc-row--now'; right = status('running', 'running'); when = fmt(state.elapsed); }
      else { right = '<span class="bc-faint">waiting</span>'; when = ''; }
    } else if (mode === 'cutoff') {
      if (i < 2) { right = status('success', 'passed'); when = fmt(c.secs); }
      else if (i === 2) { cls += ' bc-row--cut'; right = status('warning', 'cut off'); when = 'started 14:31'; }
      else { right = '<span class="bc-faint">did not run</span>'; }
    }
    return '<div class="' + cls + '"><span class="bc-row__name">' + esc(c.id) + '</span><span class="bc-row__what">' + esc(c.what) + '</span>' +
      '<span class="bc-row__time">' + when + (when ? '&nbsp;&nbsp;' : '') + right + '</span></div>';
  }

  function checkList(mode) {
    var done = mode === 'live' ? state.at : 0;
    var head = '<div class="bc-list__head"><h2 class="bc-eyebrow">Checks on the base ' + esc(BASE) + '</h2>' +
      (mode === 'live' ? '<span class="bc-progress__count">' + done + ' of ' + CHECKS.length + ' done</span>' : '') +
      '<div class="bc-spacer"></div><span class="bc-faint bc-mono">usually about ' + Math.round(TOTAL_SECS / 60) + ' min</span></div>';
    var prep = '<div class="bc-list__head"><h2 class="bc-eyebrow">Preparation</h2><div class="bc-spacer"></div></div>' +
      '<div class="bc-row"><span class="bc-row__name">app-deps</span><span class="bc-row__what">Install the app\'s packages if missing · build.start hook, not a check</span><span class="bc-row__time">1s&nbsp;&nbsp;' + status('success', 'passed') + '</span></div>';
    return '<section class="bc-list" aria-label="Checks">' + prep + head + CHECKS.map(function (c, i) { return rowFor(c, i, mode); }).join('') + '</section>';
  }

  /* ---------- Failure panel (on the page, shown once) ---------- */
  function outputBlock(id, text) {
    if (!state.open[id]) return '';
    var lines = text.split('\n');
    return '<pre class="bc-out" aria-label="Output of ' + esc(id) + '">' + esc(text) + '</pre>' +
      '<span class="bc-out__foot">' + lines.length + ' lines · the last 200 are kept · copy</span>';
  }

  function failingSet() {
    if (!state.many) return [{ id: 'app-speed', exit: 101, out: SPEED_OUT }];
    return ['app-responsive', 'app-interaction', 'app-build-page', 'app-start-flow', 'app-boot', 'app-wiring', 'app-speed', 'app-unit', 'app-lint']
      .map(function (id) { return { id: id, exit: 1, out: id === 'app-speed' ? SPEED_OUT : PLAYWRIGHT_OUT }; });
  }

  function failedPanel() {
    var fails = failingSet();
    var left = fails.filter(function (f) { return !state.accepted[f.id]; });
    var title = left.length === 0
      ? 'Every check that fails on the base is accepted for this build'
      : (fails.length === 1 ? '1 check fails on the base and does not say what failed' : fails.length + ' of ' + CHECKS.length + ' checks fail on the base and do not say what failed');
    var head = '<div class="bc-fail__head">' +
      (left.length === 0 ? status('success', 'Ready to start') : status('error', 'The build did not start')) +
      '<h2 class="bc-fail__title">' + esc(title) + '</h2>' +
      '<p class="bc-note">A failure already on the base cannot be told apart from a new one when the check does not say what failed. ' +
      'Accept a check to let it through for this build, or fix it on ' + code('main') + ' first. The branch and the copy are untouched.</p>' +
      (fails.length >= 3 ? '<div class="bc-hint"><span>' + status('warning', fails.length + ' at once') + '</span><span>When most checks fail together, the setup is usually broken (missing packages, a tool not installed), not the code. Read one output before accepting any.</span></div>' : '') +
      '</div>';
    var items = fails.map(function (f) {
      var acc = state.accepted[f.id];
      return '<div class="bc-item"><div class="bc-item__top">' +
        '<span class="bc-row__name">' + esc(f.id) + '</span>' +
        (acc ? badge('warning', 'accepted for this build') : badge('error', 'failed on the base')) +
        '<span class="bc-faint bc-mono">exit ' + f.exit + ' · ' + esc(BASE) + '</span>' +
        '<div class="bc-spacer"></div>' +
        btn(state.open[f.id] ? 'Hide output' : 'Show output', 'ghost', 'data-out="' + f.id + '"') +
        (acc ? '' : btn('Accept for this build…', 'secondary', 'data-accept="' + f.id + '"')) +
        '</div>' +
        '<p class="bc-item__why">' + (acc
          ? 'It still runs at finish and its result is shown, but it will not block this build while the base stays at ' + code(BASE) + '.'
          : 'It wrote no list of what failed, so hoshin cannot compare the base with this build.') + '</p>' +
        outputBlock(f.id, f.out) + '</div>';
    }).join('');
    var passed = CHECKS.length - fails.length;
    var foot = '<div class="bc-fold">' + passed + ' other checks passed on the base · show</div>' +
      (left.length === 0 ? '<div class="bc-ok">' + status('success', 'Nothing left to settle') + '<span class="bc-note">Start build again: it reuses the base results, so no check reruns on the base.</span></div>' : '');
    return '<section class="bc-fail' + (left.length === 0 ? ' bc-fail--settled' : '') + '" aria-label="Why the build did not start">' + head + items + foot + '</section>';
  }

  /* ---------- Screens ---------- */
  var SCREENS = {
    checking: {
      label: 'Checking the base',
      strip: function () {
        var c = CHECKS[state.at];
        return strip(status('running', 'Preparing') +
          '<span class="bc-progress" role="status"><span>Checking the base</span><span class="bc-progress__check">' + esc(c.id) + '</span>' +
          '<span class="bc-progress__count">' + (state.at + 1) + ' of ' + CHECKS.length + ' · ' + fmt(state.elapsed) + '</span></span>' +
          btn('Stop', 'ghost', 'data-stop aria-label="Stop preparing the build"'));
      },
      body: function () {
        return '<div class="bc-page"><p class="bc-note">Before the first task, hoshin runs every team check on the base commit ' + code(BASE) + ', so a failure the change did not cause is never blamed on it. The result is kept: the next start, and the finish, reuse it.</p>' + checkList('live') + '</div>';
      },
      enter: startTicking
    },
    cutoff: {
      label: 'A check cut off',
      strip: function () {
        return strip(status('warning', 'Cut off') +
          '<span class="bc-progress"><span>Checking the base stopped at</span><span class="bc-progress__check">' + esc(CHECKS[2].id) + '</span><span class="bc-progress__count">2 of ' + CHECKS.length + ' done</span></span>',
          btn('Start build', 'primary', 'data-go="checking"'));
      },
      body: function () {
        return '<div class="bc-page"><div class="bc-hint" role="status"><span>' + status('warning', 'Cut off') + '</span><span>' + code(CHECKS[2].id) + ' started at 14:31 in another session, and the program running it has ended without a result (closed or crashed). hoshin keeps no check until the last one ends, so the next start runs all ' + CHECKS.length + ' on the base again.</span></div>' + checkList('cutoff') + '</div>';
      }
    },
    failed: {
      label: 'Failed on the base',
      strip: function () {
        var left = failingSet().filter(function (f) { return !state.accepted[f.id]; }).length;
        return strip(left ? status('error', 'Did not start') : status('idle', 'Ready to build'),
          left ? btn('Start build', 'primary', 'disabled title="Accept or fix the failing checks first"') : btn('Start build', 'primary', 'data-go="running"'));
      },
      body: function () { return '<div class="bc-page">' + failedPanel() + '</div>'; }
    },
    many: {
      label: 'Nine failed at once (D3)',
      enter: function () { state.many = true; },
      leave: function () { state.many = false; },
      strip: function () { return SCREENS.failed.strip(); },
      body: function () { return SCREENS.failed.body(); }
    },
    stopped: {
      label: 'Stopped during the checks (D8)',
      strip: function () {
        return strip(status('warning', 'Stopped') + '<span class="bc-progress">7 of 12 checks had run · none kept</span>', btn('Start build', 'primary', 'data-go="checking"'));
      },
      body: function () {
        return '<div class="bc-page"><div class="bc-hint" role="status"><span>' + status('warning', 'Copy on the base') + '</span><span>The copy stays on the base commit ' + code(BASE) + ' until the build starts again. Your work is safe on ' + code(BRANCH) + '; the next start puts the copy back on it first, then runs all 12 checks again.</span></div></div>';
      }
    },
    elsewhere: {
      label: 'Already running elsewhere (D2)',
      strip: function () { return strip(status('idle', 'Ready to build'), btn('Start build', 'primary', 'data-elsewhere')); },
      body: function () {
        return '<div class="bc-page"><p class="bc-note">The plan is accepted. No run of this change is open in this Workbench.</p>' +
          '<div class="bc-task">' + status('idle', 'T1') + '<span>Accept a single-repo folder in Add workspace</span><div class="bc-spacer"></div><span class="bc-faint bc-mono">kata</span></div>' +
          '<div class="bc-task">' + status('idle', 'T2') + '<span>Show the system and its apps before adding</span><div class="bc-spacer"></div><span class="bc-faint bc-mono">kata</span></div></div>';
      }
    },
    finish: {
      label: 'Failed at finish (D4)',
      strip: function () { return strip(status('error', 'Checks failed at finish'), btn('Run checks again', 'primary', 'data-go="running-finish"')); },
      body: function () {
        state.open['app-speed-finish'] = state.open['app-speed-finish'] !== false;
        return '<div class="bc-page"><section class="bc-fail" aria-label="Checks at finish">' +
          '<div class="bc-fail__head">' + status('error', 'Build finished, 1 check failed') +
          '<h2 class="bc-fail__title">app-speed failed at finish, and it passed on the base</h2>' +
          '<p class="bc-note">A check that passes on the base and fails now blocks the change: that is what the checks are for, so accepting is not offered. If the failure has nothing to do with the change (a timing check on a busy machine), run the checks again.</p></div>' +
          '<div class="bc-item"><div class="bc-item__top"><span class="bc-row__name">app-speed</span>' + badge('error', 'new failure') +
          '<span class="bc-faint bc-mono">exit 101 · on failure: fix</span><div class="bc-spacer"></div>' + btn(state.open['app-speed-finish'] ? 'Hide output' : 'Show output', 'ghost', 'data-out="app-speed-finish"') + '</div>' +
          '<p class="bc-item__why">The agent was sent back to fix it and did not get it to pass in 3 tries.</p>' +
          (state.open['app-speed-finish'] ? '<pre class="bc-out">' + esc(SPEED_OUT) + '</pre><span class="bc-out__foot">16 lines · copy</span>' : '') + '</div>' +
          '<div class="bc-fold">11 other checks passed at finish · show</div></section></div>';
      }
    },
    stale: {
      label: 'Moved on since (D7)',
      strip: function () {
        return state.refreshed
          ? strip(status('running', 'Building') + '<span class="bc-progress"><span class="bc-progress__check">T1</span><span>started 14:54 outside this Workbench</span></span>')
          : strip(status('error', 'Did not start'), btn('Start build', 'primary', 'disabled'));
      },
      body: function () {
        if (state.refreshed) {
          return '<div class="bc-page"><p class="bc-note">Read again when the window regained focus. The failure from 14:48 is gone: hoshin now records the build as started at 14:54, with ' + code('app-speed') + ' accepted.</p>' +
            '<div class="bc-task">' + status('running', 'T1') + '<span>Accept a single-repo folder in Add workspace</span><div class="bc-spacer"></div><span class="bc-faint">running in another session</span></div>' +
            '<div class="bc-task">' + status('idle', 'T2') + '<span>Show the system and its apps before adding</span><div class="bc-spacer"></div><span class="bc-faint">waiting on T1</span></div></div>';
        }
        return '<div class="bc-page"><p class="bc-note">This is what the page shows from 14:48. Since then the check was accepted from a terminal and the build started in a Claude Code session.</p>' +
          failedPanel() + '<p class="bc-note">' + btn('Simulate: the window regains focus', 'ghost', 'data-refresh') + '</p></div>';
      },
      enter: function () { state.refreshed = false; }
    },
    running: {
      label: 'First task running',
      strip: function () { return strip(status('running', 'Building') + '<span class="bc-progress"><span class="bc-progress__check">T1</span><span>kata</span></span>', btn('Stop', 'ghost')); },
      body: function () {
        return '<div class="bc-page"><p class="bc-note">The base results were reused' + (Object.keys(state.accepted).length ? ', with ' + Object.keys(state.accepted).map(code).join(', ') + ' accepted for this build' : '') + '. The run pane takes over from here.</p>' +
          '<div class="bc-task">' + status('running', 'T1') + '<span>Accept a single-repo folder in Add workspace</span></div>' +
          '<div class="bc-task">' + status('idle', 'T2') + '<span>Show the system and its apps before adding</span></div></div>';
      }
    },
    activity: {
      label: 'Active changes label (D10, D11)',
      enter: function () { state.listOpen = true; },
      strip: function () { return strip(status('idle', 'Spec · awaiting acceptance')); },
      body: function () {
        var examples = ACTIVITY.map(function (l, i) { return btn(esc(activityLabel(l)), 'ghost', 'data-activity="' + i + '" aria-pressed="' + (i === state.activity) + '"'); }).join(' ');
        return '<div class="bc-page"><p class="bc-note">The top bar lists every change that is working, needs the engineer, or finished unseen. Its label counts each kind by name and never calls the whole list running. The list\'s title is the same text.</p>' +
          '<p class="bc-note">Examples: ' + examples + '</p>' +
          '<p class="bc-note">A run that ends while its change\'s page is open and the window has focus counts as seen: it never shows as finished. With the window out of focus it stays listed until the window regains focus on that page. ' +
          btn('Simulate: the window regains focus on build-checks-workbench', 'ghost', 'data-seen') + '</p></div>';
      }
    },
    'running-finish': {
      label: null,
      strip: function () { return strip(status('running', 'Running the checks again') + '<span class="bc-progress"><span class="bc-progress__check">app-responsive</span><span class="bc-progress__count">1 of 12</span></span>', btn('Stop', 'ghost')); },
      body: function () { return '<div class="bc-page"><p class="bc-note">The checks run again on the change, at finish. The base results are not touched.</p></div>'; }
    }
  };

  /* ---------- Dialogs: confirmations only, never a second copy of a failure ---------- */
  function dialog() {
    var d = state.dialog;
    if (!d) return '';
    var body = '';
    if (d.kind === 'accept') {
      body = '<h2 class="bc-dialog__title">Accept ' + esc(d.id) + ' for this build?</h2>' +
        '<p>' + code(d.id) + ' already fails on the base ' + code(BASE) + ' and does not say what failed. Accepted, it will not block this build at finish while the base stays at ' + code(BASE) + ', so a new failure in it would go through unseen.</p>' +
        '<p>It still runs, and its result is shown. This cannot be undone for this base commit.</p>' +
        '<div class="bc-dialog__foot">' + btn('Cancel', 'ghost', 'data-close') + btn('Accept ' + esc(d.id), 'danger', 'data-confirm-accept="' + d.id + '"') + '</div>';
    } else if (d.kind === 'stop') {
      body = '<h2 class="bc-dialog__title">Stop preparing the build?</h2>' +
        '<p>' + state.at + ' of ' + CHECKS.length + ' checks have run on the base. hoshin keeps none of them until the last one ends, so the next start runs all ' + CHECKS.length + ' again, about ' + Math.round(TOTAL_SECS / 60) + ' minutes.</p>' +
        '<div class="bc-dialog__foot">' + btn('Keep checking', 'ghost', 'data-close') + btn('Stop', 'danger', 'data-go="stopped"') + '</div>';
    } else if (d.kind === 'elsewhere') {
      body = '<h2 class="bc-dialog__title">This build may already be running</h2>' +
        '<p>hoshin recorded the build of ' + code('kata') + ' as started at 14:54, with no finish since, and no run of it is open in this Workbench. Another session may be working in the copy, for example Claude Code started there.</p>' +
        '<p>Two sessions in one copy mix their work in one branch. If that session crashed or was closed, starting here is safe.</p>' +
        '<p class="bc-why">Asked, not blocked: a build that crashed leaves the same record.</p>' +
        '<div class="bc-dialog__foot">' + btn('Cancel', 'ghost', 'data-close') + btn('Start anyway', 'danger', 'data-go="running"') + '</div>';
    }
    return '<div class="bc-scrim"><div class="bc-dialog" role="alertdialog" aria-modal="true">' + body + '</div></div>';
  }

  /* ---------- Live simulation ---------- */
  function startTicking() {
    state.at = 0; state.elapsed = 0;
    stopTicking();
    timer = setInterval(function () {
      if (state.dialog) return;
      var c = CHECKS[state.at];
      state.elapsed += Math.max(8, Math.round(c.secs / 6));
      if (state.elapsed >= c.secs) {
        state.at += 1; state.elapsed = 0;
        if (state.at >= CHECKS.length) { stopTicking(); state.at = CHECKS.length - 1; go('failed'); return; }
      }
      render();
    }, 450);
  }
  function stopTicking() { if (timer) { clearInterval(timer); timer = null; } }

  /* ---------- Render and wiring ---------- */
  function go(name) {
    var prev = SCREENS[state.screen];
    if (prev && prev.leave) prev.leave();
    if (name !== 'checking') stopTicking();
    state.screen = name; state.dialog = null;
    if (SCREENS[name].enter) SCREENS[name].enter();
    render();
  }

  function render() {
    var s = SCREENS[state.screen];
    $('switch').innerHTML = '<span class="bc-eyebrow">Prototype</span>' + Object.keys(SCREENS).filter(function (k) { return SCREENS[k].label; }).map(function (k) {
      return btn(esc(SCREENS[k].label), 'ghost', 'data-screen="' + k + '" aria-pressed="' + (k === state.screen) + '"');
    }).join('') + btn('Reset acceptances', 'ghost', 'data-reset');
    $('toolbar').innerHTML = toolbar();
    $('strip').innerHTML = s.strip();
    $('screen').innerHTML = s.body();
    $('overlay').innerHTML = dialog();
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.screen) return go(t.dataset.screen);
    if (t.dataset.go) return go(t.dataset.go);
    if (t.hasAttribute('data-reset')) { state.accepted = {}; return render(); }
    if (t.hasAttribute('data-stop')) { state.dialog = { kind: 'stop' }; return render(); }
    if (t.hasAttribute('data-elsewhere')) { state.dialog = { kind: 'elsewhere' }; return render(); }
    if (t.hasAttribute('data-close')) { state.dialog = null; return render(); }
    if (t.hasAttribute('data-refresh')) { state.refreshed = true; return render(); }
    if (t.hasAttribute('data-list')) { state.listOpen = !state.listOpen; return render(); }
    if (t.dataset.activity) { state.activity = Number(t.dataset.activity); state.listOpen = true; return render(); }
    if (t.hasAttribute('data-seen')) {
      ACTIVITY[state.activity] = ACTIVITY[state.activity].filter(function (e) { return e.change !== 'build-checks-workbench'; });
      return render();
    }
    if (t.dataset.out) { state.open[t.dataset.out] = !state.open[t.dataset.out]; return render(); }
    if (t.dataset.accept) { state.dialog = { kind: 'accept', id: t.dataset.accept }; return render(); }
    if (t.dataset.confirmAccept) { state.accepted[t.dataset.confirmAccept] = true; state.dialog = null; return render(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.dialog) { state.dialog = null; render(); } });

  go('checking');
})();
