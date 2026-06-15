/* Kata Workbench — seed data: the default run-spec, a discovered catalog
   (shape of `kata catalog`), and a scripted KataEvent stream for the
   triage-flaky-test example — now with a human-in-the-loop checkpoint:
   the run pauses on an intercepted AskUserQuestion and resumes on the
   operator's answer. */
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

  // ---- Pre-checkpoint events: the agent reproduces and isolates the cause,
  //      then needs an operator decision. delay = ms after the previous event.
  const runScript = [
    { delay: 250, ev: { type: "log", level: "info", message: "assembled plugin-dir: 1 skill, 1 plugin" } },
    { delay: 300, ev: { type: "log", level: "info", message: "worktree: ./.kata/wt-3f9a off main" } },
    { delay: 450, ev: { type: "turn", n: 1 } },
    { delay: 250, ev: { type: "assistant.text", text: "Reproducing the flake in a tight loop to watch the failure mode." } },
    { delay: 700, ev: { type: "tool.use", name: "Bash", input_summary: "for i in $(seq 1 30); do dotnet test --filter AuthTests.LoginExpiry; done" } },
    { delay: 1200, ev: { type: "tool.result", name: "Bash", ok: true, summary: "27 passed / 3 failed — failures at iterations 8, 19, 26" } },
    { delay: 450, ev: { type: "turn", n: 2 } },
    { delay: 250, ev: { type: "assistant.text", text: "Failures share a timestamp boundary — a clock-skew race in token expiry." } },
    { delay: 750, ev: { type: "tool.use", name: "Read", input_summary: "src/Auth/TokenValidator.cs" } },
    { delay: 800, ev: { type: "tool.result", name: "Read", ok: true, summary: "TokenValidator.cs — 142 lines" } },
    { delay: 450, ev: { type: "turn", n: 3 } },
    { delay: 250, ev: { type: "assistant.text", text: "Found it: IsExpired compares DateTime.UtcNow against an expiry built upstream with DateTime.Now — across the second boundary they disagree and the token reads as expired. Before I act, how should I proceed?" } },
  ];

  // ---- The intercepted AskUserQuestion (drives the run to `awaiting`).
  const askQuestions = [
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
  ];

  // ---- Resume + completion, branched on the operator's answer.
  function resumeFor(answers) {
    const next = answers[0][0];
    const out = [{ delay: 350, ev: { type: "turn", n: 4 } }];
    if (next === "Just report") {
      out.push({ delay: 250, ev: { type: "assistant.text", text: "Reporting only, no code touched. Writing up the findings." } });
      out.push({ delay: 700, ev: { type: "tool.use", name: "Bash", input_summary: "git -C ./.kata/wt-3f9a diff --stat" } });
      out.push({ delay: 650, ev: { type: "tool.result", name: "Bash", ok: false, summary: "no changes — isolation only" } });
      out.push({ delay: 550, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 4, cost_usd: 0.041, duration_ms: 48120,
        result: "Isolated the flake to a clock-skew race in TokenValidator.IsExpired (mixed Now/UtcNow). Deterministic repro: pin clock to 23:59:59.6 local. No production code changed, per your call." } });
    } else if (next === "Write a failing test") {
      out.push({ delay: 250, ev: { type: "assistant.text", text: "Adding a deterministic repro test that pins the clock to the boundary — no production code changed." } });
      out.push({ delay: 750, ev: { type: "tool.use", name: "Write", input_summary: "tests/Auth/LoginExpiryClockSkewTests.cs" } });
      out.push({ delay: 700, ev: { type: "tool.result", name: "Write", ok: true, summary: "+38 lines · 1 file" } });
      out.push({ delay: 550, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 5, cost_usd: 0.057, duration_ms: 71400,
        result: "Added LoginExpiryClockSkewTests.cs (+38) in the worktree — a deterministic repro for the Now/UtcNow skew. No production code changed; review the diff." } });
    } else {
      out.push({ delay: 250, ev: { type: "assistant.text", text: "Patching IsExpired to use a single consistent clock source. Contained in the worktree for review." } });
      out.push({ delay: 750, ev: { type: "tool.use", name: "Edit", input_summary: "src/Auth/TokenValidator.cs — IsExpired uses UtcNow on both sides" } });
      out.push({ delay: 700, ev: { type: "tool.result", name: "Edit", ok: true, summary: "+3 −2 · 1 file" } });
      out.push({ delay: 500, ev: { type: "tool.use", name: "Bash", input_summary: "dotnet test --filter AuthTests.LoginExpiry  # 30x" } });
      out.push({ delay: 800, ev: { type: "tool.result", name: "Bash", ok: true, summary: "30 passed / 0 failed" } });
      out.push({ delay: 550, ev: { type: "run.completed", exit_code: 0, is_error: false, num_turns: 6, cost_usd: 0.083, duration_ms: 98600,
        result: "Patched TokenValidator.IsExpired (+3 −2) to use a consistent UtcNow clock; 30/30 passing in the worktree. Diff is contained for review, not merged." } });
    }
    return out;
  }

  window.WBData = { defaultSpec, catalog, runScript, askQuestions, resumeFor };
})();
