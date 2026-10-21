# Changelog

## 0.8.0
- **Fix (safety):** halal, kosher, vegan, vegetarian, gluten-free and dairy-free claims were not checked by code. A label may now
  only be repeated for a dish whose menu data carries it; a customer asking about one gets the restaurant's phone number unless a
  dish was found. Pork, alcohol, gelatin, lard and bacon claims must be backed by the tool text itself. Covered by
  `tests/dietary-guards.test.ts` (verified to fail when the guard is removed).
- **Security:** a chat session unused for `CHAT_SESSION_IDLE_HOURS` (default 12; 0 disables) is refused with `invalid_session`; the widget
  then starts a fresh chat on its own.
- **Widget:** Arabic interface with right-to-left layout (`data-lang="ar"`, or the page's `<html lang>`), brand colour (`data-color`),
  an AI/privacy notice under the chat, a close button and Escape key, 30-second request timeout, localised errors and call button.
  Still renders every server string with `textContent` only.
- **Deploy:** the API container drops all Linux capabilities and cannot gain privileges.

## 0.7.0
- **Fix (safety):** the price guard did not recognise prices written with Arabic-Indic or Persian digits
  (`٣٨ دولار`) or Arabic currency words, so an invented price in an Arabic reply could reach the customer.
  Digits and separators are now normalised before checking; Arabic currency words and "bucks" are recognised.
  Covered by `tests/guards-arabic.test.ts` and an end-to-end case in `tests/chat.test.ts`.
- Version metadata aligned with the release name; `SECURITY.md` now describes the VPS deployment accurately.
- Added `docs/enterprise-readiness.md` (honest gap assessment and roadmap) and `docs/operations.md` (runbook).
