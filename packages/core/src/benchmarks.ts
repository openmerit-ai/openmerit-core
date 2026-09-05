import type { EvalSpec } from "./schema.ts";

export type EvalWriterBrief = {
  id: string;
  family: EvalSpec["family"];
  description: string;
  mustCover: string[];
};

/**
 * Blinded eval-writer benchmark corpus. These briefs intentionally vary in
 * specificity and risk so generated evals can be compared with a generic
 * baseline without exposing the expected checklist to the authoring model.
 */
export const evalWriterBriefs: EvalWriterBrief[] = [
  {
    id: "classification-support-routing",
    family: "classification",
    description:
      "Classify customer emails into 14 support queues. Missing security or billing issues is much worse than an ordinary routing error. Return one JSON label.",
    mustCover: ["allowed labels", "high-risk recall", "JSON validity"],
  },
  {
    id: "classification-content-policy",
    family: "classification",
    description:
      "Assign moderation policy categories to user posts, including a safe fallback when evidence is ambiguous.",
    mustCover: ["multi-label policy", "false negatives", "ambiguity"],
  },
  {
    id: "classification-intent",
    family: "classification",
    description:
      "Detect purchase, refund, cancellation, and product-question intents in multilingual chat.",
    mustCover: ["language slices", "class balance", "unknown intent"],
  },
  {
    id: "extraction-invoices",
    family: "extraction",
    description:
      "Extract invoice number, VAT number, date, currency, and total from scanned UAE invoices. A fabricated VAT number is critical.",
    mustCover: ["field accuracy", "missing values", "scan quality"],
  },
  {
    id: "extraction-contracts",
    family: "extraction",
    description:
      "Extract parties, effective date, governing law, renewal terms, and termination notice from contracts.",
    mustCover: ["source evidence", "conflicting clauses", "missing clauses"],
  },
  {
    id: "extraction-receipts",
    family: "extraction",
    description:
      "Convert retail receipts into line-item JSON while preserving quantities, taxes, discounts, and totals.",
    mustCover: ["schema validity", "arithmetic consistency", "line items"],
  },
  {
    id: "summarization-clinical",
    family: "summarization",
    description:
      "Summarize a clinician handoff without omitting medications, allergies, or pending tests.",
    mustCover: ["critical fact recall", "unsupported claims", "conciseness"],
  },
  {
    id: "summarization-meetings",
    family: "summarization",
    description: "Turn a meeting transcript into decisions, owners, and dated action items.",
    mustCover: ["attribution", "decision preservation", "action completeness"],
  },
  {
    id: "summarization-legal",
    family: "summarization",
    description:
      "Summarize a legal opinion for executives while preserving caveats and jurisdiction limits.",
    mustCover: ["caveats", "material facts", "audience fit"],
  },
  {
    id: "grounded-qa-help-center",
    family: "grounded-qa",
    description:
      "Answer product questions using a private help center and cite the supporting article.",
    mustCover: ["citation correctness", "groundedness", "abstention"],
  },
  {
    id: "grounded-qa-policy",
    family: "grounded-qa",
    description:
      "Answer employee policy questions from dated policy documents where newer documents supersede older ones.",
    mustCover: ["document version", "conflicting evidence", "citation"],
  },
  {
    id: "grounded-qa-technical",
    family: "grounded-qa",
    description:
      "Answer API integration questions from reference docs and code examples without inventing methods.",
    mustCover: ["API accuracy", "code validity", "unsupported requests"],
  },
  {
    id: "generation-product-copy",
    family: "generation",
    description:
      "Write short product descriptions using only supplied catalog attributes and a fixed brand voice.",
    mustCover: ["attribute coverage", "unsupported claims", "style"],
  },
  {
    id: "generation-email",
    family: "generation",
    description:
      "Draft account-renewal emails with required legal text, correct dates, and no invented discounts.",
    mustCover: ["required text", "factuality", "date accuracy"],
  },
  {
    id: "generation-sql-explanation",
    family: "generation",
    description:
      "Explain analytics query results to non-technical users without changing the meaning of the numbers.",
    mustCover: ["numeric fidelity", "clarity", "causal overclaiming"],
  },
  {
    id: "coding-patch-typescript",
    family: "coding-patch",
    description:
      "Fix a TypeScript regression from an issue and repository context with no unrelated file changes.",
    mustCover: ["tests", "typecheck", "diff scope"],
  },
  {
    id: "coding-patch-python",
    family: "coding-patch",
    description:
      "Repair timeout and retry handling in a Python HTTP client while preserving public behavior.",
    mustCover: ["retry behavior", "timeouts", "regressions"],
  },
  {
    id: "coding-patch-migration",
    family: "coding-patch",
    description: "Add a backwards-compatible database migration and update the data access layer.",
    mustCover: ["migration safety", "backwards compatibility", "tests"],
  },
  {
    id: "code-review-auth",
    family: "code-review",
    description:
      "Review an authentication patch for exploitable defects without reporting speculative issues.",
    mustCover: ["actionable evidence", "false positives", "severity"],
  },
  {
    id: "code-review-concurrency",
    family: "code-review",
    description: "Review a queue worker change for races, duplicate execution, and lost updates.",
    mustCover: ["race conditions", "idempotency", "precise location"],
  },
  {
    id: "code-review-api",
    family: "code-review",
    description:
      "Review a REST API change for contract breaks, validation gaps, and unsafe error disclosure.",
    mustCover: ["API compatibility", "validation", "error handling"],
  },
  {
    id: "tool-calling-weather",
    family: "tool-calling",
    description:
      "Choose and call weather and geocoding tools with valid arguments and no unauthorized side effects.",
    mustCover: ["tool choice", "argument validity", "side effects"],
  },
  {
    id: "tool-calling-support",
    family: "tool-calling",
    description:
      "Resolve support requests using read-only account tools, escalating before any refund action.",
    mustCover: ["authorization", "tool sequence", "final state"],
  },
  {
    id: "tool-calling-calendar",
    family: "tool-calling",
    description:
      "Find mutual availability and schedule a meeting only after the user confirms the final time.",
    mustCover: ["confirmation", "timezone", "resulting state"],
  },
  {
    id: "document-financial-report",
    family: "document",
    description:
      "Answer questions over a financial report containing tables, footnotes, and repeated metrics.",
    mustCover: ["table grounding", "units", "footnotes"],
  },
  {
    id: "document-application",
    family: "document",
    description:
      "Review an application packet for missing required documents without inferring protected traits.",
    mustCover: ["completeness", "privacy", "illegible pages"],
  },
  {
    id: "document-shipping",
    family: "document",
    description:
      "Extract and cross-check bill-of-lading fields across a multi-page shipping document.",
    mustCover: ["cross-page consistency", "field accuracy", "missing pages"],
  },
  {
    id: "image-json-inventory",
    family: "image-json",
    description:
      "Return visible warehouse inventory objects as schema-valid JSON, including counts and confidence.",
    mustCover: ["visual grounding", "counting", "schema validity"],
  },
  {
    id: "image-json-damage",
    family: "image-json",
    description:
      "Identify visible vehicle damage from photos without asserting damage hidden from view.",
    mustCover: ["visibility", "localization", "uncertainty"],
  },
  {
    id: "image-json-receipt",
    family: "image-json",
    description:
      "Read a photographed receipt into JSON and flag fields that are occluded or illegible.",
    mustCover: ["OCR accuracy", "occlusion", "missing-value behavior"],
  },
];
