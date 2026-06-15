/* Kata Workbench — panes & chrome (presentational). Reads primitives from
   the design-system bundle and the WBIcon set. Exposed on window. */
const DS = window.KataDesignSystem_dd74c7;
const { Button, IconButton, TextInput, Textarea, Select, SegmentedControl, Checkbox, Field, Badge, StatusDot, Kbd, KitItem, EventRow, SummaryStat, Card, AskPanel } = DS;
const Icon = window.WBIcon;

/* ---------------- Toolbar ---------------- */
function Toolbar({ spec, setName, dirty, running, onRun, onCancel }) {
  return (
    <header className="wb-toolbar">
      <div className="wb-brand">
        <span className="wb-seal">型</span>
      </div>
      <div className="wb-sep"></div>
      <div className="wb-spec">
        <input className="wb-specname" value={spec.name} placeholder="spec name"
          onChange={(e) => setName(e.target.value)} aria-label="Spec name" />
        <span className={"wb-dirty" + (dirty ? " wb-dirty--on" : "")}>
          {dirty ? <><span className="wb-dirty__dot"></span>unsaved</> : "saved"}
        </span>
      </div>
      <div className="wb-toolbar__spacer"></div>
      <div className="wb-toolbar__group">
        <IconButton icon={<Icon name="file-plus" />} aria-label="New spec" title="New" />
        <IconButton icon={<Icon name="folder-open" />} aria-label="Open spec" title="Open" />
        <IconButton icon={<Icon name="save" />} aria-label="Save spec" title="Save (Ctrl+S)" />
        <IconButton icon={<Icon name="package" />} aria-label="Export bundle" title="Export bundle" />
      </div>
      <div className="wb-sep"></div>
      {running
        ? <Button variant="danger" icon={<Icon name="square" size={14} />} onClick={onCancel}>Cancel</Button>
        : <Button variant="primary" icon={<Icon name="play" size={14} />} onClick={onRun}>Run<Kbd>Ctrl ↵</Kbd></Button>}
    </header>
  );
}

