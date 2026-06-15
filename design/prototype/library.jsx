/* Kata Workbench — Layout C: saved-katas + run-history rail and the
   read-only run-detail view. Composes the design-system primitives. */
const LDS = window.KataDesignSystem_dd74c7;
const { Button, IconButton, Badge, StatusDot, SummaryStat, EventRow, Kbd } = LDS;
const LIcon = window.WBIcon;

function fmtMs(ms) { return (ms / 1000).toFixed(1) + "s"; }

/* ---------- Rail ---------- */
function KataRow({ k, active, onClick }) {
  return (
    <div className={"wb-kata" + (active ? " wb-kata--active" : "")} onClick={onClick}>
      <div className="wb-kata__top">
        <span className="wb-kata__name">{k.name}</span>
        <span className={"wb-kata__dot dot-" + k.lastState}></span>
      </div>
      <div className="wb-kata__desc">{k.description}</div>
      <div className="wb-kata__meta">
        {k.isolation === "worktree" && <span><LIcon name="git-branch" /> worktree</span>}
        <span><LIcon name="package" /> {k.skills + k.plugins} kit</span>
        <span><LIcon name="hash" /> {k.runs} runs</span>
      </div>
    </div>
  );
}

function HistRow({ r, active, onClick }) {
  const tone = r.state === "success" ? "success" : r.state === "warning" ? "warning" : "error";
  return (
    <div className={"wb-hist" + (active ? " wb-hist--active" : "")} onClick={onClick}>
      <span className={"wb-hist__dot dot-" + r.state}></span>
      <div className="wb-hist__body">
        <span className="wb-hist__kata">{r.kata}</span>
        <span className="wb-hist__when">{r.when} · {r.turns} turns · ${r.cost.toFixed(3)}</span>
      </div>
      <Badge tone={tone}>exit {r.exit}</Badge>
    </div>
  );
}

function Rail({ katas, history, selKata, selRun, onKata, onRun }) {
  return (
    <aside className="wb-pane wb-pane--rail">
      <div className="wb-rail__head"><span className="kata-eyebrow">Library</span></div>
      <div className="wb-rail__newbtn">
        <Button variant="primary" block icon={<LIcon name="file-plus" size={14} />}>New kata<Kbd>Ctrl N</Kbd></Button>
      </div>
      <div className="wb-pane__body">
        <div className="wb-rail__section">
          <div className="wb-rail__label">Saved katas<span className="wb-rail__count">{katas.length}</span></div>
          {katas.map((k) => (
            <KataRow key={k.name} k={k} active={selKata === k.name} onClick={() => onKata(k.name)} />
          ))}
        </div>
        <div className="wb-rail__section">
          <div className="wb-rail__label">Recent runs<span className="wb-rail__count">{history.length}</span></div>
          {history.map((r) => (
            <HistRow key={r.id} r={r} active={selRun === r.id} onClick={() => onRun(r.id)} />
          ))}
        </div>
      </div>
    </aside>
  );
}

/* ---------- Run detail ---------- */
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

