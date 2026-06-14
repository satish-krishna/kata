/* Kata Workbench — application shell: spec state, validation (mirrors
   kata-core::spec::validate), and a simulated `kata run` that streams the
   scripted KataEvent protocol into the observe pane. */
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
  const { defaultSpec, catalog, runScript } = window.WBData;
  const savedJson = React.useRef(JSON.stringify(defaultSpec));
  const [spec, setSpec] = React.useState(() => structuredClone(defaultSpec));
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState("idle");
  const [events, setEvents] = React.useState([]);
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

  function onRun() {
    if (errors.length) return;
    clearTimers();
    setEvents([]);
    setSummary(null);
    setState("running");
    setEvents([{ type: "log", level: "info", message: `run.started · ${spec.name} · ${spec.model.id || "default"} · isolation ${spec.leash.isolation}` }]);
    let acc = 0;
    runScript.forEach((step) => {
      acc += step.delay;
      const t = setTimeout(() => {
        if (step.ev.type === "run.completed") {
          setSummary(step.ev);
          setState(step.ev.is_error ? "error" : "success");
        } else {
          setEvents((prev) => [...prev, step.ev]);
        }
      }, acc);
      timers.current.push(t);
    });
  }

  function onCancel() {
    clearTimers();
    setEvents((prev) => [...prev, { type: "log", level: "warn", message: "run.cancelled — engine trapped the signal, killed claude, cleaned up the plugin-dir + worktree" }]);
    setState("warning");
  }

  React.useEffect(() => () => clearTimers(), []);

  // ⌘↵ / Ctrl+↵ to run
  React.useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (state !== "running") onRun(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div className="wb">
      <WBToolbar spec={spec} setName={(v) => set("name", v)} dirty={dirty}
        running={state === "running"} onRun={onRun} onCancel={onCancel} />
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
          <WBObservePane state={state} events={events} spec={spec} summary={summary} />
        </div>
      </div>
      <WBStatusBar spec={spec} errors={errors} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
