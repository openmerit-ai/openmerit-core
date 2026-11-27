// Who is calling. /mcp takes Clerk OAuth access tokens, issued by Clerk's OAuth for MCP to the
// coding agent; /api takes Clerk session tokens from app.openmerit.ai. Either maps to a user and a
// Clerk organization, and the organization is the account. A token without an organization is
// refused with a clear error: the app never guesses an account.
import { createClerkClient, verifyToken } from "@clerk/backend";
import { verifyMachineAuthToken } from "@clerk/backend/internal";
import { decodeJwt } from "@clerk/backend/jwt";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClerkConfig } from "./config.ts";

export type Role = "admin" | "member";

export interface Identity {
  userId: string;
  /** The Clerk organization ID. */
  accountId: string;
  accountName: string | null;
  role: Role;
  /** When the token was issued, in Unix seconds; null when it does not say. */
  issuedAt: number | null;
  /** Minutes since the session last verified a first factor, from a Clerk session token's `fva` claim; null when it does not say or never did. */
  firstFactorAgeMinutes: number | null;
  /** A person signed in to the web app, not a coding agent or a script with a token: only a person confirms a critical request. */
  person: boolean;
}

export type AuthResult = { ok: true; identity: Identity } | { ok: false; status: 401 | 403; error: string };

export interface Auth {
  mcp(request: Request): Promise<AuthResult>;
  api(request: Request): Promise<AuthResult>;
  /** The user's primary email address, which no token carries; null when it cannot be found. */
  email(userId: string): Promise<string | null>;
  /** The user's name and primary email address, which no token carries; null when Clerk cannot be reached or has no such user. */
  person(userId: string): Promise<{ name: string | null; email: string | null } | null>;
  /**
   * The user's GitHub access token from their GitHub sign-in in Clerk, which Clerk renews when it expires; null
   * when they have none. With Clerk's GitHub connection set up as the OpenMerit GitHub App, it reaches only the
   * repositories that both the user and an installation of the app reach, with the app's read-only permissions.
   */
  githubToken(userId: string): Promise<string | null>;
}

export const NO_ORGANIZATION = "This token names no Clerk organization. OpenMerit accounts are organizations: sign in again and choose an organization, or create one at app.openmerit.ai.";

export function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

type Claims = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** The organization in a Clerk token's claims: `o` in session tokens v2, `org_*` in v1 and OAuth tokens. */
export function organization(claims: Claims): { id: string; name: string | null; role: Role } | null {
  const o = claims.o && typeof claims.o === "object" ? claims.o as Claims : {};
  const id = text(o.id) ?? text(claims.org_id);
  if (!id) return null;
  const role = text(o.rol) ?? text(claims.org_role);
  return { id, name: text(o.slg) ?? text(claims.org_slug) ?? text(claims.org_name), role: role === "admin" || role === "org:admin" ? "admin" : "member" };
}

function identity(userId: string | null, claims: Claims, person: boolean): AuthResult {
  if (!userId) return { ok: false, status: 401, error: "The token names no user." };
  const org = organization(claims);
  if (!org) return { ok: false, status: 403, error: NO_ORGANIZATION };
  // fva is [first-factor age, second-factor age] in minutes, -1 for never.
  const age = Array.isArray(claims.fva) && typeof claims.fva[0] === "number" && claims.fva[0] >= 0 ? claims.fva[0] : null;
  return { ok: true, identity: { userId, accountId: org.id, accountName: org.name, role: org.role, issuedAt: typeof claims.iat === "number" ? claims.iat : null, firstFactorAgeMinutes: age, person } };
}

const unauthenticated = (error: string): AuthResult => ({ ok: false, status: 401, error });

export class ClerkAuth implements Auth {
  private readonly config: ClerkConfig;
  /** Organizations' display names by ID, kept an hour: tokens carry only the slug. */
  private readonly names = new Map<string, { name: string | null; at: number }>();
  constructor(config: ClerkConfig) { this.config = config; }

  /** The identity with its organization's display name from Clerk in place of the token's slug; the slug when Clerk cannot say. */
  private async named(result: AuthResult): Promise<AuthResult> {
    if (!result.ok) return result;
    const id = result.identity.accountId;
    let cached = this.names.get(id);
    if (!cached || Date.now() - cached.at > 3_600_000) {
      const name = await createClerkClient({ secretKey: this.config.secretKey }).organizations.getOrganization({ organizationId: id }).then(org => org.name || null, () => null);
      cached = { name: name ?? cached?.name ?? null, at: Date.now() };
      this.names.set(id, cached);
    }
    return cached.name ? { ok: true, identity: { ...result.identity, accountName: cached.name } } : result;
  }

