import type { Question, QuestionOption } from "./events";

/** Signal Forms model for an ask: one field per question, keyed by `fieldKey`. */
export type AskModel = Record<string, string | string[]>;

const YES_NO: QuestionOption[] = [{ label: "Yes" }, { label: "No" }];

export function fieldKey(i: number): string {
  return `q${i}`;
}

export function isMulti(q: Question): boolean {
  return q.kind === "select" && !!q.multi_select;
}

export function choicesOf(q: Question): QuestionOption[] {
  if (q.kind === "confirm") return q.options ?? YES_NO;
  if (q.kind === "select") return q.options ?? [];
  return [];
}

export function hasFreeText(q: Question): boolean {
  return q.kind === "select" || q.kind === "text";
}

export function emptyModel(questions: Question[]): AskModel {
  const model: AskModel = {};
  questions.forEach((q, i) => {
    model[fieldKey(i)] = isMulti(q) ? [] : "";
  });
  return model;
}

export function toAnswers(questions: Question[], model: AskModel): string[][] {
  return questions.map((q, i) => {
    const v = model[fieldKey(i)];
    if (q.kind === "text") return [typeof v === "string" ? v : ""];
    if (Array.isArray(v)) return [...new Set(v)];
    return v ? [v] : [];
  });
}

/** Answers to a question that are not among its listed labels (free text). */
export function customAnswers(q: Question, answer: string[]): string[] {
  if (q.kind === "text") return [];
  const labels = new Set(choicesOf(q).map((o) => o.label));
  return answer.filter((a) => !labels.has(a));
}
