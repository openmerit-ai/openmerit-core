/** Runtime-safe copy of the audited invoice benchmark's exact scoring rules. */

export const INVOICE_BENCHMARK_PROMPT = `Extract the invoice into the required JSON schema using only the image.

Rules:
- Copy names, identifiers, and descriptions exactly as printed.
- Return dates as YYYY-MM-DD, regardless of the printed date format.
- Return currency as its three-letter ISO code.
- Return monetary values and quantities as JSON numbers without currency symbols or grouping separators.
- Preserve line-item order and include every printed line item exactly once.
- Use null only when a scalar field is not present. Never infer a missing value.
- document_total_net is the subtotal/net amount before tax; document_total_amount is the final amount including tax.
- Return only the schema-conforming JSON object.`;

export const EXCLUDED_INVOICE_QUALITY_FIELDS = new Set(["po_number"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Match the Python equality semantics used by the original audited scorer. */
function pyEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (typeof a === "boolean" && typeof b === "boolean") return a === b;
    if (typeof a === "number" && typeof b === "boolean") return a === Number(b);
    if (typeof a === "boolean" && typeof b === "number") return Number(a) === b;
    return false;
  }
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => pyEqual(value, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => key in b && pyEqual(a[key], b[key]));
  }
  return false;
}

function flatten(value: unknown, path = ""): Record<string, unknown> {
  if (isPlainObject(value)) {
    let flattened: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      flattened = Object.assign(flattened, flatten(child, childPath));
    }
    return flattened;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { [`${path}.__length__`]: 0 };
    let flattened: Record<string, unknown> = { [`${path}.__length__`]: value.length };
    for (let index = 0; index < value.length; index++) {
      flattened = Object.assign(flattened, flatten(value[index], `${path}[${index}]`));
    }
    return flattened;
  }
  return { [path]: value };
}

function exactValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "boolean" || typeof actual === "boolean") {
    return typeof expected === typeof actual && expected === actual;
  }
  if (typeof expected === "number" && typeof actual === "number") return expected === actual;
  return typeof expected === typeof actual && expected === actual;
}

export interface InvoiceScore {
  exact_document: boolean;
  matched_leaves: number;
  total_union_leaves: number;
  exact_leaf_accuracy: number;
  scalar_accuracy: number;
  line_item_accuracy: number;
}

export function scoreInvoice(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | null,
): InvoiceScore {
  if (actual === null) {
    const expectedFlat = flatten(expected);
    return {
      exact_document: false,
      matched_leaves: 0,
      total_union_leaves: Object.keys(expectedFlat).length,
      exact_leaf_accuracy: 0,
      scalar_accuracy: 0,
      line_item_accuracy: 0,
    };
  }

  const expectedFlat = flatten(expected);
  const actualFlat = flatten(actual);
  const paths = new Set([...Object.keys(expectedFlat), ...Object.keys(actualFlat)]);
  let matches = 0;
  for (const path of paths) {
    if (path in expectedFlat && path in actualFlat && exactValue(expectedFlat[path], actualFlat[path])) {
      matches += 1;
    }
  }
  const scalarPaths = Object.keys(expectedFlat).filter((path) => !path.startsWith("line_items"));
  const itemPaths = [...paths].filter((path) => path.startsWith("line_items"));
  const scalarMatches = scalarPaths.filter(
    (path) => path in actualFlat && exactValue(expectedFlat[path], actualFlat[path]),
  ).length;
  const itemMatches = itemPaths.filter(
    (path) => path in expectedFlat && path in actualFlat && exactValue(expectedFlat[path], actualFlat[path]),
  ).length;
  return {
    exact_document: pyEqual(expected, actual),
    matched_leaves: matches,
    total_union_leaves: paths.size,
    exact_leaf_accuracy: paths.size ? matches / paths.size : 1,
    scalar_accuracy: scalarPaths.length ? scalarMatches / scalarPaths.length : 1,
    line_item_accuracy: itemPaths.length ? itemMatches / itemPaths.length : 1,
  };
}

export function parseInvoiceJson(content: string): Record<string, unknown> {
  let stripped = content.trim();
  if (stripped.startsWith("```")) {
    const lines = stripped.split(/\r\n|\r|\n/);
    stripped = lines.slice(1, -1).join("\n");
  }
  const parsed: unknown = JSON.parse(stripped);
  if (!isPlainObject(parsed)) throw new TypeError("Model output is not a JSON object");
  return parsed;
}

export function projectVisibleInvoice<T extends Record<string, unknown> | null | undefined>(
  document: T,
): T {
  if (document === null || document === undefined) return document;
  const projected = structuredClone(document);
  for (const field of EXCLUDED_INVOICE_QUALITY_FIELDS) delete projected[field];
  return projected;
}
