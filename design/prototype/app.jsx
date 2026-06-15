/* Kata Workbench — application shell: spec state, validation (mirrors
   kata-core::spec::validate), and a simulated `kata run` that streams the
   scripted KataEvent protocol into the observe pane — including a
   human-in-the-loop checkpoint, where the run pauses on an intercepted
   AskUserQuestion and resumes on the operator's answer. */
const { WBToolbar, WBComposePane, WBObservePane, WBStatusBar } = window;

function setPath(obj, path, value) {
  const keys = path.split(".");
  const next = structuredClone(obj);
  let cur = next;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = value;
  return next;
}

function validate(spec) {
  const errs = [];
  if (spec.schema !== 1) errs.push(`unsupported schema version ${spec.schema} (expected 1)`);
  if (!spec.name || !spec.name.trim()) errs.push("name is required");
  if (!spec.task || !spec.task.trim()) errs.push("task is required");
  if (!spec.workdir || !spec.workdir.trim()) errs.push("workdir is required");
  if (!spec.leash.max_turns || spec.leash.max_turns < 1) errs.push("leash.max_turns must be >= 1");
  return errs;
}

function App() {
  const { defaultSpec, catalog, runScript, askQuestions, resumeFor } = window.WBData;
  const savedJson = React.useRef(JSON.stringify(defaultSpec));
  const [spec, setSpec] = React.useState(() => structuredClone(defaultSpec));
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState("idle");
  const [items, setItems] = React.useState([]); // { kind:'ev', ev } | { kind:'ask', questions, answered, answers }
  const [summary, setSummary] = React.useState(null);
  const timers = React.useRef([]);

  const dirty = JSON.stringify(spec) !== savedJson.current;
  const errors = validate(spec);

  const set = React.useMemo(() => {
    const fn = (path, value) => setSpec((prev) => setPath(prev, path, value));
    fn.toggleSkill = (name) =>
      setSpec((prev) => ({
        ...prev,
        skills: prev.skills.includes(name) ? prev.skills.filter((s) => s !== name) : [...prev.skills, name],
      }));
    fn.togglePlugin = (name) =>
      setSpec((prev) => {
        const plugins = { ...prev.plugins };
        if (plugins[name]) delete plugins[name];
        else plugins[name] = {};
        return { ...prev, plugins };
      });
    fn.pluginMcp = (name, val) =>
      setSpec((prev) => ({ ...prev, plugins: { ...prev.plugins, [name]: { ...prev.plugins[name], mcp: val } } }));
    fn.pluginEnv = (name, str) =>
      setSpec((prev) => ({
        ...prev,
        plugins: { ...prev.plugins, [name]: { ...prev.plugins[name], env: str.split(",").map((s) => s.trim()).filter(Boolean) } },
      }));
    return fn;
  }, []);

  function clearTimers() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }

  // Schedule a list of { delay, ev } steps; ev.type "run.completed" ends the run.
  function play(script, onDone) {
    let acc = 0;
    script.forEach((step) => {
      acc += step.delay;
      const t = setTimeout(() => {
        if (step.ev.type === "run.completed") {
          setSummary(step.ev);
          setState(step.ev.is_error ? "error" : "success");
        } else {
          setItems((prev) => [...prev, { kind: "ev", ev: step.ev }]);
        }
      }, acc);
      timers.current.push(t);
    });
    if (onDone) timers.current.push(setTimeout(onDone, acc));
  }

  function onRun() {
    if (errors.length) return;
    clearTimers();
    setSummary(null);
    setState("running");
    setItems([{ kind: "ev", ev: { type: "log", level: "info", message: `run.started · ${spec.name} · ${spec.model.id || "default"} · isolation ${spec.leash.isolation}` } }]);
    // Stream up to the checkpoint, then pause on the intercepted AskUserQuestion.
    play(runScript, () => {
      setItems((prev) => [...prev, { kind: "ask", questions: askQuestions, answered: false, answers: null }]);
      setState("awaiting");
    });
  }

  function onAnswer(answers) {
    // Record the answer (the run-spec's leash turned a tool call into a checkpoint),
    // feed it back as the tool result, and resume.
    setItems((prev) => prev.map((it) => (it.kind === "ask" ? { ...it, answered: true, answers } : it)));
    setState("running");
    const echo = answers.map((a) => a.join(", ")).join(" · ");
    setItems((prev) => [...prev, { kind: "ev", ev: { type: "tool.result", name: "AskUserQuestion", ok: true, summary: `operator answered → ${echo}` } }]);
    play(resumeFor(answers));
  }

  function onCancel() {
    clearTimers();
    setItems((prev) => [...prev, { kind: "ev", ev: { type: "log", level: "warn", message: "run.cancelled — engine trapped the signal, killed claude, cleaned up the plugin-dir + worktree" } }]);
    setState("warning");
  }

  React.useEffect(() => () => clearTimers(), []);

  // Ctrl+↵ to run (Windows)
  React.useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (state !== "running" && state !== "awaiting") onRun(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const busy = state === "running" || state === "awaiting";

  return (
    <div className="wb">
      <WBToolbar spec={spec} setName={(v) => set("name", v)} dirty={dirty}
        running={busy} onRun={onRun} onCancel={onCancel} />
      {errors.length > 0 && (
        <div className="wb-banner wb-banner--error">
          {window.WBIcon({ name: "alert-triangle", size: 15 })}
          <div className="wb-banner__list">{errors.map((e, i) => <span key={i}>{e}</span>)}</div>
        </div>
      )}
      <div className="wb-panes">
        <div className="wb-pane wb-pane--compose">
          <div className="wb-pane__head"><span className="kata-eyebrow">Compose · the run-spec</span></div>
          <div className="wb-pane__body">
            <WBComposePane spec={spec} set={set} catalog={catalog} query={query} setQuery={setQuery} />
          </div>
        </div>
        <div className="wb-pane wb-pane--observe">
          <div className="wb-pane__head"><span className="kata-eyebrow">Observe · the run</span></div>
          <WBObservePane state={state} items={items} spec={spec} summary={summary} onAnswer={onAnswer} />
        </div>
      </div>
      <WBStatusBar spec={spec} errors={errors} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
