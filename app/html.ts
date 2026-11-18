// Escaping templates and formatting for the app's views. Views return Html built
// with `html`, which escapes every interpolated value unless it is already Html.
export interface Html { readonly __html: string }

export const raw = (value: string): Html => ({ __html: value });
const isHtml = (value: unknown): value is Html => typeof value === "object" && value !== null && "__html" in value;
const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => entities[char] ?? char);

function part(value: unknown): string {
  if (isHtml(value)) return value.__html;
  if (Array.isArray(value)) return value.map(part).join("");
  if (value === null || value === undefined || value === false) return "";
  return escape(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, index) => { out += part(value) + (strings[index + 1] ?? ""); });
  return raw(out);
}

// Logos are app/logos/*.svg, which the build passes to setLogos; single-colour ones follow the text colour.
let logos: Readonly<Record<string, string>> = {};
let logoCount = 0;
export const setLogos = (map: Readonly<Record<string, string>>): void => { logos = map; };
export function logo(name: string | null): Html {
  const svg = name ? logos[name] : undefined;
  // Gradient ids must stay unique when a logo appears more than once on a page.
  return svg ? raw(svg.replace("<svg ", '<svg class="logo" aria-hidden="true" ').replaceAll("_R_0_", `_${logoCount++}`)) : raw("");
}

export function providerLogo(model: string): string | null {
  const id = model.toLowerCase();
  if (/claude|anthropic/.test(id)) return "claude";
  if (/gpt|openai|(^|\/)o\d/.test(id)) return "openai";
  if (/gemini|google/.test(id)) return "gemini";
  if (/deepseek/.test(id)) return "deepseek";
  if (/mistral|ministral|codestral/.test(id)) return "mistral";
  if (/llama|meta-/.test(id)) return "meta";
  if (/qwen/.test(id)) return "qwen";
  if (/grok|x-ai|xai/.test(id)) return "xai";
  if (/kimi|moonshot/.test(id)) return "kimi";
  return null;
}

// A model ID such as anthropic/claude-haiku-5-5, shown without its provider prefix.
export const modelName = (id: string): string => id.split("/").at(-1) ?? id;
export const model = (id: string): Html => html`${logo(providerLogo(id))}${modelName(id)}`;
export const endpointName = (id: string): string => (id === "openrouter" ? "OpenRouter" : id);

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  if (value > 0 && value < 0.01) return "<$0.01";
  const digits = Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const day = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "–");
export const date = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
export const seconds = (ms: number | null): string => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
// Per-call costs read better per 1,000 calls.
export const per1k = (perCall: number | null): string => (perCall === null ? "–" : usd(perCall * 1000));
export const plural = (count: number, one: string, many = `${one}s`): string => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

export const installCommand = "claude mcp add --transport http openmerit https://openmerit.ai/mcp";
