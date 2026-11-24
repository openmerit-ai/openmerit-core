// Each member's own Claude and ChatGPT subscriptions, which write a task's cases in place of
// OpenMerit's OpenRouter key on the runs that member starts. The sign-ins are the ones pi's own
// `/login` uses (pi-ai's anthropic and openai-codex OAuth), split across requests so that a web page
// can drive them:
// - Claude: an authorization-code sign-in with PKCE. The member opens claude.ai, signs in, and pastes
//   the code Anthropic shows (`code#state`), since the app has no redirect Anthropic accepts.
// - ChatGPT: a device code. The member enters the code at auth.openai.com/codex/device, and the page
//   asks the app to check until OpenAI says it was entered.
// Tokens are stored encrypted in the member's user actor and leave it only for a job's memory.
import { createHash, randomBytes } from "node:crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SubscriptionsConfig } from "./config.ts";
import type { Complete } from "../../openmerit-core/src/ranking/index.ts";

export type SubscriptionProvider = "claude" | "chatgpt";
export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = ["claude", "chatgpt"];
export const isSubscriptionProvider = (value: unknown): value is SubscriptionProvider => value === "claude" || value === "chatgpt";
/** Who writes a member's cases: OpenMerit's key, or one of the member's subscriptions. */
export type CaseWriter = "openmerit" | SubscriptionProvider;

export const PROVIDER_NAMES: Record<SubscriptionProvider, string> = { claude: "Claude", chatgpt: "ChatGPT" };
/** pi-ai's provider for each subscription. */
const PI_PROVIDER: Record<SubscriptionProvider, string> = { claude: "anthropic", chatgpt: "openai-codex" };

export interface SubscriptionCredential { access: string; refresh: string; expires: number; accountId?: string }

// The OAuth clients pi uses (pi-ai's auth/oauth/anthropic.ts and openai-codex.ts).
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_ACCOUNT_CLAIM = "https://api.openai.com/auth";
/** How long a ChatGPT device code may wait for the member. */
export const DEVICE_CODE_TTL_MS = 15 * 60_000;
/** How long a Claude sign-in may wait for its pasted code. */
export const CLAUDE_SIGN_IN_TTL_MS = 15 * 60_000;

type Fetch = typeof fetch;

async function tokens(response: Response, what: string): Promise<{ access: string; refresh: string; expires: number }> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what} failed (${response.status}): ${text.slice(0, 200) || response.statusText}`);
  let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try { data = JSON.parse(text) as typeof data; } catch { throw new Error(`${what} did not answer with JSON.`); }
  if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") throw new Error(`${what} answered without tokens.`);
  return { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000 };
}

/** The ChatGPT account a Codex access token is for; OpenAI's Codex API needs it. */
function chatgptAccount(access: string): string {
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = payload[CHATGPT_ACCOUNT_CLAIM]?.chatgpt_account_id;
    if (typeof id === "string" && id) return id;
  } catch { /* not a JWT */ }
  throw new Error("OpenAI's token names no ChatGPT account. Sign in with a ChatGPT Plus or Pro account.");
}

/** Starts a Claude sign-in: the page to open, and the PKCE verifier to keep until the member pastes the code. */
export function claudeSignIn(config: SubscriptionsConfig["claude"]): { url: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(config.authorizeUrl);
  for (const [key, value] of Object.entries({ code: "true", client_id: CLAUDE_CLIENT_ID, response_type: "code", redirect_uri: config.redirectUri, scope: CLAUDE_SCOPES, code_challenge: challenge, code_challenge_method: "S256", state: verifier })) url.searchParams.set(key, value);
  return { url: url.toString(), verifier };
}

/** Exchanges the code Anthropic showed (`code#state`, or the code alone) for tokens. */
export async function claudeExchange(config: SubscriptionsConfig["claude"], fetcher: Fetch, verifier: string, pasted: string): Promise<SubscriptionCredential> {
  const [code, state] = pasted.trim().split("#", 2);
  if (!code) throw new Error("Paste the code Anthropic shows after you sign in.");
  if (state && state !== verifier) throw new Error("This code is from another sign-in. Start again and paste the code it shows.");
  return tokens(await fetcher(config.tokenUrl, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ grant_type: "authorization_code", client_id: CLAUDE_CLIENT_ID, code, state: state ?? verifier, redirect_uri: config.redirectUri, code_verifier: verifier }),
  }), "Anthropic's sign-in");
}

export interface DeviceCode { deviceAuthId: string; userCode: string; intervalSeconds: number; verificationUri: string; expiresAt: number }

