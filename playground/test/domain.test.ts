import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_FIXTURES } from "../fixtures/claims.ts";
import { SEED } from "../fixtures/seed.ts";
import { type Accumulators, computeRemittance, type LineDecision, requiredDenials } from "../src/domain/adjudicate.ts";
import { parseClaimSubmission, toClaimSubmissionXml } from "../src/domain/eclaim.ts";

const header = { senderId: "FICT-DHA-F-0001", receiverId: "FICT-PAYER-SAHRA", transactionDate: "2026-10-30T08:00:00+04:00", dispositionFlag: "TEST" };

/** What the ledger would report for a member, from the seeded paid claims only. */
function seededAccumulators(memberId: string): Accumulators {
  const accumulators: Accumulators = { annualUsed: 0, drugsUsed: 0, physiotherapySessions: 0, consultationDates: [] };
  for (const paid of SEED.paidClaims.filter((item) => item.claim.memberId === memberId)) {
    for (const line of paid.lines) {
      const counted = line.paymentAmount + line.patientShare;
      accumulators.annualUsed += counted;
      if (line.benefit === "drugs") accumulators.drugsUsed += counted;
      if (line.benefit === "consultation") accumulators.consultationDates.push(paid.claim.activities.find((item) => item.id === line.activityId)?.start ?? "");
    }
  }
  return accumulators;
}

function context(fixture: (typeof CLAIM_FIXTURES)[number]) {
  return {
    claim: fixture.claim,
    member: SEED.members.find((member) => member.id === fixture.claim.memberId),
    clinicians: SEED.clinicians,
    accumulators: seededAccumulators(fixture.claim.memberId ?? ""),
  };
}

function expectedDecisions(fixture: (typeof CLAIM_FIXTURES)[number]): LineDecision[] {
  return Object.entries(fixture.expected.lines).map(([activityId, outcome]) =>
    outcome === "pay" ? { activityId, decision: "pay", reason: "expected" } : { activityId, decision: "deny", denialCode: outcome[0], reason: "expected" },
  );
}

test("every fixture claim survives a Claim.Submission round trip", () => {
  for (const fixture of CLAIM_FIXTURES) {
    const { claims, header: parsed } = parseClaimSubmission(toClaimSubmissionXml(fixture.claim, header));
    assert.equal(parsed.recordCount, 1);
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(claims[0]), plain(fixture.claim), fixture.name);
  }
});

test("the parser reads DHPO dates and amounts and rejects a wrong RecordCount", () => {
  const xml = toClaimSubmissionXml(CLAIM_FIXTURES[0]!.claim, header);
  assert.match(xml, /<Start>26\/10\/2026 09:30<\/Start>/);
  assert.match(xml, /<Net>255\.00<\/Net>/);
  assert.throws(() => parseClaimSubmission(xml.replace("<RecordCount>1</RecordCount>", "<RecordCount>2</RecordCount>")), /RecordCount 2/);
  assert.throws(() => parseClaimSubmission(xml.replace("<Net>255.00</Net>", "<Net>255.005</Net>")), /Invalid amount/);
});

test("the expected decisions produce each fixture's expected payment and patient share", () => {
  for (const fixture of CLAIM_FIXTURES) {
    const remittance = computeRemittance({ ...context(fixture), decisions: expectedDecisions(fixture) });
    assert.deepEqual(remittance.violations, [], fixture.name);
    assert.equal(remittance.totals.payment, fixture.expected.payment, `${fixture.name} payment`);
    assert.equal(remittance.totals.patientShare, fixture.expected.patientShare, `${fixture.name} patient share`);
  }
});

test("hard rules refuse paying ineligible, deleted-code and waiting-period lines", () => {
  for (const name of ["member-not-yet-covered", "deleted-diagnosis-code", "pre-existing-waiting-period"]) {
    const fixture = CLAIM_FIXTURES.find((item) => item.name === name)!;
    const payAll = fixture.claim.activities.map((item): LineDecision => ({ activityId: item.id, decision: "pay", reason: "wrong" }));
    const remittance = computeRemittance({ ...context(fixture), decisions: payAll });
    assert.ok(remittance.violations.length > 0, name);
    assert.deepEqual(remittance.lines, [], name);
    for (const [activityId, outcome] of Object.entries(fixture.expected.lines)) {
      assert.ok(outcome !== "pay" && requiredDenials(context(fixture), activityId).some((code) => outcome.includes(code)), `${name} ${activityId}`);
    }
  }
});

test("hard rules do not force denials on lines that should be paid", () => {
  for (const fixture of CLAIM_FIXTURES) {
    for (const [activityId, outcome] of Object.entries(fixture.expected.lines)) {
      if (outcome === "pay") assert.deepEqual(requiredDenials(context(fixture), activityId), [], `${fixture.name} ${activityId}`);
    }
  }
});

test("the follow-up waiver applies within seven days but not after", () => {
  const fixture = CLAIM_FIXTURES.find((item) => item.name === "follow-up-within-seven-days")!;
  const decisions = expectedDecisions(fixture);
  const lateVisit = "2026-10-28T11:00:00+04:00";
  const late = { ...fixture.claim, activities: fixture.claim.activities.map((item) => ({ ...item, start: lateVisit })) };
  assert.equal(computeRemittance({ ...context(fixture), decisions }).totals.patientShare, 0);
  assert.equal(computeRemittance({ ...context(fixture), claim: late, decisions }).totals.patientShare, 24_00);
});

test("a denial needs a known denial code", () => {
  const fixture = CLAIM_FIXTURES[0]!;
  const decisions: LineDecision[] = [
    { activityId: "A1", decision: "deny", denialCode: "MADE-UP", reason: "x" },
    { activityId: "A2", decision: "pay", reason: "x" },
  ];
  const remittance = computeRemittance({ ...context(fixture), decisions });
  assert.ok(remittance.violations.some((item) => item.includes("A1") && item.includes("denial code")));
  assert.ok(remittance.violations.some((item) => item.includes("A3") && item.includes("no decision")));
});
