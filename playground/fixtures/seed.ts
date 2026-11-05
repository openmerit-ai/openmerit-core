// Fictional members, providers, clinicians and earlier paid claims. Emirates IDs use the
// 784-0000-… range so no number can match a real person.

import type { SeedData } from "../src/ledger.ts";
import { PLAN } from "../src/domain/plan.ts";
import type { Member } from "../src/domain/types.ts";

const member = (id: string, name: string, overrides: Partial<Member> = {}): Member => ({
  id,
  emiratesId: `784-0000-000${id.slice(-4)}-0`,
  name,
  dateOfBirth: "1990-01-01",
  visaEmirate: "Dubai",
  monthlySalaryAed: 3_200,
  planId: PLAN.id,
  policyStart: "2026-01-01",
  policyEnd: "2026-12-31",
  firstUaeScheme: false,
  declaredConditions: [],
  ...overrides,
});

export const SEED: SeedData = {
  members: [
    member("SH-M-1001", "Ravi Menon (fictional)"),
    member("SH-M-1002", "Joy Santos (fictional)", { policyStart: "2026-08-01", policyEnd: "2027-07-31", firstUaeScheme: true, declaredConditions: ["E11"] }),
    member("SH-M-1003", "Bilal Qureshi (fictional)", { declaredConditions: ["E11"] }),
    member("SH-M-1004", "Mei Lin (fictional)", { policyStart: "2026-12-01", policyEnd: "2027-11-30" }),
    member("SH-M-1005", "Hassan Ali (fictional)"),
    member("SH-M-1006", "Grace Okafor (fictional)"),
    member("SH-M-1007", "Arjun Pillai (fictional)"),
    member("SH-M-1008", "Fatima Noor (fictional)"),
    member("SH-M-1009", "Tomas Reyes (fictional)"),
    member("SH-M-1010", "Aisha Karim (fictional)"),
    member("SH-M-1011", "Peter Nolan (fictional)"),
    member("SH-M-1012", "Samir Haddad (fictional)", { declaredConditions: ["E11"] }),
    member("SH-M-1013", "Liza Cruz (fictional)"),
    member("SH-M-1014", "Kiran Rao (fictional)"),
  ],
  providers: [
    { id: "FICT-DHA-F-0001", name: "Al Noor Family Clinic (fictional)", facilityType: "clinic", inNetwork: true },
    { id: "FICT-DHA-F-0002", name: "Creek Specialist Centre (fictional)", facilityType: "hospital", inNetwork: true },
    { id: "FICT-DHA-F-0003", name: "Marina Medical Centre (fictional)", facilityType: "clinic", inNetwork: true },
  ],
  clinicians: [
    { id: "FICT-DHA-P-1001", name: "Dr Sara Haddad (fictional)", role: "GP" },
    { id: "FICT-DHA-P-1002", name: "Dr Omar Farouk (fictional)", role: "Specialist", specialty: "Orthopaedics" },
    { id: "FICT-DHA-P-1003", name: "Dr Lena Kovac (fictional)", role: "GP" },
  ],
  paidClaims: [
    {
      // Hassan's first visit; his follow-up claim five days later should carry no coinsurance.
      receivedAt: "2026-10-20T12:00:00.000Z",
      claim: {
        id: "FICT-CLM-0900",
        memberId: "SH-M-1005",
        payerId: PLAN.payerId,
        providerId: "FICT-DHA-F-0001",
        emiratesIdNumber: "784-0000-0001005-0",
        gross: 160_00,
        patientShare: 0,
        net: 160_00,
        encounter: { facilityId: "FICT-DHA-F-0001", type: 1, patientId: "SH-M-1005", start: "2026-10-20T10:00:00+04:00" },
        diagnoses: [{ type: "Principal", code: "J02.9" }],
        activities: [{ id: "A1", start: "2026-10-20T10:00:00+04:00", type: 3, code: "99213", quantity: 1, net: 160_00, clinician: "FICT-DHA-P-1001", observations: [] }],
      },
      lines: [{ activityId: "A1", code: "99213", benefit: "consultation", gross: 160_00, patientShare: 32_00, paymentAmount: 128_00, reason: "Seeded history" }],
    },
    // Bilal has used AED 2,480 of the AED 2,500 drug limit: eight monthly insulin dispenses of AED 310.
    ...["03", "04", "05", "06", "07", "08", "09", "10"].map((month, index) => ({
      receivedAt: `2026-${month}-05T12:00:00.000Z`,
      claim: {
        id: `FICT-CLM-091${index}`,
        memberId: "SH-M-1003",
        payerId: PLAN.payerId,
        providerId: "FICT-DHA-F-0001",
        emiratesIdNumber: "784-0000-0001003-0",
        gross: 310_00,
        patientShare: 0,
        net: 310_00,
        encounter: { facilityId: "FICT-DHA-F-0001", type: 1, patientId: "SH-M-1003", start: `2026-${month}-05T10:00:00+04:00` },
        diagnoses: [{ type: "Principal" as const, code: "E11.65" }],
        activities: [{ id: "A1", start: `2026-${month}-05T10:00:00+04:00`, type: 5 as const, code: "FICT-DDC-0007", quantity: 1, net: 310_00, clinician: "FICT-DHA-P-1001", observations: [] }],
      },
      lines: [{ activityId: "A1", code: "FICT-DDC-0007", benefit: "drugs", gross: 310_00, patientShare: 93_00, paymentAmount: 217_00, reason: "Seeded history" }],
    })),
    {
      // Tomas's visit at Marina Medical Centre; a later claim resubmits it under a new ID.
      receivedAt: "2026-10-16T12:00:00.000Z",
      claim: {
        id: "FICT-CLM-0902",
        memberId: "SH-M-1009",
        payerId: PLAN.payerId,
        providerId: "FICT-DHA-F-0003",
        emiratesIdNumber: "784-0000-0001009-0",
        gross: 230_00,
        patientShare: 0,
        net: 230_00,
        encounter: { facilityId: "FICT-DHA-F-0003", type: 1, patientId: "SH-M-1009", start: "2026-10-15T18:30:00+04:00" },
        diagnoses: [{ type: "Principal", code: "J02.0" }],
        activities: [
          { id: "A1", start: "2026-10-15T18:30:00+04:00", type: 3, code: "99213", quantity: 1, net: 160_00, clinician: "FICT-DHA-P-1003", observations: [] },
          { id: "A2", start: "2026-10-15T18:45:00+04:00", type: 3, code: "87880", quantity: 1, net: 70_00, clinician: "FICT-DHA-P-1003", observations: [] },
        ],
      },
      lines: [
        { activityId: "A1", code: "99213", benefit: "consultation", gross: 160_00, patientShare: 32_00, paymentAmount: 128_00, reason: "Seeded history" },
        { activityId: "A2", code: "87880", benefit: "laboratory", gross: 70_00, patientShare: 14_00, paymentAmount: 56_00, reason: "Seeded history" },
      ],
    },
  ],
};
