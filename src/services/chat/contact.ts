import type { ContactReason } from "../../ai/prompt.js";

/**
 * What a customer is told when the assistant cannot (or must not) answer: the restaurant's phone number.
 * These texts are fixed in code. The model never writes them and never sees the number, so it cannot
 * invent one or promise a call-back.
 */
type Wording = Record<ContactReason, (phone: string) => string>;
interface Templates {
  withPhone: ReadonlyMap<ContactReason, (phone: string) => string>;
  noPhone: string;
}

const templates = (withPhone: Wording, noPhone: string): Templates => ({
  withPhone: new Map(Object.entries(withPhone) as [ContactReason, (phone: string) => string][]),
  noPhone,
});

const EN = templates({
  customer_request: (p) => `Of course. You can reach our team directly on ${p}.`,
  phone_request: (p) => `You can reach us on ${p}.`,
  unverified_information: (p) => `I can't confirm that for certain. Please call us on ${p} and our team will help you.`,
  allergen_unverified: (p) => `I don't have verified allergen information for that, and I won't guess about allergies. Please call us on ${p} so our team can help you safely.`,
  model_uncertain: (p) => `I'm not able to help with that myself. Please call us on ${p}.`,
  other: (p) => `For that, please call us on ${p}.`,
}, "I'm not able to help with that here. Please contact the restaurant directly.");

const AR = templates({
  customer_request: (p) => `بالتأكيد. يمكنك التواصل مع فريقنا مباشرة على الرقم ${p}.`,
  phone_request: (p) => `يمكنك التواصل معنا على الرقم ${p}.`,
  unverified_information: (p) => `لا أستطيع تأكيد ذلك بشكل مؤكد. يرجى الاتصال بنا على الرقم ${p} وسيساعدك فريقنا.`,
  allergen_unverified: (p) => `ليست لدي معلومات مؤكدة عن مسببات الحساسية لهذا الطبق، ولن أخمّن في أمور الحساسية. يرجى الاتصال بنا على الرقم ${p} ليساعدك فريقنا بأمان.`,
  model_uncertain: (p) => `لا أستطيع المساعدة في هذا الأمر بنفسي. يرجى الاتصال بنا على الرقم ${p}.`,
  other: (p) => `لهذا الأمر، يرجى الاتصال بنا على الرقم ${p}.`,
}, "لا أستطيع المساعدة في هذا الأمر هنا. يرجى التواصل مع المطعم مباشرة.");

const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

export function contactMessage(reason: ContactReason, phone: string | undefined, customerText: string): string {
  const t = ARABIC_SCRIPT.test(customerText) ? AR : EN;
  const render = phone ? t.withPhone.get(reason) : undefined;
  return phone && render ? render(phone) : t.noPhone;
}

/** A value that is safe to put behind a `tel:` link on the client; null when the number has no dialable digits. */
export function dialable(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /^\+?\d{5,20}$/.test(digits) ? digits : null;
}
