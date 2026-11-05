// Sahra Health's data model. Every record is fictional.

/** Amounts are integer fils (1 AED = 100 fils) so benefit math is exact. */
export type Fils = number;

export type DiagnosisType = "Principal" | "Secondary" | "Admitting";

/** DHPO ActivityType: 3 CPT, 4 HCPCS, 5 Drug, 6 Dental, 8 Service, 9 DRG, 10 Scientific. */
export type ActivityType = 3 | 4 | 5 | 6 | 8 | 9 | 10;

export interface Diagnosis {
  type: DiagnosisType;
  code: string;
}

export interface Activity {
  id: string;
  /** ISO 8601, converted from eClaimLink's dd/mm/yyyy HH:mm. */
  start: string;
  type: ActivityType;
  code: string;
  quantity: number;
  net: Fils;
  clinician: string;
  priorAuthorizationId?: string;
  observations: { type: string; code: string; value?: string; valueType?: string }[];
}

export interface Encounter {
  facilityId: string;
  /** DHPO EncounterType; 1 = no bed and no emergency room (outpatient). */
  type: number;
  patientId: string;
  start: string;
  end?: string;
}

/** One `Claim` element of an eClaimLink `Claim.Submission`. */
export interface SubmittedClaim {
  id: string;
  memberId?: string;
  payerId: string;
  providerId: string;
  emiratesIdNumber: string;
  gross: Fils;
  patientShare: Fils;
  net: Fils;
  encounter?: Encounter;
  diagnoses: Diagnosis[];
  activities: Activity[];
}

export interface SubmissionHeader {
  senderId: string;
  receiverId: string;
  transactionDate: string;
  recordCount: number;
  dispositionFlag: string;
}

export interface Member {
  id: string;
  emiratesId: string;
  name: string;
  dateOfBirth: string;
  visaEmirate: string;
  monthlySalaryAed: number;
  planId: string;
  policyStart: string;
  policyEnd: string;
  /** True when this is the member's first health scheme in the UAE (pre-existing waiting period applies). */
  firstUaeScheme: boolean;
  declaredConditions: string[];
}

export interface EnrollmentApplication {
  applicationId: string;
  name: string;
  emiratesId: string;
  dateOfBirth: string;
  visaEmirate: string;
  monthlySalaryAed: number;
  employer: string;
  requestedStart: string;
  previousUaeInsurance: boolean;
  /** Free text from the applicant's health declaration. */
  healthDeclaration: string;
}

export interface Provider {
  id: string;
  name: string;
  facilityType: "clinic" | "hospital" | "pharmacy" | "lab";
  inNetwork: boolean;
}

export interface Clinician {
  id: string;
  name: string;
  role: "GP" | "Specialist" | "Physiotherapist" | "Pharmacist";
  specialty?: string;
}

export type ClaimState =
  | "received"
  | "extracted"
  | "coded"
  | "adjudicated"
  | "fraud_checked"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "paid"
  | "error";

export interface BillItem {
  description: string;
  activityId?: string;
  amount: Fils;
}

export interface Extraction {
  billItems: BillItem[];
  billTotal: Fils;
  presentingComplaint: string;
  referral?: string;
  mismatches: string[];
}

export interface CodingFinding {
  activityId?: string;
  code: string;
  severity: "info" | "warn" | "error";
  kind: "invalid_code" | "diagnosis_mismatch" | "unbundling" | "upcoding" | "other";
  message: string;
}

/** Remittance-advice style line decision. Amounts are computed by code, not by the model. */
export interface AdjudicationLine {
  activityId: string;
  code: string;
  benefit: string;
  gross: Fils;
  patientShare: Fils;
  paymentAmount: Fils;
  denialCode?: string;
  reason: string;
}

export interface FraudSignal {
  kind: "duplicate" | "frequency" | "pattern" | "identity" | "other";
  score: number;
  message: string;
}

export interface Approval {
  decision: "approve" | "reject";
  by: string;
  note?: string;
  at: string;
}
