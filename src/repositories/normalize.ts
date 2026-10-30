/** Lower-case, strip accents and punctuation so "Grilled  Salmon!" matches "grilled salmon". */
export function normalizeName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
