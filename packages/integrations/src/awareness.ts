import type { Destination, EvalSpec, Scorer } from "../../core/src/index.ts";

export type CompatibilityMode = "native" | "sdk-wrapper" | "local-harness" | "blocked";

export type ScorerCompatibility = {
  mode: CompatibilityMode;
  label: string;
  reason: string;
};

export const destinationCapabilities = (destination: Destination) => ({
  destination,
  scopes: ["output"] as const,
  kinds: [
    "exact",
    "normalized",
    "contains",
    "regex",
    "numeric",
    "set",
    "json-schema",
    "judge",
  ] as const,
  execution: destination === "local" ? ("local" as const) : ("sdk" as const),
  selectedImports: destination !== "local",
  attachments: false,
  productionActivation: false,
});

export function scorerCompatibility(scorer: Scorer, destination: Destination): ScorerCompatibility {
  if (scorer.dependencies.length) {
    return {
      mode: destination === "local" ? "local-harness" : "blocked",
      label: destination === "local" ? "Local harness" : "Blocked",
      reason: "Unverified scorer dependencies require an explicit local harness.",
    };
  }

  if (scorer.scope !== "output") {
    return {
      mode: destination === "local" ? "local-harness" : "blocked",
      label: destination === "local" ? "Local harness" : "Blocked",
      reason: `${scorer.scope} scope requires application context that portable destination SDKs do not provide.`,
    };
  }

  if (scorer.kind === "custom") {
    return {
      mode: destination === "local" ? "local-harness" : "blocked",
      label: destination === "local" ? "Local harness" : "Blocked",
      reason:
        destination === "local"
          ? "Custom code runs only when explicitly enabled in your trusted environment."
          : "Custom Python cannot be published by this destination adapter.",
    };
  }

  if (destination === "local") {
    return {
      mode: "native",
      label: "Portable local",
      reason: "Runs in the exported standalone Python runtime.",
    };
  }

  return {
    mode: "sdk-wrapper",
    label: "SDK wrapper",
    reason: `Runs through the exported ${destination} SDK package; no scorer semantics are dropped.`,
  };
}

export function destinationReadiness(spec: EvalSpec, destination: Destination) {
  const scorers = spec.scorers.map((scorer) => ({
    scorerId: scorer.id,
    ...scorerCompatibility(scorer, destination),
  }));
  const mediaCases = spec.cases.filter(
    (item) => item.attachments.length || JSON.stringify(item.input).includes("local://"),
  );
  const blockers = [
    ...scorers
      .filter((item) => item.mode === "blocked")
      .map((item) => ({ path: item.scorerId, message: item.reason })),
    ...(mediaCases.length
      ? [
          {
            path: "cases",
            message:
              "Local document or image references require supplied outputs or a custom application harness.",
          },
        ]
      : []),
  ];

  return {
    destination,
    execution: destination === "local" ? ("local" as const) : ("sdk" as const),
    valid: blockers.length === 0,
    blockers,
    scorers,
  };
}
