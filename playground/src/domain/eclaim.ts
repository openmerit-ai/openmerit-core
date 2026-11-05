// Reads and writes the subset of eClaimLink's `Claim.Submission` (DHPO ClaimSubmission.xsd,
// https://www.eclaimlink.ae/dhd/claim_submission.html) that outpatient claims use.
// DHPO dates are dd/mm/yyyy HH:mm in Dubai time; this module converts them to ISO 8601 with +04:00.

import type { Activity, ActivityType, Diagnosis, DiagnosisType, Fils, SubmissionHeader, SubmittedClaim } from "./types.ts";

interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
}

const ACTIVITY_TYPES: readonly ActivityType[] = [3, 4, 5, 6, 8, 9, 10];
const DIAGNOSIS_TYPES: readonly DiagnosisType[] = ["Principal", "Secondary", "Admitting"];

export class ClaimXmlError extends Error {}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encode(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Parses element-only XML (no attributes are read), which is all DHPO transactions use. */
function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#root", children: [], text: "" };
  const stack: XmlElement[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g;
  let last = 0;
  for (const match of xml.matchAll(tag)) {
    const top = stack[stack.length - 1];
    if (!top) throw new ClaimXmlError("Unbalanced XML");
    top.text += decode(xml.slice(last, match.index));
    last = match.index + match[0].length;
    const [, closing, name, selfClosing] = match;
    if (!name) continue; // declaration or comment
    if (closing) {
      if (top.name !== name) throw new ClaimXmlError(`Expected </${top.name}>, found </${name}>`);
      stack.pop();
      continue;
    }
    const element: XmlElement = { name, children: [], text: "" };
    top.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new ClaimXmlError(`Unclosed <${stack[stack.length - 1]?.name}>`);
  return root;
}

function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((candidate) => candidate.name === name);
}

function required(element: XmlElement, name: string): string {
  const value = child(element, name)?.text.trim();
  if (!value) throw new ClaimXmlError(`${element.name} is missing required ${name}`);
  return value;
}

function optional(element: XmlElement, name: string): string | undefined {
  return child(element, name)?.text.trim() || undefined;
}

/** "160.00" → 16000 fils. Rejects more than two decimal places. */
export function parseAmount(value: string): Fils {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new ClaimXmlError(`Invalid amount "${value}"`);
  const [, sign, whole = "0", fraction = ""] = match;
  const fils = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -fils : fils;
}

export function formatAmount(fils: Fils): string {
  const sign = fils < 0 ? "-" : "";
  const absolute = Math.abs(fils);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/** "07/04/2026 09:30" → "2026-04-07T09:30:00+04:00". A date without time is 00:00, as DHPO specifies. */
export function parseDhpoDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!match) throw new ClaimXmlError(`Invalid DHPO date "${value}"`);
  const [, day, month, year, hour = "00", minute = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:00+04:00`;
}

export function formatDhpoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!match) throw new ClaimXmlError(`Invalid ISO date "${iso}"`);
  const [, year, month, day, hour, minute] = match;
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

function parseActivity(element: XmlElement): Activity {
  const type = Number(required(element, "Type"));
  if (!ACTIVITY_TYPES.includes(type as ActivityType)) throw new ClaimXmlError(`Unknown ActivityType ${type}`);
  const quantity = Number(required(element, "Quantity"));
  if (!Number.isFinite(quantity) || quantity <= 0) throw new ClaimXmlError(`Invalid Quantity on activity ${required(element, "ID")}`);
  return {
    id: required(element, "ID"),
    start: parseDhpoDate(required(element, "Start")),
    type: type as ActivityType,
    code: required(element, "Code"),
    quantity,
    net: parseAmount(required(element, "Net")),
    clinician: required(element, "Clinician"),
    priorAuthorizationId: optional(element, "PriorAuthorizationID"),
    observations: element.children
      .filter((candidate) => candidate.name === "Observation")
      .map((observation) => ({
        type: required(observation, "Type"),
        code: required(observation, "Code"),
        value: optional(observation, "Value"),
        valueType: optional(observation, "ValueType"),
      })),
  };
}

function parseDiagnosis(element: XmlElement): Diagnosis {
  const type = required(element, "Type");
  if (!DIAGNOSIS_TYPES.includes(type as DiagnosisType)) throw new ClaimXmlError(`Unknown DiagnosisType ${type}`);
  return { type: type as DiagnosisType, code: required(element, "Code") };
}

function parseClaim(element: XmlElement): SubmittedClaim {
  const encounter = child(element, "Encounter");
  const diagnoses = element.children.filter((candidate) => candidate.name === "Diagnosis").map(parseDiagnosis);
  const activities = element.children.filter((candidate) => candidate.name === "Activity").map(parseActivity);
  if (!diagnoses.length) throw new ClaimXmlError("Claim needs at least one Diagnosis");
  if (!activities.length) throw new ClaimXmlError("Claim needs at least one Activity");
  return {
    id: required(element, "ID"),
    memberId: optional(element, "MemberID"),
    payerId: required(element, "PayerID"),
    providerId: required(element, "ProviderID"),
    emiratesIdNumber: required(element, "EmiratesIDNumber"),
    gross: parseAmount(required(element, "Gross")),
    patientShare: parseAmount(required(element, "PatientShare")),
    net: parseAmount(required(element, "Net")),
    encounter: encounter && {
      facilityId: required(encounter, "FacilityID"),
      type: Number(required(encounter, "Type")),
      patientId: required(encounter, "PatientID"),
      start: parseDhpoDate(required(encounter, "Start")),
      end: optional(encounter, "End") && parseDhpoDate(required(encounter, "End")),
    },
    diagnoses,
    activities,
  };
}

export function parseClaimSubmission(xml: string): { header: SubmissionHeader; claims: SubmittedClaim[] } {
  const submission = child(parseXml(xml), "Claim.Submission");
  if (!submission) throw new ClaimXmlError("Root element must be Claim.Submission");
  const header = child(submission, "Header");
  if (!header) throw new ClaimXmlError("Claim.Submission is missing Header");
  const claims = submission.children.filter((candidate) => candidate.name === "Claim").map(parseClaim);
  const recordCount = Number(required(header, "RecordCount"));
  if (recordCount !== claims.length) throw new ClaimXmlError(`RecordCount ${recordCount} does not match ${claims.length} claims`);
  return {
    header: {
      senderId: required(header, "SenderID"),
      receiverId: required(header, "ReceiverID"),
      transactionDate: parseDhpoDate(required(header, "TransactionDate")),
      recordCount,
      dispositionFlag: required(header, "DispositionFlag"),
    },
    claims,
  };
}

function element(name: string, value: string | undefined, indent: string): string {
  return value === undefined ? "" : `${indent}<${name}>${encode(value)}</${name}>\n`;
}

/** Writes one claim as a Claim.Submission, for fixtures and the scenario runner. */
export function toClaimSubmissionXml(claim: SubmittedClaim, header: Omit<SubmissionHeader, "recordCount">): string {
  const i2 = "    ";
  const i3 = "      ";
  const i4 = "        ";
  let xml = `<?xml version="1.0" encoding="utf-8"?>\n<Claim.Submission>\n  <Header>\n`;
  xml += element("SenderID", header.senderId, i2);
  xml += element("ReceiverID", header.receiverId, i2);
  xml += element("TransactionDate", formatDhpoDate(header.transactionDate), i2);
  xml += element("RecordCount", "1", i2);
  xml += element("DispositionFlag", header.dispositionFlag, i2);
  xml += `  </Header>\n  <Claim>\n`;
  xml += element("ID", claim.id, i2);
  xml += element("MemberID", claim.memberId, i2);
  xml += element("PayerID", claim.payerId, i2);
  xml += element("ProviderID", claim.providerId, i2);
  xml += element("EmiratesIDNumber", claim.emiratesIdNumber, i2);
  xml += element("Gross", formatAmount(claim.gross), i2);
  xml += element("PatientShare", formatAmount(claim.patientShare), i2);
  xml += element("Net", formatAmount(claim.net), i2);
  if (claim.encounter) {
    xml += `${i2}<Encounter>\n`;
    xml += element("FacilityID", claim.encounter.facilityId, i3);
    xml += element("Type", String(claim.encounter.type), i3);
    xml += element("PatientID", claim.encounter.patientId, i3);
    xml += element("Start", formatDhpoDate(claim.encounter.start), i3);
    xml += element("End", claim.encounter.end && formatDhpoDate(claim.encounter.end), i3);
    xml += `${i2}</Encounter>\n`;
  }
  for (const diagnosis of claim.diagnoses) {
    xml += `${i2}<Diagnosis>\n${element("Type", diagnosis.type, i3)}${element("Code", diagnosis.code, i3)}${i2}</Diagnosis>\n`;
  }
  for (const activity of claim.activities) {
    xml += `${i2}<Activity>\n`;
    xml += element("ID", activity.id, i3);
    xml += element("Start", formatDhpoDate(activity.start), i3);
    xml += element("Type", String(activity.type), i3);
    xml += element("Code", activity.code, i3);
    xml += element("Quantity", String(activity.quantity), i3);
    xml += element("Net", formatAmount(activity.net), i3);
    xml += element("Clinician", activity.clinician, i3);
    xml += element("PriorAuthorizationID", activity.priorAuthorizationId, i3);
    for (const observation of activity.observations) {
      xml += `${i3}<Observation>\n`;
      xml += element("Type", observation.type, i4);
      xml += element("Code", observation.code, i4);
      xml += element("Value", observation.value, i4);
      xml += element("ValueType", observation.valueType, i4);
      xml += `${i3}</Observation>\n`;
    }
    xml += `${i2}</Activity>\n`;
  }
  return `${xml}  </Claim>\n</Claim.Submission>\n`;
}
