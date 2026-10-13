/* Pairs tool.use with tool.result by `id`, nests a subagent's events under its
 * call by `parent_id`, and picks how each call renders. Pure: the Observe pane
 * and the run history both derive their rows from this. */

import { diffLines } from "diff";
import type { StreamEvent } from "./events";
import type { AskRecord, PermissionRecord } from "./run.svelte";

export type ToolUseEv = Extract<StreamEvent, { type: "tool.use" }>;
export type ToolResultEv = Extract<StreamEvent, { type: "tool.result" }>;

export type ToolCall = {
  id: string;
  use: ToolUseEv;
  /** `null` until the result arrives (or forever, if the run was cut short). */
  result: ToolResultEv | null;
  /** 0 at the top level, 1 inside a subagent. Never deeper. */
  depth: 0 | 1;
  children: StreamItem[];
};

/** `at` is the raw index of the event that opened the item. */
export type StreamItem =
  | { kind: "event"; key: string; at: number; ev: StreamEvent }
  | { kind: "call"; key: string; at: number; call: ToolCall };

export type PausedItem =
  | StreamItem
  | { kind: "perm"; key: string; p: PermissionRecord }
  | { kind: "ask"; key: string; a: AskRecord };

type Slot = { list: StreamItem[]; depth: 0 | 1 };

export function pairToolEvents(events: StreamEvent[]): StreamItem[] {
  const top: StreamItem[] = [];
  const calls = new Map<string, ToolCall>();
  // Where each call's own events go. A top-level call collects them in its
  // children; a nested call hands them to the list it already lives in, which
  // flattens a subagent's subagent to one level.
  const slots = new Map<string, Slot>();
  const slotFor = (parentId?: string | null): Slot =>
    (parentId ? slots.get(parentId) : undefined) ?? { list: top, depth: 0 };

  events.forEach((ev, i) => {
    if (ev.type === "tool.use" && ev.id) {
      const slot = slotFor(ev.parent_id);
      const call: ToolCall = { id: ev.id, use: ev, result: null, depth: slot.depth, children: [] };
      calls.set(ev.id, call);
      slots.set(ev.id, slot.depth === 0 ? { list: call.children, depth: 1 } : slot);
      slot.list.push({ kind: "call", key: `c:${ev.id}`, at: i, call });
      return;
    }
    if (ev.type === "tool.result" && ev.id) {
      const call = calls.get(ev.id);
      if (call) {
        call.result = ev;
        return;
      }
    }
    const parentId =
      ev.type === "tool.use" || ev.type === "tool.result" || ev.type === "assistant.text"
        ? ev.parent_id
        : undefined;
    slotFor(parentId).list.push({ kind: "event", key: `e:${i}`, at: i, ev });
  });
  return top;
}

/** Splice pause records back where they happened. A record's `at` counts the
 *  raw events before it, so it goes after the last top-level item that opened
 *  before that point: a pause between a call and its result lands right after
 *  that call's row. Permissions precede asks at the same slot so the order is
 *  deterministic (a run is only ever paused on one thing at a time). */
export function withPauses(
  items: StreamItem[],
  permissions: PermissionRecord[],
  asks: AskRecord[],
): PausedItem[] {
  const slotOf = (at: number) => items.filter((it) => it.at < at).length;
  const pauses: PausedItem[][] = Array.from({ length: items.length + 1 }, () => []);
  for (const p of permissions) pauses[slotOf(p.at)].push({ kind: "perm", key: `p:${p.id}`, p });
  for (const a of asks) pauses[slotOf(a.at)].push({ kind: "ask", key: `a:${a.id}`, a });
  const out: PausedItem[] = [...pauses[0]];
  items.forEach((it, k) => out.push(it, ...pauses[k + 1]));
  return out;
}

export type Renderer = "edit" | "multiedit" | "write" | "read" | "search" | "todo" | "agent" | "generic";

export function rendererFor(call: ToolCall): Renderer {
  const name = call.use.name;
  // A subagent nests its children whether or not payloads were captured.
  if (name === "Agent" || name === "Task") return "agent";
  // No payload (a run without --full-payloads) or a cut one: never draw a diff
  // or a checklist from it.
  if (call.use.truncated || call.use.input == null) return "generic";
  switch (name) {
    case "Edit": return "edit";
    case "MultiEdit": return "multiedit";
    case "Write": return "write";
    case "Read": return "read";
    case "Grep":
    case "Glob": return "search";
    case "TodoWrite": return "todo";
    default: return "generic";
  }
}

export type CallStatus = "ok" | "error" | "running";

export function statusOf(call: ToolCall): CallStatus {
  if (call.result === null) return "running";
  return call.result.ok ? "ok" : "error";
}

/** The label beside every status dot: color is never shown alone. */
export const STATUS_TEXT: Record<CallStatus, string> = { ok: "ok", error: "error", running: "running…" };

const OPEN_BY_DEFAULT = new Set<Renderer>(["edit", "multiedit", "write", "todo"]);

export function defaultOpen(call: ToolCall): boolean {
  return statusOf(call) === "error" || OPEN_BY_DEFAULT.has(rendererFor(call));
}

export function inputOf(call: ToolCall): Record<string, unknown> {
  const v = call.use.input;
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export type Todo = { content: string; status: string };

export function todosOf(call: ToolCall): Todo[] {
  const todos = inputOf(call).todos;
  if (!Array.isArray(todos)) return [];
  return todos.map((t) => ({ content: str(t?.content), status: str(t?.status) }));
}

const lineCount = (s: string): number => (s === "" ? 0 : s.replace(/\n$/, "").split("\n").length);

export function editStats(oldText: string, newText: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const part of diffLines(oldText, newText)) {
    const n = part.count ?? lineCount(part.value);
    if (part.added) add += n;
    else if (part.removed) del += n;
  }
  return { add, del };
}

export function targetFor(call: ToolCall): string {
  const inp = inputOf(call);
  switch (rendererFor(call)) {
    case "edit":
    case "multiedit":
    case "write":
    case "read": return str(inp.file_path);
    case "search": return str(inp.pattern);
    case "todo": return "";
    case "agent":
      return inp.subagent_type
        ? `${str(inp.subagent_type)}: ${str(inp.description)}`
        : call.use.input_summary;
    case "generic": return call.use.input_summary;
  }
}

export type Meta = { add?: number; del?: number; text?: string };

const countCalls = (items: StreamItem[]): number => items.filter((i) => i.kind === "call").length;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function metaFor(call: ToolCall): Meta {
  const inp = inputOf(call);
  const output = call.result?.output;
  switch (rendererFor(call)) {
    case "edit": return editStats(str(inp.old_string), str(inp.new_string));
    case "multiedit": {
      const edits = Array.isArray(inp.edits) ? inp.edits : [];
      return edits.reduce<{ add: number; del: number }>((acc, e) => {
        const s = editStats(str(e?.old_string), str(e?.new_string));
        return { add: acc.add + s.add, del: acc.del + s.del };
      }, { add: 0, del: 0 });
    }
    case "write": return { add: lineCount(str(inp.content)) };
    case "read": return output != null ? { text: plural(lineCount(output), "line") } : {};
    case "search":
      return output != null
        ? { text: plural(output.split("\n").filter((l) => l.trim() !== "").length, "match", "matches") }
        : {};
    case "todo": {
      const todos = todosOf(call);
      return { text: `${todos.filter((t) => t.status === "completed").length} / ${todos.length}` };
    }
    case "agent": return { text: plural(countCalls(call.children), "call") };
    case "generic": return {};
  }
}
