import { choicesOf, customAnswers, emptyModel, toAnswers } from "./ask-form";
import type { Question } from "./events";

const text: Question = { header: "Name", kind: "text", question: "Name?" };
const single: Question = {
  header: "DB",
  kind: "select",
  question: "Which?",
  options: [{ label: "Postgres" }, { label: "SQLite" }],
};
const multi: Question = {
  header: "Infra",
  kind: "select",
  multi_select: true,
  question: "Which?",
  options: [{ label: "Redis" }, { label: "Kafka" }],
};
const confirm: Question = { header: "Go", kind: "confirm", question: "Proceed?" };

describe("ask-form", () => {
  it("emptyModel seeds '' for single-valued and [] for multi keys", () => {
    expect(emptyModel([text, single, multi, confirm])).toEqual({ q0: "", q1: "", q2: [], q3: "" });
  });

  it("choicesOf defaults a confirm to Yes/No and a select to none", () => {
    expect(choicesOf(confirm)).toEqual([{ label: "Yes" }, { label: "No" }]);
    expect(choicesOf({ ...single, options: undefined })).toEqual([]);
    expect(choicesOf(text)).toEqual([]);
  });

  it("toAnswers maps each kind", () => {
    expect(toAnswers([text], { q0: "hello" })).toEqual([["hello"]]);
    expect(toAnswers([text], { q0: "" })).toEqual([[""]]);
    expect(toAnswers([single], { q0: "SQLite" })).toEqual([["SQLite"]]);
    expect(toAnswers([single], { q0: "" })).toEqual([[]]);
    expect(toAnswers([multi], { q0: ["Redis", "Kafka", "Redis"] })).toEqual([["Redis", "Kafka"]]);
    expect(toAnswers([multi], { q0: [] })).toEqual([[]]);
  });

  it("customAnswers keeps only answers outside the listed labels", () => {
    expect(customAnswers(single, ["SQLite", "DuckDB"])).toEqual(["DuckDB"]);
    expect(customAnswers(text, ["anything"])).toEqual([]);
  });
});
