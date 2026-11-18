// The rules that keep key- and token-shaped text out of everything OpenMerit stores or sends:
// scan snippets, eval output, and task bundles a coding agent sends the cloud.

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-(?:proj-|ant-|or-|lf-|live-|test-)?[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  /((?:api[_-]?key|apikey|token|secret|password|authorization)\w*["']?\s*[:=]\s*["'])[^"'\s]{4,}(["'])/gi,
];

/** Replaces key- and token-shaped text with [redacted]. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (match, ...groups: unknown[]) => {
    const prefix = typeof groups[0] === "string" && /[:=\s]$/.test(groups[0]) ? groups[0] : typeof groups[0] === "string" && /^Bearer/i.test(groups[0]) ? groups[0] : "";
    const suffix = typeof groups[1] === "string" && /^["']$/.test(groups[1]) ? groups[1] : "";
    return prefix || suffix ? `${prefix}[redacted]${suffix}` : "[redacted]";
  });
  return out;
}
