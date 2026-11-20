// The app's configuration, read once from the environment at startup. Every secret is optional so
// the app starts without it; the feature that needs it answers 503 until it is set.
export type Env = Record<string, string | undefined>;

export interface ClerkConfig {
  secretKey: string;
  publishableKey: string;
  /** Clerk's Frontend API, the OAuth issuer, such as https://clerk.openmerit.ai. */
  issuer: string;
  /** The audience every MCP access token must name: the MCP server resource registered in Clerk. */
  audience: string;
  /** Origins whose Clerk session tokens /api accepts. */
  authorizedParties: string[];
  /** Clerk's PEM public key, which verifies session tokens without fetching the JWKS. */
  jwtKey?: string;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** The subscription price Checkout sells. */
  priceId: string;
  /** The Billing Meter event name that evaluations beyond the plan are reported to. */
  meterEvent: string;
  apiBase: string;
}

export interface Limits {
  jobsPerHour: number;
  concurrentJobs: number;
  /** Per-job cap on all spend, when the guardrails set none. */
  defaultJobBudgetUsd: number;
  /** Monthly cap on OpenMerit-paid spend, when the plan sets none. */
  monthlyCapUsd: number;
  /** Monthly cap on customer-paid spend, when the customer set none. */
  customerCapUsd: number;
}

/** Where analytics events go (analytics.ts). */
export interface PostHogConfig { token: string; host: string }

export interface Config {
  port: number;
  /** Where openmerit.ai's router sends /mcp and /api: the base of every URL the app writes. */
  publicUrl: string;
  /** The web app, app.openmerit.ai: report pages, billing and keys. */
  appUrl: string;
  clerk: ClerkConfig | null;
  stripe: StripeConfig | null;
  openrouter: { baseUrl: string; apiKey: string | null };
  /** AES-256 key that encrypts customer endpoint keys at rest. */
  keyEncryptionKey: Buffer | null;
  /** Lets customer endpoints use http:// and private hosts. Tests only. */
  allowPrivateEndpoints: boolean;
  limits: Limits;
  /** Models on OpenMerit's OpenRouter key that write a task's cases and judge text answers. */
  models: { caseWriter: string; judge: string };
  /** How often a watched task checks the catalogue. */
  watchIntervalMs: number;
  /** A task with no openmerit_recommend call for this long is idle: its watch pauses until the next call. */
  idleAfterMs: number;
  /** Null without POSTHOG_PROJECT_TOKEN: no event is sent. */
  posthog: PostHogConfig | null;
  /** Viktor's API, and how often a Viktor job reads its test runs' progress. Tests point it at a fake. */
  viktor: { baseUrl: string; pollMs: number; staleMs: number };
  /** A connection's background re-list: every `intervalMs`, and at most every `backoffMs` after repeated failures. */
  relist: { intervalMs: number; backoffMs: number };
}

const number = (value: string | undefined, fallback: number) => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

/** The Frontend API host a Clerk publishable key encodes: `pk_live_<base64("clerk.openmerit.ai$")>`. */
export function clerkIssuer(publishableKey: string): string {
  const encoded = publishableKey.split("_")[2] ?? "";
  const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("CLERK_PUBLISHABLE_KEY is not a Clerk publishable key");
  return `https://${host}`;
}

export function loadConfig(env: Env = process.env): Config {
  const publicUrl = (env.OPENMERIT_PUBLIC_URL ?? "https://openmerit.ai").replace(/\/$/, "");
  const appUrl = (env.OPENMERIT_APP_URL ?? "https://app.openmerit.ai").replace(/\/$/, "");
  const clerk = env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY ? {
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    issuer: clerkIssuer(env.CLERK_PUBLISHABLE_KEY),
    audience: env.OPENMERIT_MCP_AUDIENCE || `${publicUrl}/mcp`,
    authorizedParties: [appUrl, ...(env.OPENMERIT_EXTRA_ORIGINS?.split(",").map(item => item.trim()).filter(Boolean) ?? [])],
    ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}),
  } : null;
  const stripe = env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_ID ? {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    priceId: env.STRIPE_PRICE_ID,
    meterEvent: env.STRIPE_METER_EVENT ?? "openmerit_evaluation",
    apiBase: (env.STRIPE_API_BASE ?? "https://api.stripe.com").replace(/\/$/, ""),
  } : null;
  const keyEncryptionKey = env.OPENMERIT_KEY_ENCRYPTION_KEY ? Buffer.from(env.OPENMERIT_KEY_ENCRYPTION_KEY, "base64") : null;
  if (keyEncryptionKey && keyEncryptionKey.length !== 32) throw new Error("OPENMERIT_KEY_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return {
    port: number(env.PORT ?? env.RIVET_PORT, 8080),
    publicUrl, appUrl, clerk, stripe, keyEncryptionKey,
    openrouter: { baseUrl: (env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, ""), apiKey: env.OPENROUTER_API_KEY || null },
    allowPrivateEndpoints: env.OPENMERIT_ALLOW_PRIVATE_ENDPOINTS === "1",
    limits: {
      jobsPerHour: number(env.OPENMERIT_JOBS_PER_HOUR, 20),
      concurrentJobs: number(env.OPENMERIT_CONCURRENT_JOBS, 3),
      defaultJobBudgetUsd: number(env.OPENMERIT_JOB_BUDGET_USD, 5),
      monthlyCapUsd: number(env.OPENMERIT_MONTHLY_CAP_USD, 100),
      customerCapUsd: number(env.OPENMERIT_CUSTOMER_CAP_USD, 100),
    },
    models: { caseWriter: env.OPENMERIT_CASE_WRITER_MODEL || "anthropic/claude-sonnet-5.5", judge: env.OPENMERIT_JUDGE_MODEL || "anthropic/claude-sonnet-5.5" },
    watchIntervalMs: number(env.OPENMERIT_WATCH_INTERVAL_MS, 24 * 60 * 60 * 1000),
    idleAfterMs: number(env.OPENMERIT_IDLE_DAYS, 30) * 24 * 60 * 60 * 1000,
    viktor: { baseUrl: (env.OPENMERIT_VIKTOR_URL || "https://api.viktor.com").replace(/\/$/, ""), pollMs: number(env.OPENMERIT_VIKTOR_POLL_MS, 20_000), staleMs: number(env.OPENMERIT_VIKTOR_STALE_MS, 120_000) },
    relist: { intervalMs: number(env.OPENMERIT_RELIST_MS, 900_000), backoffMs: number(env.OPENMERIT_RELIST_BACKOFF_MS, 3_600_000) },
    posthog: env.POSTHOG_PROJECT_TOKEN ? { token: env.POSTHOG_PROJECT_TOKEN, host: (env.POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "") } : null,
  };
}
