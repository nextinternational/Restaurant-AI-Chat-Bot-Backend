/**
 * Deterministic guards that run AFTER the model. The model is never the last line of defence for
 * prices, allergens or "how do I reach the restaurant": code decides.
 */

const HUMAN =
  /\b(human|real person|live agent|live person|customer service rep\w*|representative|speak (to|with) (a |an |the )?(person|someone|somebody|staff|manager|owner|agent)|talk (to|with) (a |an |the )?(person|someone|somebody|staff|manager|owner|agent))\b|موظف|شخص حقيقي|أكلم (شخص|مدير|أحد)|اتكلم مع (شخص|مدير|موظف)/i;

export function wantsHuman(text: string): boolean {
  return HUMAN.test(text);
}

const PHONE =
  /\b(phone|telephone|mobile number|cell(?:phone)? number|contact (?:number|details|info\w*)|(?:your|the restaurant'?s?) (?:number|phone)|what'?s your number|what is your number|(?:can|could|may) (?:i|we) (?:call|phone|ring)|how (?:can|do|could) (?:i|we) (?:call|contact|reach)|(?:call|phone|ring) (?:you|us|the restaurant))\b|رقم (?:الهاتف|التلفون|الجوال|المطعم|التواصل)|رقمكم|هاتف|تلفون|اتصل/i;

/** The customer asks for the restaurant's phone number or how to call. */
export function asksForPhoneNumber(text: string): boolean {
  return PHONE.test(text);
}

const ALLERGY =
  /\b(allerg\w*|anaphyla\w*|celiac|coeliac|gluten|peanuts?|nuts?|tree nuts?|dairy|lactose|shellfish|crustaceans?|molluscs?|sesame|soy|soya|eggs?|mustard|celery|lupin|sulphites?|sulfites?|intoleran\w*|cross[- ]contamination|epipen)\b|حساسية|مكسرات|جلوتين|غلوتين|فول سوداني|لاكتوز|قشريات|سمسم/i;

export function mentionsAllergy(text: string): boolean {
  return ALLERGY.test(text);
}

/**
 * Dietary and religious labels (halal, vegan, ...). These are claims people act on for reasons of faith or
 * health, so the assistant may only repeat a label that a menu tool returned for a dish (staff-entered
 * `dietaryTags`). No `\\b` next to Arabic: it is ASCII-only in JavaScript.
 */
const DIETARY_TERMS: readonly { tag: string; re: RegExp }[] = [
  { tag: "halal", re: /\bhalal\b|\bharam\b|حلال|حرام/i },
  { tag: "kosher", re: /\bkosher\b|كوشر/i },
  { tag: "vegan", re: /\bvegan\b|\bplant[- ]based\b|نباتي صرف|فيغان|فيجن/i },
  { tag: "vegetarian", re: /\bvegetarian\b|نباتي|نباتية/i },
  { tag: "gluten_free", re: /gluten[- ]free|خالي من الجلوتين|خالي من الغلوتين/i },
  { tag: "dairy_free", re: /(?:dairy|lactose)[- ]free|خالي من الألبان|خالي من اللاكتوز/i },
];

/** Dietary labels written in `text`, as the tag names used by the menu (`halal`, `vegan`, ...). */
export function dietaryTermsIn(text: string): string[] {
  return DIETARY_TERMS.filter(({ re }) => re.test(text)).map(({ tag }) => tag);
}

const SENSITIVE_INGREDIENT = /\b(?:pork|bacon|ham|lard|gelatin\w*|alcohol\w*)\b|خنزير|كحول|جيلاتين|لارد|بيكون/gi;

/** Pork, alcohol, gelatin and similar: no tag exists for them, so any claim must be backed by tool text. */
export function sensitiveIngredientsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(SENSITIVE_INGREDIENT)) found.add(m[0].toLowerCase());
  return [...found];
}