  async mcp(request: Request): Promise<AuthResult> {
    const token = bearer(request);
    if (!token) return unauthenticated("Sign in to OpenMerit: this request has no access token.");
    let verified;
    try { verified = await verifyMachineAuthToken(token, { secretKey: this.config.secretKey, audience: this.config.audience }); }
    catch { return unauthenticated("The access token is not a Clerk OAuth token."); }
    if (verified.errors || verified.tokenType !== "oauth_token") return unauthenticated(`The access token was refused: ${verified.errors?.[0]?.message ?? "not an OAuth token"}`);
    // Clerk checked the signature, the expiry and the audience. Opaque `oat_` tokens carry no claims, so no organization.
    let claims: Claims = {};
    try { claims = decodeJwt(token).payload as unknown as Claims; } catch { /* opaque token */ }
    return this.named(identity(verified.data && "subject" in verified.data ? verified.data.subject : null, claims, false));
  }

  async email(userId: string): Promise<string | null> {
    return (await this.person(userId))?.email ?? null;
  }

  async person(userId: string): Promise<{ name: string | null; email: string | null } | null> {
    try {
      const user = await createClerkClient({ secretKey: this.config.secretKey }).users.getUser(userId);
      return { name: user.fullName || user.username || null, email: user.primaryEmailAddress?.emailAddress ?? null };
    } catch { return null; }
  }

  async githubToken(userId: string): Promise<string | null> {
    // Clerk answers an error, not an empty list, for a user with no GitHub account.
    try {
      const tokens = await createClerkClient({ secretKey: this.config.secretKey }).users.getUserOauthAccessToken(userId, "github");
      return tokens.data[0]?.token || null;
    } catch { return null; }
  }

  async api(request: Request): Promise<AuthResult> {
    const token = bearer(request);
    if (!token) return unauthenticated("Sign in to OpenMerit: this request has no session token.");
    // verifyToken returns the token's claims and throws when it refuses the token: a bad signature, an expired token or another `azp`.
    let claims: Claims;
    try {
      claims = await verifyToken(token, { secretKey: this.config.secretKey, authorizedParties: this.config.authorizedParties, ...(this.config.jwtKey ? { jwtKey: this.config.jwtKey } : {}) });
    } catch { return unauthenticated("The session token was refused."); }
    return this.named(identity(text(claims.sub), claims, true));
  }
}

/** The self-hosted server's one person and account. */
export const LOCAL_USER = "local";

/** How long a sign-in link works, and how long the browser session it opens lasts. */
const LINK_MS = 10 * 60_000, SESSION_MS = 30 * 24 * 3_600_000;
/** The browser session's cookie. */
export const SESSION_COOKIE = "om_session";
const digest = (text: string) => createHash("sha256").update(text).digest();
const cookie = (request: Request, name: string) => (request.headers.get("cookie") ?? "").split(/;\s*/).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;

/**
 * Self-hosted sign-in for one person, the admin of the one account. The server's local token, sent as
 * `Authorization: Bearer`, is what the coding agent, the CLI and scripts use, on /mcp and /api. The web
 * app uses a browser session instead, opened by a one-time sign-in link that `openmerit server start`
 * prints; only that session is the person, who confirms what a coding agent asks for. Sessions live in
 * memory, so a restarted server needs a new link. No other user exists, so no email or name is known.
 */
export class LocalAuth implements Auth {
  private readonly digest: Buffer;
  /** Where the token is, for the refusal: the token file's path. */
  private readonly where: string;
  /** Unused sign-in links' codes and open sessions, by their SHA-256 in hex, with when each ends. */
  private readonly links = new Map<string, number>();
  private readonly sessions = new Map<string, number>();
  constructor(token: string, where: string) { this.digest = digest(token); this.where = where; }

