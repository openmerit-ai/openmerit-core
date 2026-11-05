// A small subset of the 2024 ICD-10-CM and CPT code sets, which DHA requires for claims with a
// service date on or after 1 April 2026 (circular GC 06/2025:
// https://www.isahd.ae/content/docs/GC%2006-2025%20Circular%20on%20Update%20of%20Code%20Sets,%20DRG%20Payment%20Parameters%20and%20Grouper%20Version%20%E2%80%93%20Effective%201%20April%202026.pdf).
// Descriptions are abbreviated. Prices are a fictional Sahra tariff, not DHA's mandatory tariff.
// Drug codes are fictional; real Dubai claims use DHA drug (DDC) codes.

import type { Benefit } from "./plan.ts";
import type { ActivityType, Fils } from "./types.ts";

export interface DiagnosisCode {
  code: string;
  description: string;
  /** Chronic conditions are subject to the pre-existing waiting period when declared at enrollment. */
  chronic?: boolean;
}

export interface ActivityCode {
  type: ActivityType;
  code: string;
  description: string;
  benefit: Benefit;
  tariff: Fils;
  /** ICD-10-CM prefixes this activity is usually supported by; empty means any diagnosis. */
  supportedBy: string[];
  /** Codes whose service this code already includes, so billing both is unbundling. */
  includes?: string[];
  /** For E/M codes: the medical decision-making level. */
  level?: "straightforward" | "low" | "moderate" | "high";
}

export const ICD10CM_2024: DiagnosisCode[] = [
  { code: "J02.0", description: "Streptococcal pharyngitis" },
  { code: "J02.9", description: "Acute pharyngitis, unspecified" },
  { code: "J06.9", description: "Acute upper respiratory infection, unspecified" },
  { code: "J45.909", description: "Unspecified asthma, uncomplicated", chronic: true },
  { code: "E11.9", description: "Type 2 diabetes mellitus without complications", chronic: true },
  { code: "E11.65", description: "Type 2 diabetes mellitus with hyperglycemia", chronic: true },
  { code: "I10", description: "Essential (primary) hypertension", chronic: true },
  { code: "M54.50", description: "Low back pain, unspecified" },
  { code: "N39.0", description: "Urinary tract infection, site not specified" },
  { code: "K21.9", description: "Gastro-esophageal reflux disease without esophagitis" },
  { code: "R10.9", description: "Unspecified abdominal pain" },
  { code: "R51.9", description: "Headache, unspecified" },
  { code: "E66.9", description: "Obesity, unspecified" },
  { code: "Z02.1", description: "Encounter for pre-employment examination" },
];

/** Codes deleted before the 2024 code set, with their replacement, to catch stale coding. */
export const DELETED_ICD10CM: Record<string, string> = {
  "M54.5": "Deleted on 1 Oct 2021; use M54.50, M54.51 or M54.59",
};

const anyDiagnosis: string[] = [];
const labForMetabolic = ["E11", "I10", "R10", "E66"];

