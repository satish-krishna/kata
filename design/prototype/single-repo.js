/* Single-repo workbench prototype. Plain JS, no modules, no network: opens from disk.
   Every screen is a function in SCREENS; the switcher at the top reaches each one. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var m = function (s) { return '<code class="k-mono">' + esc(s) + '</code>'; };
  var status = function (tone, text) { return '<span class="k-status k-status--' + tone + '"><span class="k-status__dot"></span>' + esc(text) + '</span>'; };
  var btn = function (label, kind, attrs) { return '<button class="k-btn k-btn--' + (kind || 'secondary') + ' k-btn--sm" type="button" ' + (attrs || '') + '>' + esc(label) + '</button>'; };
  var eyebrow = function (t) { return '<h2 class="kata-eyebrow">' + esc(t) + '</h2>'; };
  var CHANGE = '2026-11-12-single-repo-workbench';

  /* ---------- Toolbar ---------- */
  function toolbar(opts) {
    var back = opts.back ? btn('Back to ' + opts.back, 'ghost', 'data-go="' + opts.backTo + '"') : '';
    return '<div class="wb-brand"><div class="wb-seal">型</div><span class="kata-eyebrow">AI-SDLC</span></div>' +
      '<div class="wb-sep"></div>' +
      '<button class="k-btn k-btn--ghost k-btn--sm" type="button" id="ws-trigger" aria-haspopup="menu">' + esc(opts.workspace || 'kata') + ' &#9662;</button>' +
      back +
      '<div class="wb-toolbar__spacer"></div>' + (opts.right || '');
  }

  function workspaceMenu() {
    return '<div class="sr-menu" role="menu">' +
      '<div class="kata-eyebrow" style="padding:var(--space-3)">Workspaces</div>' +
      '<button class="sr-menu__item" type="button" data-pick="multi"><span class="k-mono">workspaces</span><span class="sr-faint">3 repos</span><span class="sr-menu__folder">D:/workspaces</span></button>' +
      '<button class="sr-menu__item" type="button" data-pick="single"><span class="k-mono">kata</span><span class="sr-mark">single-repo</span><span class="sr-menu__folder">D:/workspaces/kata</span></button>' +
      '<div style="border-top:1px solid var(--border-subtle);margin:var(--space-2) 0"></div>' +
      '<button class="sr-menu__item" type="button">Add workspace…</button>' +
      '<button class="sr-menu__item" type="button">Remove from list…</button>' +
      '</div>';
  }

  /* ---------- Home ---------- */
  var changeRows = [
    [CHANGE, 'building', 'warning', 'engine, workbench'],
    ['2026-11-05-faster-diffs', 'in review', 'success', 'workbench']
  ];

  function changesPane() {
    return '<section class="sr-col"><div class="wb-pane__head" style="padding:0">' + eyebrow('Changes') + '</div>' +
      '<table class="sr-table"><thead><tr><th>Change</th><th>Stage</th><th>Apps</th></tr></thead><tbody>' +
      changeRows.map(function (r) {
        return '<tr><td class="k-mono"><a href="#" data-go="change-copy">' + esc(r[0]) + '</a></td><td>' + status(r[2], r[1]) + '</td><td class="k-mono">' + esc(r[3]) + '</td></tr>';
      }).join('') + '</tbody></table></section>';
  }

  function appsPane() {
    return '<section class="sr-col"><div class="wb-pane__head" style="padding:0">' + eyebrow('Apps') + '<span class="sr-note">system ' + m('kata') + '</span></div>' +
      '<div class="k-card k-card--pad sr-row"><span>Instructions</span>' + status('success', 'current') + '<span class="sr-note">CLAUDE.md names the system and its context files</span>' + btn('Refresh', 'secondary') + '</div>' +
      '<table class="sr-table"><thead><tr><th>App</th><th>Context</th><th></th></tr></thead><tbody>' +
      '<tr><td class="k-mono">engine</td><td>' + status('warning', 'out of date') + '</td><td class="sr-end">' + btn('View context', 'ghost') + '</td></tr>' +
      '<tr><td class="k-mono">workbench</td><td>' + status('error', 'missing') + '</td><td class="sr-end">' + btn('Build context', 'secondary') + '</td></tr>' +
      '</tbody></table>' +
      '<p class="sr-note">No master row: this repository is its own master.</p>' +
      '<div class="sr-row">' + btn('Add system') + btn('Set team naming') + '</div></section>';
  }

  function homeSingle(menuOpen) {
    return {
      bar: toolbar({ workspace: 'kata', right: '<span class="sr-mark">single-repo</span>' + btn('New change', 'primary') }),
      body: '<div class="sr-cols">' + changesPane() + appsPane() + '</div>',
      menu: menuOpen
    };
  }

  var SCREENS = {
    'home-switcher': function () { return homeSingle(true); },
    'home-single': function () { return homeSingle(false); },
    'home-refusal': function () {
      return {
        bar: toolbar({ workspace: 'kata', right: '<span class="sr-mark">single-repo</span>' + btn('New change', 'primary', 'disabled') }),
        body: '<div class="sr-page" style="margin:var(--space-12) auto;align-items:flex-start"><section class="k-card k-card--pad" style="display:flex;flex-direction:column;gap:var(--space-4)">' +
          '<h1 style="margin:0;font:var(--font-title)">The single-repo layout needs ai-sdlc 1.4.0 or later</h1>' +
          '<p style="margin:0;font-size:var(--text-sm)">The single-repo layout needs ai-sdlc 1.4.0 or later; this machine has 1.3.1.</p>' +
          '<p class="sr-note">Nothing else in this folder works until the plugin is updated. There is no action on this screen.</p></section></div>'
      };
    },

    /* ---------- Change page ---------- */
    'change-copy': function () {
      return {
        bar: toolbar({ workspace: 'kata', back: 'changes', backTo: 'home-single', right: '<span class="sr-mark">single-repo</span>' }),
        body: '<div class="sr-page">' +
          '<div class="sr-row"><h1 style="margin:0;font:var(--font-title)" class="k-mono">' + CHANGE + '</h1>' + status('warning', 'building') + '</div>' +
          '<div class="k-seg"><button class="k-seg__opt" type="button">Intent</button><button class="k-seg__opt" type="button">Spec</button><button class="k-seg__opt" type="button">Plan</button><button class="k-seg__opt k-seg__opt--active" type="button" data-go="build-lanes">Build</button></div>' +
          '<section class="k-card k-card--pad" aria-label="This change\'s copy" style="display:flex;flex-direction:column;gap:var(--space-3)">' +
          '<div class="sr-row"><span class="kata-eyebrow">Copy</span><span class="k-mono">D:/workspaces/kata/.ai-sdlc/copies/' + CHANGE + '</span>' +
          '<span class="sr-note">on ' + m('change/' + CHANGE) + '</span>' + btn('Open folder') + btn('Remove this copy') + '</div>' +
          '<p class="sr-note">This branch is held by this change\'s own copy, so your own checkout cannot switch to it while the copy exists. The copy holds the one repository: the apps ' + m('engine') + ' and ' + m('workbench') + ' are folders inside it.</p>' +
          '</section></div>'
      };
    }
  };

  /* ---------- Build page ---------- */
  function lane(app, o) {
    return '<section class="k-card k-card--pad sr-lane' + (o.one ? ' sr-lane--one' : '') + '" aria-label="Lane ' + esc(app) + '">' +
      '<div class="sr-row"><span class="k-mono" style="font-weight:var(--weight-semibold)">' + esc(app) + '</span>' + o.status + '<span style="flex:1"></span>' + (o.action || '') + '</div>' +
      (o.note ? '<p class="sr-note">' + o.note + '</p>' : '') +
      o.tasks.map(function (t) {
        return '<div class="sr-task"><div class="sr-row"><span class="k-mono">' + esc(t[0]) + '</span><span>' + esc(t[1]) + '</span><span style="flex:1"></span>' + t[2] + '</div>' + (t[3] ? '<p class="sr-note">' + t[3] + '</p>' : '') + '</div>';
      }).join('') + '</section>';
  }

  function buildPage(inner, o) {
    var tab = (o && o.tab) || 'lanes';
    var tabs = [['lanes', 'Lanes', 'build-lanes'], ['findings', 'Findings', 'build-findings'], ['checks', 'Checks', 'build-checks'], ['changes', 'Changes', 'build-changes']];
    return {
      bar: toolbar({ workspace: 'kata', back: 'change', backTo: 'change-copy', right: '<span class="sr-mark">single-repo</span>' + btn('Start a round', 'primary', 'data-go="build-round"') }),
      body: '<div class="sr-page"><div class="sr-row"><h1 class="k-mono" style="margin:0;font:var(--font-title)">' + CHANGE + '</h1>' + status('warning', 'building') + '</div>' +
        '<div class="k-seg">' + tabs.map(function (t) { return '<button class="k-seg__opt' + (t[0] === tab ? ' k-seg__opt--active' : '') + '" type="button" data-go="' + t[2] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
        inner + '</div>'
    };
  }

  function waitingText(stopped) {
    return 'waiting for ' + m('engine') + ' of this change' + (stopped ? ', which stopped; continue it first' : '');
  }

  var done = function (id, title) { return [id, title, status('success', 'done')]; };

  function lanesView(wbState, taskWait) {
    var engine, wb;
    if (taskWait) {
      engine = lane('engine', { status: status('warning', 'working'), tasks: [done('T1', 'Parse the app layout'), ['T4', 'Expose the app order', status('warning', 'working')]] });
      wb = lane('workbench', { status: status('warning', 'working'), tasks: [
        ['T5', 'Build the app rows', status('warning', 'working')],
        ['T6', 'Show the app lanes', status('idle', 'waiting'), 'waiting for ' + m('engine') + ' task ' + m('T4') + ' (the app order the lanes read)']
      ] });
    } else if (wbState === 'waiting') {
      engine = lane('engine', { status: status('warning', 'working'), tasks: [done('T1', 'Parse the app layout'), ['T3', 'Order the apps', status('warning', 'working')]] });
      wb = lane('workbench', { status: status('idle', 'waiting'), note: 'workbench is ' + waitingText(false) + '.', tasks: [['T5', 'Build the app rows', status('idle', 'not started')]] });
    } else if (wbState === 'stopped') {
      engine = lane('engine', { status: status('error', 'stopped'), note: 'Its run ran out of time.', action: btn('Continue engine', 'primary'), tasks: [done('T1', 'Parse the app layout'), ['T3', 'Order the apps', status('error', 'stopped')]] });
      wb = lane('workbench', { status: status('idle', 'waiting'), note: 'workbench is ' + waitingText(true) + '.', tasks: [['T5', 'Build the app rows', status('idle', 'not started')]] });
    } else {
      engine = lane('engine', { status: status('success', 'finished'), note: 'Team checks passed.', tasks: [done('T1', 'Parse the app layout'), done('T3', 'Order the apps')] });
      wb = lane('workbench', { status: status('warning', 'working'), tasks: [['T5', 'Build the app rows', status('warning', 'working')]] });
    }
    return buildPage('<div class="sr-lanes">' + engine + wb + '</div>' +
      '<p class="sr-note">One lane per app, in the order the plan gives them. Today\'s build page shows one lane per repository.</p>');
  }

  function findingsView() {
    function f(sev, tone, text) { return '<tr><td>' + status(tone, sev) + '</td><td>' + text + '</td></tr>'; }
    return buildPage(
      '<div class="sr-group"><div class="sr-group__head">engine</div><table class="sr-table"><tbody>' +
      f('blocking', 'error', 'App order ignores a cycle: ' + m('crates/engine/src/order.rs')) +
      f('minor', 'warning', 'The name ' + m('apps') + ' reads unclear in the error text') + '</tbody></table></div>' +
      '<div class="sr-group"><div class="sr-group__head">workbench</div><table class="sr-table"><tbody>' +
      f('minor', 'warning', 'Lane header wraps at 1024 px: ' + m('app/src/app/sdlc/build/build-page.html')) + '</tbody></table></div>' +
      '<div class="sr-group"><div class="sr-group__head">across apps</div><table class="sr-table"><tbody>' +
      f('minor', 'warning', 'Event name differs between ' + m('engine') + ' and ' + m('workbench')) + '</tbody></table></div>',
      { tab: 'findings' });
  }

  function checksView() {
    return buildPage(
      '<div class="sr-group"><div class="sr-group__head">engine</div><table class="sr-table"><tbody>' +
      '<tr><td class="k-mono">cargo fmt --all --check</td><td>' + status('success', 'passed') + '</td></tr>' +
      '<tr><td class="k-mono">cargo clippy --all-targets</td><td>' + status('success', 'passed') + '</td></tr></tbody></table></div>' +
      '<div class="sr-group"><div class="sr-group__head">workbench</div><table class="sr-table"><tbody>' +
      '<tr><td class="k-mono">npm run lint</td><td>' + status('idle', 'No changes to check') + '</td></tr></tbody></table>' +
      '<p class="sr-note">A check whose app has no changed files reads "No changes to check" and does not run.</p></div>',
      { tab: 'checks' });
  }

  function fileList(files) {
    return files.map(function (f) { return '<div class="k-mono" style="padding:var(--space-2) var(--space-3)">' + esc(f[0]) + ' <span class="sr-faint">' + esc(f[1]) + '</span></div>'; }).join('');
  }

  function changesView() {
    function g(name, files) { return '<div class="sr-group"><div class="sr-group__head">' + esc(name) + '</div>' + fileList(files) + '</div>'; }
    return buildPage(
      '<div class="sr-row"><div class="k-seg"><button class="k-seg__opt k-seg__opt--active" type="button">This change</button><button class="k-seg__opt" type="button">Last task</button></div><span class="sr-note">Files grouped by app, then the repository root.</span></div>' +
      '<div class="sr-cols" style="grid-template-columns:360px 1fr;border:1px solid var(--border-subtle);border-radius:var(--radius-sm)"><div class="sr-col" style="padding:var(--space-3)">' +
      g('engine', [['crates/engine/src/order.rs', '+42 -3'], ['crates/engine/src/lib.rs', '+2 -0']]) +
      g('workbench', [['app/src/app/sdlc/build/build-page.html', '+61 -17'], ['app/src/app/ui/apps-table.html', '+38 -0']]) +
      g('repository root', [['CLAUDE.md', '+4 -1'], ['.ai-sdlc.json', '+6 -2']]) +
      '</div><div class="sr-col"><pre class="sr-diff">@@ build-page.html\n- &lt;section class="k-lane" aria-label="Lane repo"&gt;\n+ &lt;section class="k-lane" aria-label="Lane app"&gt;</pre></div></div>',
      { tab: 'changes' });
  }

  function rootAppView() {
    return buildPage(
      '<p class="sr-note">System ' + m('tools') + ' has one app, ' + m('cli') + ', and it sits at the repository root.</p>' +
      '<div class="sr-lanes">' + lane('cli', { one: true, status: status('warning', 'working'), note: 'App folder: ' + m('/') + ' (the repository root).', tasks: [['T1', 'Add the flag', status('warning', 'working')]] }) + '</div>' +
      '<div class="sr-group" style="max-width:520px"><div class="sr-group__head">Changes: cli</div>' + fileList([['src/main.rs', '+12 -2'], ['README.md', '+3 -0']]) +
      '<p class="sr-note">One lane and one group: the app and the repository root are the same folder, so root files are not listed twice.</p></div>', { tab: 'lanes' });
  }

  function roundDialog() {
    return '<div class="sr-dialog-scrim"><div class="sr-dialog" role="dialog" aria-label="Start a round">' +
      '<h2 style="margin:0;font:var(--font-title)">Start a round</h2>' +
      '<p class="sr-note">Pick the apps to build. A round builds the picked apps one after another, in the order the plan gives them.</p>' +
      '<label class="sr-row"><input type="checkbox" checked> <span class="k-mono">engine</span> <span class="sr-note">2 tasks left</span></label>' +
      '<label class="sr-row"><input type="checkbox" checked> <span class="k-mono">workbench</span> <span class="sr-note">3 tasks left</span></label>' +
      '<div class="k-card k-card--inset k-card--pad"><span class="kata-eyebrow">Queue order</span><p style="margin:var(--space-2) 0 0" class="k-mono">engine first, then workbench</p></div>' +
      '<div class="sr-row" style="justify-content:flex-end">' + btn('Cancel', 'ghost', 'data-go="build-lanes"') + btn('Start round', 'primary', 'data-go="build-lanes"') + '</div></div></div>';
  }

  function doneView() {
    return {
      bar: toolbar({ workspace: 'kata', back: 'changes', backTo: 'home-single', right: '<span class="sr-mark">single-repo</span>' }),
      body: '<div class="sr-page"><div class="sr-row"><h1 class="k-mono" style="margin:0;font:var(--font-title)">' + CHANGE + '</h1>' + status('success', 'ready to declare done') + '</div>' +
        '<section class="k-card k-card--pad" style="display:flex;flex-direction:column;gap:var(--space-4)" aria-label="Declare done">' +
        eyebrow('Declare done') +
        '<p style="margin:0">Declaring done pushes ' + m('change/' + CHANGE) + ' and opens <strong>one pull request</strong>.</p>' +
        '<table class="sr-table"><thead><tr><th>Pull request</th><th>Apps touched</th></tr></thead><tbody>' +
        '<tr><td class="k-mono">kata <span class="sr-faint">(one repository)</span></td><td class="k-mono">engine</td></tr></tbody></table>' +
        '<p class="sr-note">Planned but not touched: ' + m('workbench') + '.</p>' +
        '<div class="sr-row">' + btn('Declare done', 'primary') + btn('Cancel', 'ghost') + '</div></section></div>'
    };
  }

  SCREENS['build-lanes'] = function () { return lanesView('waiting'); };
  SCREENS['build-stopped'] = function () { return lanesView('stopped'); };
  SCREENS['build-working'] = function () { return lanesView('working'); };
  SCREENS['build-taskwait'] = function () { return lanesView('working', true); };
  SCREENS['build-findings'] = findingsView;
  SCREENS['build-checks'] = checksView;
  SCREENS['build-round'] = function () { var r = lanesView('waiting'); r.overlay = roundDialog(); return r; };
  SCREENS['build-changes'] = changesView;
  SCREENS['build-rootapp'] = rootAppView;
  SCREENS['done'] = doneView;

  var GROUPS = [
    ['Home', [['home-switcher', 'Folder switcher'], ['home-single', 'Single-repo home'], ['home-refusal', 'Version refusal']]],
    ['Change page', [['change-copy', 'Copy panel']]],
    ['Build page', [
      ['build-lanes', 'Lanes: workbench waiting'], ['build-stopped', 'Lanes: engine stopped'], ['build-working', 'Lanes: workbench working'],
      ['build-taskwait', 'Task waiting on engine task'], ['build-findings', 'Findings per app'], ['build-checks', 'Checks per app'],
      ['build-round', 'Round dialog'], ['build-changes', 'Changes view'], ['build-rootapp', 'App at repository root']]],
    ['Done panel', [['done', 'Done panel']]]
  ];

  /* ---------- Shell ---------- */
  var current = 'home-single';

  function renderSwitch() {
    $('switch').innerHTML = GROUPS.map(function (g) {
      return '<div class="sr-switch__group"><span class="sr-switch__label">' + g[0] + '</span><div class="k-seg">' +
        g[1].map(function (s) { return '<button type="button" class="k-seg__opt' + (s[0] === current ? ' k-seg__opt--active' : '') + '" data-go="' + s[0] + '">' + esc(s[1]) + '</button>'; }).join('') + '</div></div>';
    }).join('');
  }

  function show(id) {
    if (!SCREENS[id]) { return; }
    current = id;
    var s = SCREENS[id]();
    $('toolbar').innerHTML = s.bar;
    $('screen').innerHTML = s.body + (s.menu ? workspaceMenu() : '');
    $('overlay').innerHTML = s.overlay || '';
    renderSwitch();
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go],[data-pick],#ws-trigger');
    if (!t) { return; }
    e.preventDefault();
    if (t.dataset.go) { show(t.dataset.go); }
    else if (t.dataset.pick) { show(t.dataset.pick === 'single' ? 'home-single' : 'home-switcher'); }
    else if (t.id === 'ws-trigger') { show('home-switcher'); }
  });

  show(current);
})();
