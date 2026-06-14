/* Kata Workbench — seed data: the default run-spec, a discovered catalog
   (shape of `kata catalog`), and a scripted KataEvent stream for the
   triage-flaky-test example from the design spec. */
(function () {
  const defaultSpec = {
    schema: 1,
    name: "triage-flaky-test",
    description: "Reproduce and isolate AuthTests.LoginExpiry",
    task: "Triage the flaky test AuthTests.LoginExpiry. Find the smallest reproduction and your best guess at the cause.",
    context: ".NET 8 xUnit suite. CI flakes ~1 in 30 runs. Don't fix it, just isolate.",
    workdir: "D:/Repos/acme-api",
    identity: {
      system_prompt: "You reproduce, isolate, and report. You do not change production code.",
      mode: "append",
    },
    skills: ["triage-flaky-test"],
    plugins: { "github-tools": { mcp: true, env: ["GITHUB_TOKEN", "GH_HOST"] } },
    model: { id: "claude-sonnet-4-6" },
    leash: { max_turns: 12, timeout_secs: 900, isolation: "worktree" },
  };

  // Shape of `kata catalog` output.
  const catalog = [
    { kind: "skill", name: "triage-flaky-test", description: "reproduce & isolate a flaky test", provides: [], mcp_servers: [] },
    { kind: "skill", name: "doc-writer", description: "write & update project docs", provides: [], mcp_servers: [] },
    { kind: "skill", name: "perf-profiler", description: "profile a hot path & report", provides: [], mcp_servers: [] },
    { kind: "plugin", name: "github-tools", description: "PRs, issues, releases", provides: ["skill:pr-review", "skill:issue-triage"], mcp_servers: ["github"] },
    { kind: "plugin", name: "sentry", description: "read issues & stack traces", provides: ["skill:error-triage"], mcp_servers: ["sentry"] },
  ];

  // Scripted normalized KataEvent stream (right pane). delay = ms after prev.
  const runScript = [
    { delay: 250, ev: { type: "log", level: "info", message: "assembled plugin-dir: 1 skill, 1 plugin" } },
    { delay: 350, ev: { type: "log", level: "info", message: "worktree: ./.kata/wt-3f9a off main" } },
    { delay: 500, ev: { type: "turn", n: 1 } },
    { delay: 250, ev: { type: "assistant.text", text: "Reproducing the flake: I'll run the single test in a tight loop and watch for the failure mode." } },
    { delay: 700, ev: { type: "tool.use", name: "Bash", input_summary: "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done" } },
    { delay: 1300, ev: { type: "tool.result", name: "Bash", ok: true, summary: "27 passed / 3 failed — failures at iterations 8, 19, 26" } },
    { delay: 500, ev: { type: "turn", n: 2 } },
    { delay: 250, ev: { type: "assistant.text", text: "It fails ~1 in 10 locally. The failures share a timestamp boundary — this smells like a clock-skew race in token expiry." } },
    { delay: 800, ev: { type: "tool.use", name: "Read", input_summary: "src/Auth/TokenValidator.cs" } },
    { delay: 850, ev: { type: "tool.result", name: "Read", ok: true, summary: "TokenValidator.cs — 142 lines" } },
    { delay: 500, ev: { type: "turn", n: 3 } },
    { delay: 250, ev: { type: "assistant.text", text: "Found it. `IsExpired` compares `DateTime.UtcNow` against an expiry built with `DateTime.Now` upstream — across the DST/second boundary the two clocks disagree and the token reads as expired." } },
    { delay: 800, ev: { type: "tool.use", name: "Bash", input_summary: "git -C ./.kata/wt-3f9a diff --stat" } },
    { delay: 700, ev: { type: "tool.result", name: "Bash", ok: false, summary: "no changes — isolation only, as instructed" } },
    { delay: 500, ev: { type: "turn", n: 4 } },
    { delay: 250, ev: { type: "assistant.text", text: "Smallest repro: pin the system clock to 23:59:59.6 local and call LoginExpiry once — fails deterministically. Cause: mixed Now/UtcNow in token expiry. I did not change production code." } },
    {
      delay: 600,
      ev: {
        type: "run.completed",
        exit_code: 0,
        is_error: false,
        num_turns: 4,
        cost_usd: 0.041,
        duration_ms: 48120,
        result: "Isolated AuthTests.LoginExpiry flake to a clock-skew race: TokenValidator.IsExpired mixes DateTime.Now (expiry) with DateTime.UtcNow (check). Deterministic repro: pin clock to 23:59:59.6 local. No production code changed.",
      },
    },
  ];

  window.WBData = { defaultSpec, catalog, runScript };
})();