/* ---------------- Compose pane ---------------- */
function Section({ num, title, sub, children }) {
  return (
    <section className="wb-section">
      <div className="wb-section__head">
        {num && <span className="wb-section__num">{num}</span>}
        <span className="wb-section__title">{title}</span>
        {sub && <span className="wb-section__sub">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

function ComposePane({ spec, set, catalog, query, setQuery }) {
  const skills = catalog.filter((e) => e.kind === "skill" && match(e, query));
  const plugins = catalog.filter((e) => e.kind === "plugin" && match(e, query));
  return (
    <div className="wb-compose">
      <Field label="Description" specKey="description">
        <TextInput value={spec.description} onChange={(e) => set("description", e.target.value)}
          placeholder="One line — what this form is for" />
      </Field>

      <Section title="Task" sub="the job, verbatim">
        <Field label="Task" specKey="task">
          <Textarea rows={3} value={spec.task} onChange={(e) => set("task", e.target.value)} />
        </Field>
        <Field label="Context" specKey="context" hint="Appended after the task.">
          <Textarea rows={2} value={spec.context} onChange={(e) => set("context", e.target.value)} />
        </Field>
        <Field label="Workdir" specKey="workdir" hint="cwd for claude -p; the agent's file tools resolve here.">
          <div className="wb-picker">
            <TextInput mono value={spec.workdir} onChange={(e) => set("workdir", e.target.value)} />
            <Button variant="secondary" icon={<Icon name="folder" />}>Browse…</Button>
          </div>
        </Field>
      </Section>

      <Section num="02 · TELL IT WHAT IT IS" title="Identity">
        <Field label="System prompt" specKey="identity.system_prompt" hint="Empty = stay the default coding assistant.">
          <Textarea rows={2} value={spec.identity.system_prompt} onChange={(e) => set("identity.system_prompt", e.target.value)} />
        </Field>
        <Field label="Mode" specKey="identity.mode">
          <SegmentedControl options={["append", "replace"]} value={spec.identity.mode}
            onChange={(v) => set("identity.mode", v)} />
        </Field>
      </Section>

      <Section num="03 · THE CURATED KIT" title="Kit" sub={`${spec.skills.length + Object.keys(spec.plugins).length} selected`}>
        <div className="wb-kit">
          <div className="wb-kit__search">
            <Icon name="search" />
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search kit…" />
          </div>
          <div>
            <div className="wb-kit__group">Skills</div>
            {skills.map((e) => (
              <KitItem key={e.name} kind="skill" name={e.name} description={e.description}
                selected={spec.skills.includes(e.name)} onToggle={() => set.toggleSkill(e.name)} />
            ))}
          </div>
          <div>
            <div className="wb-kit__group">Plugins</div>
            {plugins.map((e) => {
              const sel = !!spec.plugins[e.name];
              return (
                <KitItem key={e.name} kind="plugin" name={e.name} description={e.description}
                  selected={sel} onToggle={() => set.togglePlugin(e.name)}
                  detail={
                    <>
                      {e.provides.length > 0 && (
                        <div className="k-kit__provides"><b>provides:</b> {e.provides.join(", ")}</div>
                      )}
                      {e.mcp_servers.length > 0 && (
                        <>
                          <Checkbox label={`start MCP servers (${e.mcp_servers.join(", ")})`}
                            checked={spec.plugins[e.name]?.mcp ?? true}
                            onChange={(ev) => set.pluginMcp(e.name, ev.target.checked)} />
                          <Field label="env passthrough" specKey="env" hint="Names only — never values. Forwarded from the runtime env.">
                            <TextInput mono value={(spec.plugins[e.name]?.env ?? []).join(", ")}
                              onChange={(ev) => set.pluginEnv(e.name, ev.target.value)} placeholder="GITHUB_TOKEN, GH_HOST" />
                          </Field>
                        </>
                      )}
                    </>
                  } />
              );
            })}
          </div>
        </div>
      </Section>

      <Section title="Model">
        <Field label="Model id" specKey="model.id" hint="Omit to use Claude's default.">
          <Select value={spec.model.id} onChange={(e) => set("model.id", e.target.value)}
            options={[{ value: "", label: "(default)" }, { value: "claude-sonnet-4-6" }, { value: "claude-opus-4-1" }, { value: "claude-haiku-4-5" }]} />
        </Field>
      </Section>

      <Section num="04 · THE LEASH" title="Leash" sub="cap · contain · observe">
        <div className="wb-grid-2">
          <Field label="Max turns" specKey="max_turns" hint="Engine cap → exit 125.">
            <TextInput type="number" min="1" value={spec.leash.max_turns}
              onChange={(e) => set("leash.max_turns", Number(e.target.value) || 1)} />
          </Field>
          <Field label="Timeout (secs)" specKey="timeout_secs" hint="Wall-clock kill → exit 124.">
            <TextInput type="number" min="0" value={spec.leash.timeout_secs ?? ""}
              placeholder="(none)"
              onChange={(e) => set("leash.timeout_secs", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Isolation" specKey="leash.isolation" hint="worktree contains writes in an ephemeral git worktree (reviewable as a diff).">
          <SegmentedControl options={["none", "worktree"]} value={spec.leash.isolation}
            onChange={(v) => set("leash.isolation", v)} />
        </Field>
      </Section>
    </div>
  );
}

function match(e, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return e.name.toLowerCase().includes(s) || e.description.toLowerCase().includes(s);
}

/* ---------------- Observe pane ---------------- */
function gutterFor(ev) {
  switch (ev.type) {
    case "assistant.text": return "assistant";
    case "tool.use": return "tool";
    case "tool.result": return "result";
    case "turn": return `turn ${ev.n}`;
    case "log": return "log";
    default: return "";
  }
}
function variantFor(ev) {
  switch (ev.type) {
    case "assistant.text": return "assistant";
    case "tool.use": return "tooluse";
    case "tool.result": return ev.ok ? "result-ok" : "result-err";
    case "turn": return "turn";
    default: return "log";
  }
}

function StreamRow({ ev }) {
  const body =
    ev.type === "assistant.text" ? ev.text
      : ev.type === "tool.use" ? ev.input_summary
      : ev.type === "tool.result" ? ev.summary
      : ev.type === "log" ? ev.message
      : ev.type === "turn" ? <span style={{ display: "block", borderTop: "1px dashed var(--border-subtle)", marginTop: "6px" }}></span>
      : "";
  const tool = (ev.type === "tool.use" || ev.type === "tool.result") ? ev.name : null;
  return (
    <div className="wb-event-enter">
      <EventRow variant={variantFor(ev)} gutter={gutterFor(ev)} tool={tool}>{body}</EventRow>
    </div>
  );
}

function ObservePane({ state, items, spec, summary, onAnswer }) {
  const streamRef = React.useRef(null);
  React.useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, summary]);

  const statusLabel = {
    idle: "Idle", running: "Running", awaiting: "Awaiting your input", success: "Completed", error: "Error", warning: "Stopped",
  }[state];

  return (
    <>
      <div className="wb-status">
        <StatusDot state={state} label={statusLabel} />
        <div className="wb-sep"></div>
        <div className="wb-status__meta">
          <Icon name="cpu" size={14} /> {spec.model.id || "default"}
        </div>
        {spec.leash.isolation === "worktree" && <Badge tone="warning"><Icon name="git-branch" size={11} /> worktree</Badge>}
      </div>

      <div className="wb-stream" ref={streamRef}>
        {items.length === 0 && !summary ? (
          <div className="wb-stream__empty">
            <Icon name="terminal" size={28} />
            <p>Press <b style={{ color: "var(--accent-text)" }}>Run</b> to drive <code>claude -p</code> to completion. The agent may pause to ask you a question — answer it to resume.</p>
          </div>
        ) : (
          items.map((it, i) =>
            it.kind === "ask" ? (
              <div key={i} style={{ padding: "8px 6px 4px" }}>
                <AskPanel questions={it.questions} answered={it.answered} answers={it.answers} onSubmit={onAnswer} />
              </div>
            ) : (
              <StreamRow key={i} ev={it.ev} />
            )
          )
        )}
      </div>

      {summary && (
        <div className="wb-summary">
          <div className="wb-summary__head">
            {summary.is_error
              ? <Badge tone="error"><Icon name="x-circle" size={12} /> run.completed</Badge>
              : <Badge tone="success"><Icon name="check-circle" size={12} /> run.completed</Badge>}
            <span style={{ font: "var(--font-code-sm)", color: "var(--text-faint)" }}>the form performed</span>
          </div>
          <div className="wb-summary__stats">
            <SummaryStat label="EXIT" value={summary.exit_code} tone={summary.is_error ? "error" : "success"} />
            <SummaryStat label="TURNS" value={summary.num_turns} />
            <SummaryStat label="COST" value={summary.cost_usd != null ? `$${summary.cost_usd.toFixed(3)}` : "—"} />
            <SummaryStat label="DURATION" value={`${(summary.duration_ms / 1000).toFixed(1)}s`} />
          </div>
          {summary.result && <div className="wb-summary__result">{summary.result}</div>}
        </div>
      )}
    </>
  );
}

/* ---------------- Status bar ---------------- */
function StatusBar({ spec, errors }) {
  return (
    <footer className="wb-statusbar">
      <span className={"wb-statusbar__item " + (errors.length ? "wb-statusbar__err" : "wb-statusbar__ok")}>
        <Icon name={errors.length ? "alert-triangle" : "check-circle"} />
        {errors.length ? `${errors.length} ${errors.length === 1 ? "error" : "errors"}: ${errors[0]}` : "spec is valid"}
      </span>
      <div className="wb-statusbar__spacer"></div>
      <span className="wb-statusbar__item"><Icon name="hash" /> schema {spec.schema}</span>
      <span className="wb-statusbar__item"><Icon name="folder" /> {spec.workdir || "—"}</span>
      <span className="wb-statusbar__item"><Icon name="terminal" /> claude --bare -p</span>
    </footer>
  );
}

Object.assign(window, { WBToolbar: Toolbar, WBComposePane: ComposePane, WBObservePane: ObservePane, WBStatusBar: StatusBar });
