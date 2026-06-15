/* Kata — Human-in-the-loop run console (demo).
 * Shows the full HITL flow: the run streams, hits an intercepted
 * AskUserQuestion, PAUSES (awaiting), surfaces the question inline, and
 * resumes + completes based on the operator's answer. Composes the design
 * system primitives (incl. the AskPanel HITL checkpoint). */
function mount() {
  const DS = window.KataDesignSystem_dd74c7;
  const Icon = window.WBIcon;
  const { Button, IconButton, Badge, Tag, StatusDot, EventRow, SummaryStat, AskPanel, Kbd } = DS;

  const spec = {
    name: "triage-flaky-test",
    task: "Triage AuthTests.LoginExpiry. Find the smallest repro and your best guess at the cause.",
    workdir: "D:/Repos/acme-api",
    skills: ["triage-flaky-test"],
    plugins: ["github-tools"],
    model: "claude-sonnet-4-6",
    max_turns: 12,
    isolation: "worktree",
  };

  // ---- the run up to the checkpoint ----
  const preScript = [
    { delay: 250, ev: { type: "log", message: "assembled plugin-dir: 1 skill, 1 plugin" } },
    { delay: 300, ev: { type: "log", message: "worktree: ./.kata/wt-3f9a off main" } },
    { delay: 400, ev: { type: "turn", n: 1 } },
    { delay: 250, ev: { type: "assistant.text", text: "Reproducing the flake in a tight loop to watch the failure mode." } },
    { delay: 650, ev: { type: "tool.use", name: "Bash", input_summary: "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done" } },
    { delay: 1100, ev: { type: "tool.result", name: "Bash", ok: true, summary: "27 passed / 3 failed — failures at iterations 8, 19, 26" } },
    { delay: 450, ev: { type: "turn", n: 2 } },
    { delay: 250, ev: { type: "assistant.text", text: "Isolated it: TokenValidator.IsExpired compares DateTime.UtcNow against an expiry built upstream with DateTime.Now — across the second boundary they disagree and the token reads as expired. Before I go further I need a decision." } },
  ];

  // ---- the AskUserQuestion that Kata intercepts at the edge (three kinds) ----
  const questions = [
    {
      kind: "select",
      header: "Next step",
      question: "I've isolated the cause. How should I proceed from here?",
      options: [
        { label: "Just report", description: "No code changes — isolation only, as the identity prompt instructs." },
        { label: "Write a failing test", description: "Add a deterministic repro test in the worktree." },
        { label: "Attempt a fix", description: "Patch IsExpired in the worktree for review as a diff." },
      ],
    },
    {
      kind: "confirm",
      header: "Open PR",
      question: "Open a draft PR with the result when you're done?",
      options: [{ label: "Yes" }, { label: "No" }],
    },
    {
      kind: "text",
      header: "Note",
      optional: true,
      question: "Anything to add to the run log before I continue?",
      placeholder: "optional note…",
    },
  ];

  // ---- resume + completion, branched on the answer ----
  function resumeScript(answers) {
    const next = answers[0][0]; // single-select Q1
    const pr = (answers[1] && answers[1][0]) === "Yes";
    const note = (answers[2] && answers[2][0]) || "";
    const echo = `next_step="${next}" · open_pr=${pr}` + (note ? ` · note="${note}"` : "");
    const tail = (pr ? " Draft PR opened." : " No PR opened.") + (note ? ` Note: “${note}”.` : "");
    const out = [
      { delay: 200, ev: { type: "tool.result", name: "AskUserQuestion", ok: true, summary: `operator answered → ${echo}` } },
      { delay: 350, ev: { type: "turn", n: 3 } },
    ];
    if (next === "Just report") {
      out.push({ delay: 250, ev: { type: "assistant.text", text: "Understood — reporting only, no code touched. Writing up the findings." } });
      out.push({ delay: 700, ev: { type: "tool.use", name: "Bash", input_summary: "git -C ./.kata/wt-3f9a diff --stat" } });
      out.push({ delay: 600, ev: { type: "tool.result", name: "Bash", ok: false, summary: "no changes — isolation only" } });
      out.push({ delay: 500, ev: { type: "assistant.text", text: "Done. Smallest repro: pin the system clock to 23:59:59.6 local and call LoginExpiry once — fails deterministically." } });
      out.push({ delay: 600, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 3, cost_usd: 0.038, duration_ms: 44200,
        result: `Isolated the flake to a clock-skew race in TokenValidator.IsExpired (mixed Now/UtcNow). Deterministic repro: pin clock to 23:59:59.6 local. No production code changed.` + tail } });
    } else if (next === "Write a failing test") {
      out.push({ delay: 250, ev: { type: "assistant.text", text: "Adding a deterministic repro test that pins the clock to the boundary — no production code changed." } });
      out.push({ delay: 750, ev: { type: "tool.use", name: "Write", input_summary: "tests/Auth/LoginExpiryClockSkewTests.cs" } });
      out.push({ delay: 700, ev: { type: "tool.result", name: "Write", ok: true, summary: "+38 lines · 1 file" } });
      out.push({ delay: 500, ev: { type: "assistant.text", text: "Test fails deterministically against the boundary and passes once the clock source is consistent. Left in the worktree for review." } });
      out.push({ delay: 600, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 4, cost_usd: 0.057, duration_ms: 71400,
        result: `Added LoginExpiryClockSkewTests.cs (+38) in the worktree — a deterministic repro for the Now/UtcNow skew. No production code changed; review the diff.` + tail } });
    } else {
      out.push({ delay: 250, ev: { type: "assistant.text", text: "Patching IsExpired to use a single consistent clock source. Contained in the worktree for review." } });
      out.push({ delay: 750, ev: { type: "tool.use", name: "Edit", input_summary: "src/Auth/TokenValidator.cs — IsExpired uses UtcNow on both sides" } });
      out.push({ delay: 750, ev: { type: "tool.result", name: "Edit", ok: true, summary: "+3 −2 · 1 file" } });
      out.push({ delay: 500, ev: { type: "tool.use", name: "Bash", input_summary: "dotnet test --filter AuthTests.LoginExpiry  # 30x" } });
      out.push({ delay: 800, ev: { type: "tool.result", name: "Bash", ok: true, summary: "30 passed / 0 failed" } });
      out.push({ delay: 500, ev: { type: "assistant.text", text: "Fix holds across 30 iterations. The change is in the worktree as a reviewable diff — not merged." } });
      out.push({ delay: 600, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 5, cost_usd: 0.083, duration_ms: 98600,
        result: `Patched TokenValidator.IsExpired (+3 −2) to use a consistent UtcNow clock; 30/30 passing in the worktree. Diff is contained for review, not merged.` + tail } });
    }
    return out;
  }

  function gutterFor(ev) {
    return ev.type === "assistant.text" ? "assistant"
      : ev.type === "tool.use" ? "tool"
      : ev.type === "tool.result" ? "result"
      : ev.type === "turn" ? `turn ${ev.n}` : "log";
  }
  function variantFor(ev) {
    return ev.type === "assistant.text" ? "assistant"
      : ev.type === "tool.use" ? "tooluse"
      : ev.type === "tool.result" ? (ev.ok ? "result-ok" : "result-err")
      : ev.type === "turn" ? "turn" : "log";
  }
  function bodyFor(ev) {
    return ev.type === "assistant.text" ? ev.text
      : ev.type === "tool.use" ? ev.input_summary
      : ev.type === "tool.result" ? ev.summary
      : ev.type === "log" ? ev.message
      : ev.type === "turn" ? <span style={{ display: "block", borderTop: "1px dashed var(--border-subtle)", marginTop: "6px" }}></span>
      : "";
  }

  function SpecRecap({ state }) {
    return (
      <div className="hitl-recap">
        <div className="wb-section__head" style={{ marginBottom: "14px" }}>
          <span className="wb-section__num">PERFORMING</span>
          <span className="wb-section__title" style={{ fontFamily: "var(--font-mono)" }}>{spec.name}</span>
        </div>
        <div className="hitl-recap__field"><span className="kata-eyebrow">task</span><p>{spec.task}</p></div>
        <div className="hitl-recap__field"><span className="kata-eyebrow">workdir</span><code>{spec.workdir}</code></div>
        <div className="hitl-recap__field"><span className="kata-eyebrow">kit</span>
          <div className="hitl-recap__tags">
            {spec.skills.map((s) => <span key={s} className="hitl-tagrow"><Tag kind="skill" /> <code>{s}</code></span>)}
            {spec.plugins.map((p) => <span key={p} className="hitl-tagrow"><Tag kind="plugin" /> <code>{p}</code></span>)}
          </div>
        </div>
        <div className="hitl-recap__field"><span className="kata-eyebrow">leash</span>
          <div className="hitl-recap__tags">
            <Badge tone="neutral"><Icon name="hash" size={11} /> {spec.max_turns} turns</Badge>
            <Badge tone="warning"><Icon name="git-branch" size={11} /> {spec.isolation}</Badge>
          </div>
        </div>
        <div className="hitl-recap__note">
          <Icon name="terminal" size={13} />
          <span>HITL is a property of the leash: when the agent calls <code>AskUserQuestion</code>, Kata traps it at the edge, pauses, and asks you. The agent just sees a tool result.</span>
        </div>
      </div>
    );
  }

  function App() {
    const [state, setState] = React.useState("idle"); // idle|running|awaiting|success|error
    const [items, setItems] = React.useState([]);     // events + the ask item
    const [summary, setSummary] = React.useState(null);
    const timers = React.useRef([]);
    const streamRef = React.useRef(null);

    React.useEffect(() => {
      const el = streamRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [items, summary]);
    React.useEffect(() => () => timers.current.forEach(clearTimeout), []);

    function play(script, after) {
      let acc = 0;
      script.forEach((step) => {
        acc += step.delay;
        const t = setTimeout(() => {
          if (step.ev.type === "run.completed") { setSummary(step.ev); setState("success"); }
          else setItems((prev) => [...prev, { kind: "ev", ev: step.ev }]);
        }, acc);
        timers.current.push(t);
      });
      if (after) timers.current.push(setTimeout(after, acc));
    }

    function onRun() {
      timers.current.forEach(clearTimeout); timers.current = [];
      setSummary(null); setItems([]); setState("running");
      setItems([{ kind: "ev", ev: { type: "log", message: `run.started · ${spec.name} · ${spec.model} · isolation ${spec.isolation}` } }]);
      play(preScript, () => {
        setItems((prev) => [...prev, { kind: "ask", questions, answered: false, answers: null }]);
        setState("awaiting");
      });
    }

    function onAnswer(answers) {
      setItems((prev) => prev.map((it) => it.kind === "ask" ? { ...it, answered: true, answers } : it));
      setState("running");
      play(resumeScript(answers));
    }

    function onCancel() {
      timers.current.forEach(clearTimeout); timers.current = [];
      setItems((prev) => [...prev, { kind: "ev", ev: { type: "log", message: "run.cancelled — engine killed claude, cleaned up the plugin-dir + worktree" } }]);
      setState("error");
    }

    const statusLabel = { idle: "Idle", running: "Running", awaiting: "Awaiting your input", success: "Completed", error: "Stopped" }[state];

    return (
      <div className="wb">
        <header className="wb-toolbar">
          <div className="wb-brand"><span className="wb-seal">型</span></div>
          <div className="wb-sep"></div>
          <span style={{ font: "var(--weight-semibold) var(--text-md)/1 var(--font-mono)", color: "var(--text-primary)" }}>{spec.name}</span>
          <div className="wb-toolbar__spacer"></div>
          {state === "running" || state === "awaiting"
            ? <Button variant="danger" icon={<Icon name="square" size={14} />} onClick={onCancel}>Cancel</Button>
            : <Button variant="primary" icon={<Icon name="play" size={14} />} onClick={onRun}>{summary ? "Run again" : "Run"}<Kbd>Ctrl ↵</Kbd></Button>}
        </header>

        <div className="wb-panes">
          <div className="wb-pane wb-pane--rail" style={{ width: "360px", minWidth: "360px", background: "var(--surface-chrome)" }}>
            <div className="wb-pane__head"><span className="kata-eyebrow">The form</span></div>
            <div className="wb-pane__body"><SpecRecap state={state} /></div>
          </div>

          <div className="wb-pane wb-pane--observe">
            <div className="wb-status">
              <StatusDot state={state} label={statusLabel} />
              <div className="wb-sep"></div>
              <div className="wb-status__meta"><Icon name="cpu" size={14} /> {spec.model}</div>
              <Badge tone="warning"><Icon name="git-branch" size={11} /> worktree</Badge>
            </div>

            <div className="wb-stream" ref={streamRef}>
              {items.length === 0 && !summary ? (
                <div className="wb-stream__empty">
                  <Icon name="terminal" size={28} />
                  <p>Press <b style={{ color: "var(--accent-text)" }}>Run</b>. The agent will pause partway and ask you a question — answer it to resume.</p>
                </div>
              ) : items.map((it, i) =>
                it.kind === "ask" ? (
                  <div key={i} style={{ padding: "8px 6px 4px" }}>
                    <AskPanel questions={it.questions} answered={it.answered} answers={it.answers} onSubmit={onAnswer} />
                  </div>
                ) : (
                  <div key={i} className="wb-event-enter">
                    <EventRow variant={variantFor(it.ev)} gutter={gutterFor(it.ev)}
                      tool={(it.ev.type === "tool.use" || it.ev.type === "tool.result") ? it.ev.name : null}>
                      {bodyFor(it.ev)}
                    </EventRow>
                  </div>
                )
              )}
            </div>

            {summary && (
              <div className="wb-summary">
                <div className="wb-summary__head">
                  <Badge tone="success"><Icon name="check-circle" size={12} /> run.completed</Badge>
                  <span style={{ font: "var(--font-code-sm)", color: "var(--text-faint)" }}>resumed after 1 checkpoint</span>
                </div>
                <div className="wb-summary__stats">
                  <SummaryStat label="EXIT" value={summary.exit_code} tone="success" />
                  <SummaryStat label="TURNS" value={summary.num_turns} />
                  <SummaryStat label="COST" value={`$${summary.cost_usd.toFixed(3)}`} />
                  <SummaryStat label="DURATION" value={`${(summary.duration_ms / 1000).toFixed(1)}s`} />
                </div>
                <div className="wb-summary__result">{summary.result}</div>
              </div>
            )}
          </div>
        </div>

        <footer className="wb-statusbar">
          <span className={"wb-statusbar__item " + (state === "awaiting" ? "wb-statusbar__err" : "wb-statusbar__ok")}>
            <Icon name={state === "awaiting" ? "alert-triangle" : "check-circle"} />
            {state === "awaiting" ? "paused — waiting on your answer" : "spec is valid"}
          </span>
          <div className="wb-statusbar__spacer"></div>
          <span className="wb-statusbar__item"><Icon name="terminal" /> claude --bare -p</span>
        </footer>
      </div>
    );
  }

  // Ctrl+↵ to run (Windows)
  ReactDOM.createRoot(document.getElementById("root")).render(<App />);
}

window.KataDS && window.KataDS.ready
  ? window.KataDS.ready.then(mount)
  : mount();
