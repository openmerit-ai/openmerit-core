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
// A coding agent's name and logo from the MCP client name it connects with, such as claude-code.
// A name that matches none is a custom harness, shown as it named itself.
const HARNESSES: [RegExp, string, string | null][] = [
  [/claude/, "Claude Code", "claude-code"], [/codex/, "Codex", "codex"], [/^pi\b|pi-coding|\bpi$/, "Pi", "pi"], [/cursor/, "Cursor", "cursor"],
  [/opencode/, "OpenCode", "opencode"], [/gemini/, "Gemini CLI", "geminicli"], [/^amp\b/, "Amp", "amp"], [/goose/, "Goose", "goose"], [/cline/, "Cline", "cline"],
  [/roo/, "Roo Code", "roocode"], [/kilo/, "Kilo Code", "kilocode"], [/windsurf/, "Windsurf", "windsurf"], [/copilot|vscode|visual studio code/, "GitHub Copilot", "githubcopilot"],
];
export function harness(client: string): { name: string; logo: string | null; custom: boolean } {
  const found = HARNESSES.find(([pattern]) => pattern.test(client.toLowerCase()));
  return found ? { name: found[1], logo: found[2], custom: false } : { name: client, logo: null, custom: true };
}

// An endpoint's provider, from its base URL.
const PROVIDERS: [RegExp, string, string | null][] = [
  [/openrouter\.ai/, "OpenRouter", "openrouter"], [/api\.openai\.com/, "OpenAI", "openai"], [/anthropic\.com/, "Anthropic", "anthropic"], [/fireworks\.ai/, "Fireworks", "fireworks"],
  [/groq\.com/, "Groq", "groq"], [/mistral\.ai/, "Mistral", "mistral"], [/together\.(ai|xyz)/, "Together", "together"], [/baseten\.co/, "Baseten", "baseten"],
  [/deepinfra\.com/, "DeepInfra", "deepinfra"], [/cerebras\.ai/, "Cerebras", "cerebras"], [/deepseek\.com/, "DeepSeek", "deepseek"], [/x\.ai\b/, "xAI", "xai"],
  [/googleapis\.com|generativelanguage/, "Google", "gemini"], [/azure/, "Azure", "azure"], [/bedrock|amazonaws\.com/, "Bedrock", "bedrock"],
  [/cloudflare|workers\.dev/, "Workers AI", "workersai"], [/moonshot/, "Moonshot", "kimi"], [/localhost|127\.0\.0\.1|ollama/, "Ollama", "ollama"],
];
export function provider(baseUrl: string): { name: string; logo: string | null } {
  const found = PROVIDERS.find(([pattern]) => pattern.test(baseUrl.toLowerCase()));
  if (found) return { name: found[1], logo: found[2] };
  let host = baseUrl;
  try { host = new URL(baseUrl).hostname; } catch { /* keep the text as given */ }
  return { name: host, logo: null };
}

// The customer's endpoints, which the run page loads so a report's endpoint IDs show their provider.
let endpointUrls: ReadonlyMap<string, string> = new Map();
export const setEndpoints = (list: readonly { id: string; baseUrl: string }[]): void => { endpointUrls = new Map(list.map((item) => [item.id, item.baseUrl])); };
export function endpointName(id: string): Html {
  if (id === "openrouter") return html`${logo("openrouter")}OpenRouter`;
  const url = endpointUrls.get(id);
  if (!url) return html`${id}`;
  const found = provider(url);
  return html`${logo(found.logo)}${found.name}`;
}

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
