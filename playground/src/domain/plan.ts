// Sahra Essential: a fictional plan that follows the Dubai Essential Benefits Plan (EBP)
// outpatient rules. Source: DHA circular GC 03/2024, Appendix A, "Table of Benefits for the
// Essential Benefit Plan", in force from 1 January 2025:
// https://www.isahd.ae/content/docs/GC%2003%202024.pdf
// Only the outpatient rules the first loop needs are modelled. Inpatient, maternity, dental and
// mental health benefits come later.

import type { Fils } from "./types.ts";

export type Benefit = "consultation" | "laboratory" | "radiology" | "advanced_imaging" | "physiotherapy" | "drugs";

export interface BenefitRule {
  benefit: Benefit;
  /** Coinsurance the member pays, in basis points of the line amount (2000 = 20%). */
  coinsuranceBp: number;
  priorApprovalRequired: boolean;
  citation: string;
}

export const PLAN = {
  id: "SAHRA-ESSENTIAL-2026",
  name: "Sahra Essential (EBP-style, fictional)",
  payerId: "FICT-PAYER-SAHRA",
  /** Annual upper aggregate claims limit, including coinsurance and deductibles. */
  annualLimit: 150_000_00 as Fils,
  /** EBP eligibility used by Dubai insurers: monthly salary of AED 4,000 or less. */
  maxMonthlySalaryAed: 4_000,
  /** Treatment of pre-existing and chronic conditions may be excluded for the first 6 months of a first UAE scheme. */
  preExistingWaitingMonths: 6,
  /** Consultation coinsurance is waived for a follow-up within this many days. */
  followUpWaiverDays: 7,
  drugsAnnualLimit: 2_500_00 as Fils,
  physiotherapySessionsPerYear: 6,
  /** Basic outpatient care is covered within the Emirate of Dubai. */
  geographicScope: "Dubai",
  rules: {
    consultation: {
      benefit: "consultation",
      coinsuranceBp: 2000,
      priorApprovalRequired: false,
      citation: "GC 03/2024 App. A: 20% coinsurance per visit; none for a follow-up within seven days; specialist care needs a GP e-Referral",
    },
    laboratory: {
      benefit: "laboratory",
      coinsuranceBp: 2000,
      priorApprovalRequired: false,
      citation: "GC 03/2024 App. A: laboratory tests, 20% coinsurance",
    },
    radiology: {
      benefit: "radiology",
      coinsuranceBp: 2000,
      priorApprovalRequired: false,
      citation: "GC 03/2024 App. A: radiology diagnostics, 20% coinsurance",
    },
    advanced_imaging: {
      benefit: "advanced_imaging",
      coinsuranceBp: 2000,
      priorApprovalRequired: true,
      citation: "GC 03/2024 App. A: MRI, CT and endoscopy need the insurer's prior approval outside emergencies",
    },
    physiotherapy: {
      benefit: "physiotherapy",
      coinsuranceBp: 2000,
      priorApprovalRequired: true,
      citation: "GC 03/2024 App. A: physiotherapy needs prior approval, maximum 6 sessions per year, 20% per session",
    },
    drugs: {
      benefit: "drugs",
      coinsuranceBp: 3000,
      priorApprovalRequired: false,
      citation: "GC 03/2024 App. A: 30% per prescription, annual limit AED 2,500 including coinsurance, formulary products",
    },
  } satisfies Record<Benefit, BenefitRule>,
  /** A subset of the EBP's excluded (non-basic) services, by ICD-10-CM prefix of the principal diagnosis. */
  excludedDiagnosisPrefixes: [
    { prefix: "E66", reason: "GC 03/2024 exclusion 8: treatment for obesity and weight control" },
    { prefix: "L65", reason: "GC 03/2024 exclusion 11: hair loss (alopecia) treatment" },
    { prefix: "Z02", reason: "GC 03/2024 exclusion 35: examinations for employment, travel, licensing or insurance" },
    { prefix: "F17", reason: "GC 03/2024 exclusion 12: smoking cessation and nicotine addiction" },
  ],
} as const;

/** Fictional denial codes in the style of a remittance advice. They are not DHA's official code list. */
export const DENIAL_CODES = {
  "SH-ELIG-01": "Patient is not a covered member on the date of service",
  "SH-AUTH-01": "Prior approval required and not obtained",
  "SH-REF-01": "Specialist consultation without a GP e-Referral",
  "SH-CODE-01": "Invalid or deleted code for the date of service",
  "SH-CODE-02": "Activity not supported by the documented diagnosis",
  "SH-CODE-03": "Service is included in another billed service (unbundling)",
  "SH-CODE-04": "Level of service not supported by the documentation (upcoding)",
  "SH-NCOV-01": "Service is excluded from the plan",
  "SH-PREX-01": "Pre-existing condition within the waiting period",
  "SH-LIM-01": "Benefit or annual limit exhausted",
  "SH-DUPL-01": "Duplicate of a claim already received",
  "SH-MNEC-01": "Not medically necessary for the documented condition",
  "SH-BILL-01": "Billed amount not supported by the itemized bill",
} as const;

export type DenialCode = keyof typeof DENIAL_CODES;

export function isDenialCode(code: string): code is DenialCode {
  return Object.hasOwn(DENIAL_CODES, code);
}