// Deliberately specific: "hot dogs" and "my kids love the salmon, how much is it?" are NOT policy questions.
// Several small patterns instead of one big one: each stays easy to read and cheap to match.
const POLICY_TOPICS: readonly RegExp[] = [
  // money and commitments
  /\b(?:cancel\w*|refund\w*|corkage|service charge|gratuity|tipping|cash only|(?:credit|debit) cards?|split (?:the |our )?bill)\b/i,
  // how the restaurant operates
  /\b(?:dress ?code|attire|parking|valet|deliver\w*|take-?away|take-?out|private (?:events?|parties|party|dining|rooms?))\b/i,
  /\bbring (?:my |our )?own (?:wine|bottles?|drinks?|cake)\b/i,
  // access
  /\b(?:wheelchairs?|accessib\w*|step-?free|high ?chairs?)\b/i,
  // children and pets, only in policy-shaped phrases
  /\b(?:kid|child|family|pet|dog)[- ]friendly\b/i,
  /\b(?:kids?|child(?:ren)?|babies|baby|toddlers?)(?:'s)? (?:menu|policy|allowed|welcome)\b/i,
  /\b(?:are|can|do|may) (?:kids?|child(?:ren)?|babies|toddlers?) /i,
  /\b(?:bring|take|come with|with) (?:my |our |the |a )?(?:kids?|child(?:ren)?|babies|baby|toddlers?|pets?|dogs?|puppy)\b/i,
  /\b(?:pets?|dogs?)(?:'s)? (?:allowed|welcome|policy)\b|\b(?:allow|allowed) (?:pets?|dogs?)\b/i,
  // Arabic
  /إلغاء|الغاء|استرداد|استرجاع|لباس|زي رسمي|أطفال|اطفال|حيوانات|كلاب|بطاقة|فيزا|كاش|توصيل|سفري|تيك أواي|مواقف|موقف سيارات|باركينغ|كرسي متحرك|كراسي متحركة|ذوي الاحتياجات|مناسبة خاصة|حفلة خاصة|رسوم الخدمة|بقشيش/,
];

/**
 * Topics where a wrong answer costs money or trust (cancellation, refunds, children, pets, payment, delivery, ...).
 * An answer about them is only allowed when a knowledge tool returned published content in the same turn.
 */
export function mentionsPolicyTopic(text: string): boolean {
  return POLICY_TOPICS.some((re) => re.test(text));
}

const PREFIX_AMOUNT = /(?:USD|XCD|EUR|GBP|CAD|[$€£])\s?(\d[\d,.]*)/gi;
const SUFFIX_AMOUNT = /(\d[\d,.]*)\s?(?:USD|XCD|EUR|GBP|CAD|dollars?|bucks)\b/gi;
// Arabic currency words. No `\b`: it is ASCII-only in JavaScript and never matches next to Arabic letters.
const AR_CURRENCY = "دولار|دولارا|دولارات|ريال|ريالات|درهم|دراهم|دينار|دنانير|جنيه";
const AR_SUFFIX_AMOUNT = new RegExp(`(\\d[\\d,.]*)\\s?(?:${AR_CURRENCY})`, "g");
const AR_PREFIX_AMOUNT = new RegExp(`(?:${AR_CURRENCY})\\s?(\\d[\\d,.]*)`, "g");

/**
 * Arabic-Indic (U+0660-0669) and Persian (U+06F0-06F9) digits, and the Arabic decimal/thousands separators,
 * become ASCII first. Otherwise a price the model writes in Arabic numerals ("٣٨ دولار") is invisible to the
 * price guard and an invented price would reach the customer.
 */
export function normalizeDigits(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",");
}

function toCents(token: string): number | null {
  const n = Number(token.replace(/[,.]+$/, "").replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Every money amount written in `text`, in integer cents. */
export function extractAmountsCents(text: string): number[] {
  const out: number[] = [];
  const normalized = normalizeDigits(text);
  for (const re of [PREFIX_AMOUNT, SUFFIX_AMOUNT, AR_SUFFIX_AMOUNT, AR_PREFIX_AMOUNT]) {
    for (const m of normalized.matchAll(re)) {
      const cents = toCents(m[1] ?? "");
      if (cents !== null) out.push(cents);
    }
  }
  return out;
}

/** Amounts in the answer that no tool returned this turn. Any entry means the price was not grounded. */
export function ungroundedAmounts(answer: string, allowedCents: ReadonlySet<number>): number[] {
  return extractAmountsCents(answer).filter((c) => !allowedCents.has(c));
}

/** Strip control characters and collapse whitespace so odd input cannot break prompts or logs. */
export function cleanCustomerText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[ \t]+/g, " ").trim();
}
