/**
 * Rolling conversation summary (spec section 7: recent messages + summary + relevant tool results).
 *
 * The model only ever sees the last `historyLimit` messages. What the customer asked before that is
 * condensed here into a short digest of THEIR OWN earlier questions. It is built by code, not by a second
 * model call: no extra AI cost, no risk of a summariser inventing a price, and nothing the assistant said
 * is carried forward as if it were a fact (facts always come from the tools in the current turn).
 */
export const MAX_SUMMARY_QUESTIONS = 8;
const MAX_QUESTION_CHARS = 140;
const MAX_SUMMARY_CHARS = 1200;

interface SummarySource {
  role: "user" | "assistant" | "tool";
  content: string;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUESTION_CHARS ? `${flat.slice(0, MAX_QUESTION_CHARS - 1)}…` : flat;
}

/**
 * `messages` is the whole window fetched for this conversation (oldest first); the last `keepRecent`
 * of them are replayed verbatim to the model, so only the older ones are summarised.
 * Returns undefined while everything still fits in the verbatim window.
 */
export function buildSummary(messages: readonly SummarySource[], keepRecent: number): string | undefined {
  const older = messages.slice(0, Math.max(0, messages.length - keepRecent));
  const questions = older
    .filter((m) => m.role === "user")
    .map((m) => oneLine(m.content))
    .filter((q) => q.length > 0)
    .slice(-MAX_SUMMARY_QUESTIONS);
  if (questions.length === 0) return undefined;
  return questions.map((q) => `- ${q}`).join("\n").slice(0, MAX_SUMMARY_CHARS);
}