/** Starts a ChatGPT sign-in: the code the member enters at OpenAI. */
export async function chatgptDeviceCode(config: SubscriptionsConfig["chatgpt"], fetcher: Fetch): Promise<DeviceCode> {
  const response = await fetcher(`${config.authUrl}/api/accounts/deviceauth/usercode`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenAI did not start the sign-in (${response.status}). Try again in a moment.`);
  const data = await response.json() as { device_auth_id?: unknown; user_code?: unknown; interval?: unknown };
  const interval = Number(data.interval);
  if (typeof data.device_auth_id !== "string" || typeof data.user_code !== "string" || !Number.isFinite(interval)) throw new Error("OpenAI answered the sign-in without a code.");
  return { deviceAuthId: data.device_auth_id, userCode: data.user_code, intervalSeconds: Math.max(1, interval), verificationUri: `${config.authUrl}/codex/device`, expiresAt: Date.now() + DEVICE_CODE_TTL_MS };
}

export type DevicePoll = { status: "pending" } | { status: "failed"; error: string } | { status: "complete"; credential: SubscriptionCredential };

/** Asks OpenAI once whether the member entered the code, and exchanges it for tokens when they did. */
export async function chatgptPoll(config: SubscriptionsConfig["chatgpt"], fetcher: Fetch, device: DeviceCode): Promise<DevicePoll> {
  if (Date.now() > device.expiresAt) return { status: "failed", error: "The code expired before it was entered. Start again." };
  const response = await fetcher(`${config.authUrl}/api/accounts/deviceauth/token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }), signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  const text = await response.text();
  if (!response.ok) {
    const code = (() => { try { const error = (JSON.parse(text) as { error?: unknown }).error; return typeof error === "object" && error ? (error as { code?: unknown }).code : error; } catch { return null; } })();
    if (code === "deviceauth_authorization_pending" || code === "slow_down") return { status: "pending" };
    return { status: "failed", error: `OpenAI refused the sign-in (${response.status}). Start again.` };
  }
  const data = JSON.parse(text) as { authorization_code?: unknown; code_verifier?: unknown };
  if (typeof data.authorization_code !== "string" || typeof data.code_verifier !== "string") return { status: "failed", error: "OpenAI answered the sign-in without a code. Start again." };
  const issued = await tokens(await fetcher(`${config.authUrl}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: CHATGPT_CLIENT_ID, code: data.authorization_code, code_verifier: data.code_verifier, redirect_uri: `${config.authUrl}/deviceauth/callback` }),
  }), "OpenAI's sign-in");
  return { status: "complete", credential: { ...issued, accountId: chatgptAccount(issued.access) } };
}

/** New tokens for a subscription whose access token is about to expire. */
export async function refreshSubscription(provider: SubscriptionProvider, config: SubscriptionsConfig, fetcher: Fetch, credential: SubscriptionCredential): Promise<SubscriptionCredential> {
  if (provider === "claude") {
    return tokens(await fetcher(config.claude.tokenUrl, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ grant_type: "refresh_token", client_id: CLAUDE_CLIENT_ID, refresh_token: credential.refresh }),
    }), "Renewing the Claude sign-in");
  }
  const issued = await tokens(await fetcher(`${config.chatgpt.authUrl}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh, client_id: CHATGPT_CLIENT_ID }),
  }), "Renewing the ChatGPT sign-in");
  return { ...issued, accountId: chatgptAccount(issued.access) };
}

/**
 * A case writer on the member's subscription, through pi-ai, which sends each request as Claude Code
 * or Codex does. Its calls are billed by the member's plan, so they enter no ledger.
 */
export async function subscriptionWriter(provider: SubscriptionProvider, credential: SubscriptionCredential, config: SubscriptionsConfig, signal?: AbortSignal): Promise<{ complete: Complete; model: string }> {
  const piProvider = PI_PROVIDER[provider];
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(piProvider, async () => ({ type: "oauth", ...credential }));
  const models = builtinModels({ credentials });
  const settings = config[provider];
  const found = models.getModel(piProvider, settings.model);
  if (!found) throw new Error(`${PROVIDER_NAMES[provider]} has no model ${settings.model}.`);
  const model = settings.apiUrl ? { ...found, baseUrl: settings.apiUrl } : found;
  const complete: Complete = async ({ system, prompt }) => {
    const reply = await models.complete(model, { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { maxTokens: 8192, ...(signal ? { signal } : {}) });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`${PROVIDER_NAMES[provider]} (${settings.model}) failed: ${(reply.errorMessage ?? reply.stopReason).slice(0, 200)}`);
    return reply.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
  };
  return { complete, model: settings.model };
}
