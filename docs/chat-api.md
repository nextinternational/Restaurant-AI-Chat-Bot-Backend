# Chat API & AI layer

## Request flow
```
Browser widget --POST /v1/chat/:widgetKey/sessions--> server resolves widgetKey -> restaurant, checks Origin allow-list
               <-- sessionToken (256-bit, only its SHA-256 is stored)
Browser widget --POST /v1/chat/:widgetKey/messages  (Authorization: Bearer sessionToken)--> ChatService
```
The **restaurant is never read from the request body**. The widget key (public, in the page HTML) identifies the widget; the server resolves the tenant and checks the exact `Origin` against that key's allow-list. A session token only exists inside the tenant that minted it, so a token from restaurant A is a plain 401 at restaurant B.

| Endpoint | Notes |
|---|---|
| `POST /v1/chat/:widgetKey/sessions` | 201 `{sessionToken, restaurantName}`. Origin required and must be allow-listed (403 otherwise). |
| `POST /v1/chat/:widgetKey/messages` | Body `{message}` (1-1000 chars). 200 `{type: "answer"\|"contact", message, reason?, contactPhone?}`. |
| `OPTIONS` on both | Per-tenant CORS preflight (204 for an allowed origin, 403 otherwise). |

Errors: 400 bad message, 401 invalid session, 403 origin, 404 unknown key, 409 closed, 429 rate/length limit, 503 `ai_unavailable` (provider failure; nothing internal is leaked, usage is still logged).

## What the model can and cannot do
Tools (all bound to the session's restaurant; no schema has a restaurant parameter, and any extra argument the model invents is dropped and logged):
`get_menu_item`, `list_menu`, `get_item_allergens`, `get_opening_hours`, `get_location`, `get_policy`, `search_faq` (the last two read **published** FAQs/policies only; see `knowledge-api.md`).

After the model answers, **code** decides whether the answer may be shown (`ChatService.safetyOverride`). When it may not, the customer is given the restaurant's phone number instead (`type: "contact"`):
1. Any allergen lookup that is unverified or not found -> contact, reason `allergen_unverified`, whatever the model wrote.
2. Customer message mentions allergy/intolerance terms but no verified allergen lookup happened this turn -> contact, reason `allergen_unverified`.
3. Any money amount in the answer that no tool returned this turn -> contact, reason `unverified_information` (so no invented prices, and also no totals/discounts the model calculated). Amounts are recognised with Western or Arabic-Indic/Persian digits, with symbols (`$`, `€`, `£`), ISO codes (`XCD`, `USD`, ...) and English or Arabic currency words.
4. Explicit request for a person ("speak to a human", Arabic variants) -> contact, reason `customer_request`, **without calling the model**.
5. Request for the phone number or how to call ("what's your number", "how can I contact you", Arabic variants) -> contact, reason `phone_request`, **without calling the model**.
6. Malformed/off-schema model output, or too many tool rounds -> contact, reason `model_uncertain`.
7. Customer message is about a policy topic (cancellation, refunds, children, pets, payment, delivery, parking, ...) but no `get_policy`/`search_faq` call returned published content this turn -> contact, reason `unverified_information`.
8. Monthly AI budget reached -> contact, reason `other`, no model call. Budget = restaurant `monthlyAiBudgetMicros`, or `AI_DEFAULT_MONTHLY_BUDGET_MICROS` when 0.

## Contact number, not human handoff
There is no staff dashboard, live chat, queue or notification channel. Whenever the assistant cannot help, the customer is told to call the restaurant.
- The number is the restaurant's `location.phone`, set with `npm run provision:settings -- --restaurant <slug> --phone "..."`. It is read from the session's own restaurant, so another restaurant's number can never appear.
- The wording is fixed text in code (English, or Arabic when the customer writes Arabic), never model output. The model is told never to write a phone number, and `get_location` does not return it.
- `contactPhone` in the reply is the number reduced to digits (and a leading `+`) so the widget can render a tap-to-call link. It is omitted when the restaurant has no dialable number; the message then asks the customer to contact the restaurant directly. **Set a phone number for every restaurant before going live.**
- The conversation stays `active`. After a contact reply the customer can keep asking questions the assistant can answer.

## Known limits (deliberate, tracked)
- **Opening hours and menu text are not machine-verified in the answer** (only amounts and allergens are). Keep hours and descriptions accurate in the database.
- Amount check is regex-based: amounts written as words ("thirty-eight dollars") are not detected. The system prompt forbids them; the guard is a backstop.
- Allergy detection is keyword-based (English + a few Arabic terms) and errs toward handing off. Extend `src/ai/guards.ts` for other languages you serve.
- Contact wording exists in English and Arabic only.
- Rolling conversation summary: the field and prompt slot exist, but nothing writes summaries yet; only the last 10 messages are sent to the model.
- Tool calls are not persisted as messages (only customer/assistant turns), so the stored transcript shows what was said, not which lookups ran.
- Origin checks stop other websites from using a widget key in a browser; they do not stop a script that forges the header. Rate limits and the budget cap are the defence against that.
- Rate limiters are in-memory per container (as before). Use a shared store before running more than one task.
- Conversation `messageCount` and message insert are separate writes; concurrent messages in one session can interleave.
- Not implemented: reservations/orders, FAQ/policy knowledge base (`searchFAQ`), crawler/RAG.
- Out of scope by design: staff dashboard, live chat, handoff queue and staff notifications.


## Conversation context and cost reporting

**Context window (spec section 7).** The model receives the last 10 messages verbatim plus a short digest of what the customer asked *before* that window. The digest is built by code from the customer's own earlier questions (newest 8, each cut to 140 characters); it is never produced by a second model call, never contains anything the assistant said, and is labelled in the prompt as quoted customer text, not instructions and not facts. Prices, hours and allergens are always looked up again with the tools in the current turn.

**Usage report (spec section 12).** `GET /v1/restaurants/:id/usage?from=&to=&limit=` (permission `usage:read`: owner, admin, manager, viewer) returns, for the given range (default: the current UTC month): request and token totals with estimated cost, the restaurant's monthly AI budget, cost per model, and the most expensive conversations. Costs are integer micro-USD. The query is tenant-scoped by `ScopedCollection`; another restaurant's id in the URL returns 404.


## Added in 0.8.0
- **Dietary and religious labels.** Customer questions or answers that mention halal, kosher, vegan, vegetarian, gluten-free or
  dairy-free are only allowed when a menu tool returned that label for a dish this turn; otherwise the reply is `contact` with reason
  `unverified_information`. Mentions of pork, alcohol, gelatin, lard or bacon must be backed by the text of a tool result (menu
  description or a published FAQ/policy).
- **Idle sessions.** A session with no message for `CHAT_SESSION_IDLE_HOURS` (default 12) returns `401 invalid_session`; the bundled
  widget starts a new session automatically.
