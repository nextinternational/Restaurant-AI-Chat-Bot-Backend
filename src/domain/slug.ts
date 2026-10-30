import { randomBytes } from "node:crypto";

/** ASCII slug from a display name. Non-Latin names (e.g. Arabic) yield an empty base, handled by the caller. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** Always unique in practice: the random suffix removes the need for check-then-insert races. */
export function restaurantSlug(name: string): string {
  return `${slugify(name) || "restaurant"}-${randomBytes(4).toString("hex")}`;
}

/** Accepts only a bare origin (scheme + host [+ port]). https always; http only for localhost outside production. */
export function normalizeOrigin(raw: string, allowInsecureLocalhost: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (url.hostname.includes("*")) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" && (url.hostname.includes(".") || local)) return url.origin;
  if (url.protocol === "http:" && local && allowInsecureLocalhost) return url.origin;
  return null;
}