function RunDetail({ run, stream }) {
  if (!run) {
    return (
      <div className="wb-detail" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="wb-stream__empty">
          <LIcon name="terminal" size={28} />
          <p>Select a saved kata or a run from the rail to review its form and event log.</p>
        </div>
      </div>
    );
  }
  const tone = run.state === "success" ? "success" : run.state === "warning" ? "warning" : "error";
  return (
    <div className="wb-detail">
      <div className="wb-detail__head">
        <div className="wb-detail__title">
          <h2>{run.kata}</h2>
          <span className="wb-detail__id">{run.id}</span>
          <div style={{ marginLeft: "auto" }}><StatusDot state={run.state} label={`exit ${run.exit}`} /></div>
        </div>
        <div className="wb-detail__sub">
          <span><LIcon name="clock" /> {run.when}</span>
          <span><LIcon name="hash" /> {run.turns} turns</span>
          <span><LIcon name="coins" /> ${run.cost.toFixed(3)}</span>
          <span><LIcon name="cpu" /> {fmtMs(run.ms)}</span>
        </div>
        <div className="wb-detail__actions">
          <Button variant="primary" size="sm" icon={<LIcon name="play" size={13} />}>Re-run</Button>
          <Button variant="secondary" size="sm" icon={<LIcon name="folder-open" size={14} />}>Open in compose</Button>
          <Button variant="ghost" size="sm" icon={<LIcon name="package" size={14} />}>Export bundle</Button>
        </div>
      </div>
      <div className="wb-detail__body">
        <div className="wb-detail__stats">
          <SummaryStat label="EXIT" value={run.exit} tone={run.state === "success" ? "success" : run.state === "error" ? "error" : undefined} />
          <SummaryStat label="TURNS" value={run.turns} />
          <SummaryStat label="COST" value={`$${run.cost.toFixed(3)}`} />
          <SummaryStat label="DURATION" value={fmtMs(run.ms)} />
        </div>
        <div className="wb-detail__result">{run.result}</div>
        <div>
          <div className="wb-detail__streamhead" style={{ marginBottom: "10px" }}>Event log · {run.kata}</div>
          {stream ? (
            <div className="wb-detail__stream">
              {stream.map((ev, i) => (
                <EventRow key={i} variant={variantFor(ev)} gutter={gutterFor(ev)}
                  tool={(ev.type === "tool.use" || ev.type === "tool.result") ? ev.name : null}>
                  {ev.type === "assistant.text" ? ev.text
                    : ev.type === "tool.use" ? ev.input_summary
                    : ev.type === "tool.result" ? ev.summary
                    : ev.type === "log" ? ev.message
                    : ev.type === "turn" ? <span style={{ display: "block", borderTop: "1px dashed var(--border-subtle)", marginTop: "6px" }}></span>
                    : ""}
                </EventRow>
              ))}
            </div>
          ) : (
            <div className="wb-detail__result" style={{ color: "var(--text-faint)" }}>Event log for this run has been pruned from local history.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Library screen ---------- */
function Library() {
  const { savedKatas, history, streams } = window.WBLibrary;
  const [selRun, setSelRun] = React.useState(history[0].id);
  const [selKata, setSelKata] = React.useState(history[0].kata);

  const run = history.find((r) => r.id === selRun) || null;

  function onRun(id) {
    setSelRun(id);
    const r = history.find((x) => x.id === id);
    if (r) setSelKata(r.kata);
  }
  function onKata(name) {
    setSelKata(name);
    const latest = history.find((r) => r.kata === name);
    setSelRun(latest ? latest.id : null);
  }

  return (
    <div className="wb">
      <header className="wb-toolbar">
        <div className="wb-brand"><span className="wb-seal">型</span></div>
        <div className="wb-sep"></div>
        <span style={{ font: "var(--weight-semibold) var(--text-md)/1 var(--font-sans)", color: "var(--text-primary)" }}>Library</span>
        <div className="wb-toolbar__spacer"></div>
        <div className="wb-toolbar__group">
          <IconButton icon={<LIcon name="search" />} aria-label="Search" />
          <IconButton icon={<LIcon name="folder-open" />} aria-label="Open" />
        </div>
        <div className="wb-sep"></div>
        <Button variant="secondary" icon={<LIcon name="play" size={14} />}>Open Workbench</Button>
      </header>
      <div className="wb-panes">
        <Rail katas={savedKatas} history={history} selKata={selKata} selRun={selRun} onKata={onKata} onRun={onRun} />
        <RunDetail run={run} stream={run ? streams[run.id] : null} />
      </div>
      <footer className="wb-statusbar">
        <span className="wb-statusbar__item wb-statusbar__ok"><LIcon name="check-circle" /> {savedKatas.length} saved katas · {history.length} runs in local history</span>
        <div className="wb-statusbar__spacer"></div>
        <span className="wb-statusbar__item"><LIcon name="folder" /> ~/.kata/history</span>
      </footer>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Library />);
