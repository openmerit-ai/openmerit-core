// Fictional members, providers, clinicians and earlier paid claims. Emirates IDs use the
// 784-0000-… range so no number can match a real person.

import type { SeedData } from "../src/ledger.ts";
import { PLAN } from "../src/domain/plan.ts";
import type { Activity, AdjudicationLine, Member, SubmittedClaim } from "../src/domain/types.ts";

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

/** A paid outpatient visit at 20% coinsurance, for history-dependent fixtures. */
function paidVisit(id: string, memberId: string, providerId: string, clinician: string, start: string, diagnosis: string, items: [code: string, net: number][]): SeedData["paidClaims"][number] {
  const activities: Activity[] = items.map(([code, net], index) => ({ id: `A${index + 1}`, start, type: 3, code, quantity: 1, net, clinician, observations: [] }));
  const gross = activities.reduce((sum, item) => sum + item.net, 0);
  const claim: SubmittedClaim = {
    id,
    memberId,
    payerId: PLAN.payerId,
    providerId,
    emiratesIdNumber: `784-0000-000${memberId.slice(-4)}-0`,
    gross,
    patientShare: 0,
    net: gross,
    encounter: { facilityId: providerId, type: 1, patientId: memberId, start },
    diagnoses: [{ type: "Principal", code: diagnosis }],
    activities,
  };
  const lines: AdjudicationLine[] = activities.map((item) => ({
    activityId: item.id,
    code: item.code,
    benefit: item.code.startsWith("99") ? "consultation" : "laboratory",
    gross: item.net,
    patientShare: item.net / 5,
    paymentAmount: item.net - item.net / 5,
    reason: "Seeded history",
  }));
  return { receivedAt: new Date(new Date(start).getTime() + 86_400_000).toISOString(), claim, lines };
}

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
    member("SH-M-1015", "Layla Mansour (fictional)"),
    member("SH-M-1016", "Omar Siddiqui (fictional)"),
    member("SH-M-1017", "Nikhil Varma (fictional)"),
    member("SH-M-1018", "Hana Yusuf (fictional)"),
    member("SH-M-1020", "Ahmed Farouk (fictional)", { declaredConditions: ["E11"] }),
    member("SH-M-1021", "Sofia Rossi (fictional)"),
    member("SH-M-1022", "Wei Zhang (fictional)"),
    member("SH-M-1023", "Priya Nair (fictional)"),
    member("SH-M-1024", "Mark Evans (fictional)"),
    member("SH-M-1025", "Yousef Haddad (fictional)"),
    member("SH-M-1026", "Elena Popescu (fictional)"),
    member("SH-M-1027", "Rashid Khan (fictional)", { declaredConditions: ["E11", "I10"] }),
    member("SH-M-1028", "George Mathew (fictional)"),
    // Members with history only: earlier visits at Jumeirah Wellness Clinic.
    ...["1090", "1091", "1092", "1093", "1094"].map((number) => member(`SH-M-${number}`, `Jumeirah patient ${number} (fictional)`)),
  ],
  providers: [
    { id: "FICT-DHA-F-0001", name: "Al Noor Family Clinic (fictional)", facilityType: "clinic", inNetwork: true },
    { id: "FICT-DHA-F-0002", name: "Creek Specialist Centre (fictional)", facilityType: "hospital", inNetwork: true },
    { id: "FICT-DHA-F-0003", name: "Marina Medical Centre (fictional)", facilityType: "clinic", inNetwork: true },
    { id: "FICT-DHA-F-0004", name: "Jumeirah Wellness Clinic (fictional)", facilityType: "clinic", inNetwork: true },
  ],
  clinicians: [
    { id: "FICT-DHA-P-1001", name: "Dr Sara Haddad (fictional)", role: "GP" },
    { id: "FICT-DHA-P-1002", name: "Dr Omar Farouk (fictional)", role: "Specialist", specialty: "Orthopaedics" },
    { id: "FICT-DHA-P-1003", name: "Dr Lena Kovac (fictional)", role: "GP" },
    { id: "FICT-DHA-P-1004", name: "Dr Karim Saleh (fictional)", role: "GP" },
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
    // Wei's first strep throat; the claim two weeks later is a recurrence, not a duplicate.
    paidVisit("FICT-CLM-0903", "SH-M-1022", "FICT-DHA-F-0001", "FICT-DHA-P-1001", "2026-10-20T17:00:00+04:00", "J02.0", [["99213", 160_00], ["87880", 70_00]]),
    // Priya's UTI visit; a later claim resubmits it with a higher consultation amount.
    paidVisit("FICT-CLM-0904", "SH-M-1023", "FICT-DHA-F-0003", "FICT-DHA-P-1003", "2026-10-22T09:00:00+04:00", "N39.0", [["99213", 160_00], ["81003", 35_00]]),
    // Jumeirah Wellness Clinic bills the highest E/M level for simple visits.
    ...(
      [
        ["FICT-CLM-0905", "SH-M-1090", "2026-10-06T10:00:00+04:00", "J06.9"],
        ["FICT-CLM-0906", "SH-M-1091", "2026-10-09T11:00:00+04:00", "J02.9"],
        ["FICT-CLM-0907", "SH-M-1092", "2026-10-14T09:30:00+04:00", "R51.9"],
        ["FICT-CLM-0908", "SH-M-1093", "2026-10-21T16:00:00+04:00", "J06.9"],
        ["FICT-CLM-0909", "SH-M-1094", "2026-10-28T12:00:00+04:00", "K21.9"],
      ] as const
    ).map(([id, memberId, start, diagnosis]) => paidVisit(id, memberId, "FICT-DHA-F-0004", "FICT-DHA-P-1004", start, diagnosis, [["99215", 350_00]])),
  ],
};
