import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEYLEN = 64;
const N = 2 ** 15;
const R = 8;
const P = 1;

export function hashPassword(password: string): string {
  if (password.length < 12 || password.length > 128) throw new Error("Password must be 12-128 characters");
  const salt = randomBytes(16).toString("base64url");
  const derived = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, n, r, p, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !salt || !expected) return false;
  try {
    const actual = scryptSync(password, salt, KEYLEN, { N: Number(n), r: Number(r), p: Number(p) });
    const target = Buffer.from(expected, "base64url");
    return target.length === actual.length && timingSafeEqual(target, actual);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- async variants (use these in request handlers)
// scryptSync blocks the event loop for ~100 ms per call: under a burst of logins that stalls every tenant.
const MAXMEM = 128 * 1024 * 1024;

function scryptAsync(password: string, salt: string, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPasswordAsync(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128) throw new Error("Password must be 12-128 characters");
  const salt = randomBytes(16).toString("base64url");
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPasswordAsync(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !salt || !expected) return false;
  // Never let a tampered hash make us allocate unbounded memory.
  if (Number(n) > 2 ** 16 || Number(r) > 16 || Number(p) > 4) return false;
  try {
    const actual = await scryptAsync(password, salt, KEYLEN, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
    const target = Buffer.from(expected, "base64url");
    return target.length === actual.length && timingSafeEqual(target, actual);
  } catch {
    return false;
  }
}

/** A real hash of a random value, used to spend the same time when the email is unknown (no timing oracle). */
let dummy: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPasswordAsync(randomBytes(24).toString("base64url"));
  return dummy;
}
