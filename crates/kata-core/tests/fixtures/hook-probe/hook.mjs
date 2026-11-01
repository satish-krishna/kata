// Test fixture for the hook-probe plugin. Reads a hook event on stdin, appends
// "<event> <tool> <command>" to the file named by HOOK_PROBE_LOG, and refuses any
// Bash command containing `git push` (exit 2, reason on stderr), the way the ai-sdlc
// build skill's guard refuses a push.
import { appendFileSync, readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const event = input.hook_event_name ?? "";
const tool = input.tool_name ?? "";
const command = input.tool_input?.command ?? "";
const log = process.env.HOOK_PROBE_LOG;
if (log) {
  appendFileSync(log, `${event} ${tool} ${command}\n`);
}
if (event === "PreToolUse" && tool === "Bash" && command.includes("git push")) {
  process.stderr.write("refused by the probe guard: git push is not allowed\n");
  process.exit(2);
}
