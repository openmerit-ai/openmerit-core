import test from "node:test";
import assert from "node:assert/strict";
import {
  createEval,
  starterCases,
  templates,
  serialize,
  parse,
  score,
  Scorer,
  validateEval,
  mapRows,
  readRows,
  summarize,
  calibrate,
  evalWriterBriefs,
  importResults,
} from "../src/index.ts";
function fixture() {
  const s = createEval();
  s.cases = starterCases(s);
  return s;
}
test("all ten templates validate and round trip with Unicode and fence characters", () => {
  for (const t of templates) {
    const s = createEval(t.id, "Task with ``` fence, café and 日本語");
    assert.deepEqual(parse(serialize(s)), s);
  }
});
test("schema rejects duplicates, dangling references and unknown versions", () => {
  const s = fixture();
  s.cases.push(s.cases[0]);
  assert.equal(validateEval(s).valid, false);
  s.cases.pop();
  s.scorers[0].requirementIds = ["missing"];
  assert.equal(validateEval(s).valid, false);
  assert.throws(() => parse(JSON.stringify({ ...s, schemaVersion: "2" })));
});
test("CSV quoting and JSONL preserve references separately from outputs", () => {
  const rows = readRows('input,expected,output\n"a,b",yes,no\n"line\nnext",x,y', "csv");
  assert.equal(rows[1].input, "line\nnext");
  const [c] = mapRows(rows, { input: "input", expected: "expected", output: "output" }, [
    "quality",
  ]);
  assert.equal(c.expected, "yes");
  assert.equal(c.output, "no");
  assert.throws(() => readRows('a,b\n"x,y', "csv"));
});
test("leakage, synthetic evidence, missing references and calibration are surfaced", () => {
  const s = fixture();
  s.cases.push({ ...s.cases[0], id: "hold", split: "holdout" });
  const codes = validateEval(s).diagnostics.map((d) => d.code);
  assert(codes.includes("SPLIT_LEAKAGE"));
  assert(codes.includes("SYNTHETIC_ONLY"));
  assert(codes.includes("UNCALIBRATED"));
});
test("deterministic scorers distinguish errors from failed criteria", () => {
  const s = Scorer.parse({ id: "s", name: "S", kind: "exact", requirementIds: ["r"] });
  assert.equal(score(s, { b: 2, a: 1 }, { a: 1, b: 2 }).value, 1);
  assert.equal(score(s, "no", "yes").value, 0);
  assert.equal(score(s, "no").status, "error");
  assert.equal(score({ ...s, kind: "judge" }, "x").status, "error");
  assert.equal(score({ ...s, kind: "numeric", config: { tolerance: 0.1 } }, 1.05, 1).value, 1);
});
test("critical failures cannot be hidden by quality scores; errors remain insufficient evidence", () => {
  const s = fixture(),
    c = s.cases[0];
  const obs = [
    {
      caseId: c.id,
      trial: 1,
      scores: [
        { scorerId: "correctness", status: "scored" as const, value: 1, passed: true, reason: "" },
        {
          scorerId: "critical-failure",
          status: "scored" as const,
          value: 0,
          passed: false,
          reason: "",
        },
      ],
    },
  ];
  const summary = summarize(s, obs);
  assert.equal(summary.requirements[0].status, "observed-pass");
  assert.equal(summary.requirements[1].status, "fail");
  obs[0].scores.pop();
  assert.equal(summarize(s, obs).requirements[1].status, "insufficient-evidence");
});
test("calibration counts false positive disagreements", () => {
  const s = fixture();
  s.cases[0].split = "calibration";
  s.cases[0].labels = { correctness: 0 };
  const r = calibrate(s, [
    {
      caseId: s.cases[0].id,
      trial: 1,
      scores: [{ scorerId: "correctness", status: "scored", value: 1, passed: true, reason: "" }],
    },
  ]);
  assert.equal(r[0].fp, 1);
  assert.equal(r[0].agreement, 0);
});
test("eval-writer benchmark covers thirty briefs across all ten families", () => {
  assert.equal(evalWriterBriefs.length, 30);
  assert.deepEqual(
    new Set(evalWriterBriefs.map((brief) => brief.family)),
    new Set(templates.map((template) => template.id)),
  );
  assert.equal(new Set(evalWriterBriefs.map((brief) => brief.id)).size, 30);
  for (const brief of evalWriterBriefs) {
    assert(brief.description.length >= 40);
    assert(brief.mustCover.length >= 3);
  }
});
test("runner result imports enforce immutable eval identity and scorer references", () => {
  const s = fixture(),
    c = s.cases[0];
  const row = {
    evalId: s.id,
    evalVersion: s.version,
    caseId: c.id,
    trial: 1,
    scores: [{ scorerId: "correctness", status: "scored", value: 1, reason: "ok" }],
  };
  assert.equal(importResults(JSON.stringify(row), s)[0].scores[0].passed, true);
  assert.throws(
    () => importResults(JSON.stringify({ ...row, evalVersion: 2 }), s),
    /does not match/,
  );
  assert.throws(
    () => importResults([JSON.stringify(row), JSON.stringify(row)].join("\n"), s),
    /Duplicate/,
  );
});
