// Builds OTLP/HTTP JSON spans with Langfuse's attribute names (ingestion format v4), so a
// recorded evaluation is a Langfuse experiment item without the deprecated dataset-run-items API.
// https://langfuse.com/integrations/native/opentelemetry

import { createHash } from "node:crypto";

/** Deterministic hex IDs, so a retried recording updates the same trace, spans and scores. */
export const hexId = (value: string, length: 16 | 32): string => createHash("sha256").update(value).digest("hex").slice(0, length);

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number } | { arrayValue: { values: AnyValue[] } };
export interface Attribute {
  key: string;
  value: AnyValue;
}

export function attribute(key: string, value: string | number | boolean | string[]): Attribute {
  if (Array.isArray(value)) return { key, value: { arrayValue: { values: value.map((item) => ({ stringValue: item })) } } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
  return { key, value: { stringValue: value } };
}

export const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "null");
const nanos = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number; message?: string };
}

export function span(input: { traceId: string; spanId: string; parentSpanId?: string; name: string; startMs: number; endMs: number; attributes: Attribute[]; error?: string }): OtlpSpan {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    name: input.name,
    kind: 1,
    startTimeUnixNano: nanos(input.startMs),
    endTimeUnixNano: nanos(Math.max(input.endMs, input.startMs)),
    attributes: input.attributes,
    status: input.error ? { code: 2, message: input.error.slice(0, 500) } : { code: 1 },
  };
}

export function exportRequest(spans: OtlpSpan[], version: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "openmerit")] },
        scopeSpans: [{ scope: { name: "openmerit-langfuse-connector", version }, spans }],
      },
    ],
  };
}