export const ACTIVITY_CODES: ActivityCode[] = [
  { type: 3, code: "99202", description: "Office visit, new patient, straightforward MDM", benefit: "consultation", tariff: 150_00, supportedBy: anyDiagnosis, level: "straightforward" },
  { type: 3, code: "99203", description: "Office visit, new patient, low MDM", benefit: "consultation", tariff: 200_00, supportedBy: anyDiagnosis, level: "low" },
  { type: 3, code: "99204", description: "Office visit, new patient, moderate MDM", benefit: "consultation", tariff: 300_00, supportedBy: anyDiagnosis, level: "moderate" },
  { type: 3, code: "99205", description: "Office visit, new patient, high MDM", benefit: "consultation", tariff: 400_00, supportedBy: anyDiagnosis, level: "high" },
  { type: 3, code: "99212", description: "Office visit, established patient, straightforward MDM", benefit: "consultation", tariff: 120_00, supportedBy: anyDiagnosis, level: "straightforward" },
  { type: 3, code: "99213", description: "Office visit, established patient, low MDM", benefit: "consultation", tariff: 160_00, supportedBy: anyDiagnosis, level: "low" },
  { type: 3, code: "99214", description: "Office visit, established patient, moderate MDM", benefit: "consultation", tariff: 250_00, supportedBy: anyDiagnosis, level: "moderate" },
  { type: 3, code: "99215", description: "Office visit, established patient, high MDM", benefit: "consultation", tariff: 350_00, supportedBy: anyDiagnosis, level: "high" },
  { type: 3, code: "36415", description: "Collection of venous blood by venipuncture", benefit: "laboratory", tariff: 25_00, supportedBy: anyDiagnosis },
  { type: 3, code: "80048", description: "Basic metabolic panel", benefit: "laboratory", tariff: 90_00, supportedBy: labForMetabolic, includes: ["82947"] },
  { type: 3, code: "80053", description: "Comprehensive metabolic panel", benefit: "laboratory", tariff: 120_00, supportedBy: labForMetabolic, includes: ["80048", "82947"] },
  { type: 3, code: "82947", description: "Glucose, quantitative, blood", benefit: "laboratory", tariff: 30_00, supportedBy: ["E11", "R10"] },
  { type: 3, code: "83036", description: "Hemoglobin A1c", benefit: "laboratory", tariff: 80_00, supportedBy: ["E11"] },
  { type: 3, code: "85025", description: "Complete blood count with automated differential", benefit: "laboratory", tariff: 60_00, supportedBy: anyDiagnosis, includes: ["85027"] },
  { type: 3, code: "85027", description: "Complete blood count, automated", benefit: "laboratory", tariff: 45_00, supportedBy: anyDiagnosis },
  { type: 3, code: "87880", description: "Rapid strep A antigen test (immunoassay)", benefit: "laboratory", tariff: 70_00, supportedBy: ["J02", "J06"] },
  { type: 3, code: "81003", description: "Urinalysis, automated, without microscopy", benefit: "laboratory", tariff: 35_00, supportedBy: ["N39", "R10", "E11"] },
  { type: 3, code: "87086", description: "Urine culture, quantitative colony count", benefit: "laboratory", tariff: 90_00, supportedBy: ["N39"] },
  { type: 3, code: "71046", description: "Chest X-ray, 2 views", benefit: "radiology", tariff: 180_00, supportedBy: ["J06", "J45", "R50"] },
  { type: 3, code: "72148", description: "MRI lumbar spine without contrast", benefit: "advanced_imaging", tariff: 1_600_00, supportedBy: ["M54"] },
  { type: 3, code: "97161", description: "Physical therapy evaluation, low complexity", benefit: "physiotherapy", tariff: 200_00, supportedBy: ["M54"] },
  { type: 3, code: "97110", description: "Therapeutic exercise, each 15 minutes", benefit: "physiotherapy", tariff: 120_00, supportedBy: ["M54"] },
  { type: 5, code: "FICT-DDC-0001", description: "Amoxicillin 500 mg capsules, 21", benefit: "drugs", tariff: 25_00, supportedBy: ["J02", "J06", "N39"] },
  { type: 5, code: "FICT-DDC-0002", description: "Paracetamol 500 mg tablets, 20", benefit: "drugs", tariff: 8_00, supportedBy: anyDiagnosis },
  { type: 5, code: "FICT-DDC-0003", description: "Metformin 500 mg tablets, 60", benefit: "drugs", tariff: 30_00, supportedBy: ["E11"] },
  { type: 5, code: "FICT-DDC-0004", description: "Nitrofurantoin 100 mg capsules, 10", benefit: "drugs", tariff: 40_00, supportedBy: ["N39"] },
  { type: 5, code: "FICT-DDC-0005", description: "Orlistat 120 mg capsules, 84", benefit: "drugs", tariff: 220_00, supportedBy: ["E66"] },
  { type: 5, code: "FICT-DDC-0007", description: "Insulin glargine 100 units/mL pens, 5", benefit: "drugs", tariff: 310_00, supportedBy: ["E11"] },
  { type: 5, code: "FICT-DDC-0006", description: "Amlodipine 5 mg tablets, 30", benefit: "drugs", tariff: 35_00, supportedBy: ["I10"] },
];

export function findDiagnosis(code: string): DiagnosisCode | undefined {
  return ICD10CM_2024.find((entry) => entry.code === code);
}

export function findActivity(type: ActivityType, code: string): ActivityCode | undefined {
  return ACTIVITY_CODES.find((entry) => entry.type === type && entry.code === code);
}
