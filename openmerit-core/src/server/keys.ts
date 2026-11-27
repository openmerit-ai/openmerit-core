// Customer endpoint keys: AES-256-GCM with the app's key, so actor storage holds only ciphertext.
// The account ID is the additional authenticated data, so a ciphertext copied into another
// account does not decrypt there.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isIP } from "node:net";

const VERSION = "v1";

export function encryptKey(key: Buffer, accountId: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(accountId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptKey(key: Buffer, accountId: string, sealed: string): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined) throw new Error("Unknown key format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(accountId));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * Why a customer endpoint URL is refused, or null. Only https:// on a public host name or address:
 * the app calls it with the customer's key from inside Rivet Cloud. Resolving names to private
 * addresses is not checked here; the node's egress rules must cover that.
 */
export function endpointUrlProblem(value: string, allowPrivate = false): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return "baseUrl is not a URL"; }
  if (url.username || url.password) return "baseUrl must not contain credentials; send the key as apiKey";
  if (allowPrivate) return url.protocol === "https:" || url.protocol === "http:" ? null : "baseUrl must be http(s)";
  if (url.protocol !== "https:") return "baseUrl must use https://";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "baseUrl must be a public host";
  if (isIP(host) === 4 && PRIVATE_V4.some(pattern => pattern.test(host))) return "baseUrl must be a public address";
  if (isIP(host) === 6 && (host === "::1" || /^(fc|fd|fe80)/.test(host) || host.startsWith("::ffff:"))) return "baseUrl must be a public address";
  return null;
}