  private local(person: boolean): AuthResult {
    return { ok: true, identity: { userId: LOCAL_USER, accountId: LOCAL_USER, accountName: "Local", role: "admin", issuedAt: null, firstFactorAgeMinutes: null, person } };
  }
  private check(request: Request): AuthResult {
    const token = bearer(request);
    if (!token) return unauthenticated(`Sign in to this OpenMerit server: send its token, in ${this.where}, as \`Authorization: Bearer <token>\`.`);
    // Compare digests, which are always the same length, so the comparison takes the same time for any token.
    if (!timingSafeEqual(digest(token), this.digest)) return unauthenticated(`This is not this OpenMerit server's token, which is in ${this.where}.`);
    return this.local(false);
  }
  async mcp(request: Request) { return this.check(request); }
  async api(request: Request) {
    const session = cookie(request, SESSION_COOKIE);
    if (!session || bearer(request)) return this.check(request);
    const ends = this.sessions.get(digest(session).toString("hex"));
    if (!ends || ends < Date.now()) return unauthenticated("Your sign-in to this OpenMerit server ended: run `openmerit server link` for a new sign-in link.");
    return this.local(true);
  }
  async email(): Promise<string | null> { return null; }
  async person(): Promise<{ name: string | null; email: string | null } | null> { return null; }
  /** A self-hosted server has no GitHub sign-in: public repositories and fine-grained tokens only. */
  async githubToken(): Promise<string | null> { return null; }

  /** A new one-time sign-in code for the web app, which works for ten minutes. */
  link(): string {
    const code = randomBytes(24).toString("base64url");
    this.links.set(digest(code).toString("hex"), Date.now() + LINK_MS);
    return code;
  }
  /** Spends a sign-in code and opens a browser session; null when the code is unknown, used or expired. */
  signIn(code: string): { session: string; maxAgeSeconds: number } | null {
    const key = digest(code).toString("hex"), ends = this.links.get(key);
    this.links.delete(key);
    if (!ends || ends < Date.now()) return null;
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(digest(session).toString("hex"), Date.now() + SESSION_MS);
    return { session, maxAgeSeconds: SESSION_MS / 1000 };
  }
  signOut(request: Request): void {
    const session = cookie(request, SESSION_COOKIE);
    if (session) this.sessions.delete(digest(session).toString("hex"));
  }
}

/**
 * The self-hosted server's key-encryption key: `<dataDir>/key`, 32 random bytes written on first start,
 * readable only by its owner. It encrypts endpoint keys and held confirmations, so it must outlive
 * restarts: a new key could not open what the old one sealed.
 */
export function localKey(dataDir: string): Buffer {
  const file = join(dataDir, "key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  return key;
}

/** The self-hosted server's token: `<dataDir>/token`, written with a new random token on first start, readable only by its owner. */
export function localToken(dataDir: string): { token: string; file: string } {
  const file = join(dataDir, "token");
  if (existsSync(file)) return { token: readFileSync(file, "utf8").trim(), file };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = `omt_${randomBytes(24).toString("base64url")}`;
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  return { token, file };
}

/**
 * Authentication for tests: the token `test:<user>:<organization>[:admin[:<minutes>]]` names its caller,
 * with its first-factor verification that many minutes ago (default 0), and `test:<user>` names a user
 * without an organization. Never used outside tests.
 */
export class TestAuth implements Auth {
  private parse(request: Request, person: boolean): AuthResult {
    const token = bearer(request);
    if (!token?.startsWith("test:")) return unauthenticated("Sign in to OpenMerit: this request has no access token.");
    const [, user, org, role, minutes] = token.split(":");
    return identity(user ?? null, { ...(org ? { org_id: org, org_slug: org, org_role: role === "admin" ? "org:admin" : "org:member" } : {}), iat: Math.floor(Date.now() / 1000), fva: [Number(minutes ?? 0), -1] }, person);
  }
  async mcp(request: Request) { return this.parse(request, false); }
  async api(request: Request) { return this.parse(request, true); }
  async email(): Promise<string | null> { return null; }
  /** Users named `user_<x>` are "User <x>"; Clerk has no other user. */
  async person(userId: string): Promise<{ name: string | null; email: string | null } | null> {
    const name = /^user_(\w+)$/.exec(userId)?.[1];
    return name ? { name: `User ${name.toUpperCase()}`, email: `${name}@example.test` } : null;
  }
  /** The users signed in with GitHub, and their tokens: a JSON object in the file TEST_GITHUB_TOKENS names, read on each call so a test can unlink one. */
  async githubToken(userId: string): Promise<string | null> {
    const file = process.env.TEST_GITHUB_TOKENS;
    if (!file || !existsSync(file)) return null;
    return (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)[userId] ?? null;
  }
}
