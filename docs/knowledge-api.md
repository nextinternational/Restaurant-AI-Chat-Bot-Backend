# FAQ and policy knowledge base (Step 8)

The assistant could answer menu, price, hours and location questions, and hand everything else to the phone number. Restaurants also get
asked about cancellation, children, pets, payment, delivery, parking, birthday cakes and WiFi. This step lets staff write those answers
once, publish them, and have the assistant quote them (and only them).

Base path `/v1/restaurants/:restaurantId`, `Authorization: Bearer <session token>`. As with the catalog API, `:restaurantId` is only a claim:
`requireTenant` checks membership and permission first (non-members get 404). It does **not** need `OPENAI_API_KEY`: content can be prepared
before chat is switched on.

## Two kinds of content

| | FAQ | Policy |
|---|---|---|
| What | A question + answer, any topic | A fixed kind: `cancellation`, `refund`, `dress_code`, `children`, `pets`, `payment`, `delivery`, `takeaway`, `corkage`, `parking`, `accessibility`, `private_events`, `service_charge` |
| How many | Up to 100 draft or published per restaurant | Exactly one per kind per restaurant |
| How the assistant finds it | `search_faq` (ranked text search, see below) | `get_policy` (exact lookup by kind: no guessing) |
| Lifecycle | `draft` -> `published` -> `archived` | `draft` <-> `published` |

## Endpoints

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /faqs?status=live\|draft\|published\|archived\|all&category=&after=&limit=` | `knowledge:read` | Default `live` (draft + published). Cursor = last `slug`; response has `nextCursor`. |
| `POST /faqs` | `knowledge:write` | `{question, answer, slug?, category?, keywords?}`. Always created as a **draft**. Slug is derived from the question (random suffix if taken; `faq-...` for Arabic). An explicit slug that exists is 409. |
| `GET /faqs/:slug` | `knowledge:read` | Any status. |
| `PATCH /faqs/:slug` | `knowledge:write` | question, answer, category (`null` removes), keywords. **Status is unchanged.** 409 on archived entries. |
| `POST /faqs/:slug/publish` | `knowledge:write` | draft -> published. Idempotent. 409 if archived. |
| `POST /faqs/:slug/unpublish` | `knowledge:write` | published -> draft. The assistant stops using it at once. Idempotent. |
| `DELETE /faqs/:slug` | `knowledge:write` | Archives from any state (soft delete, idempotent). |
| `POST /faqs/:slug/restore` | `knowledge:write` | archived -> **draft** (never straight back to live). 409 if the restaurant is at the 100-entry cap. |
| `GET /policies` | `knowledge:read` | `{policies, unconfiguredKinds}`: shows what is still missing. |
| `GET /policies/:kind` | `knowledge:read` | 404 if never saved. |
| `PUT /policies/:kind` | `knowledge:write` | `{title?, body}`. Creates a **draft**, or replaces title/body of an existing policy **keeping its status**. |
| `POST /policies/:kind/publish` / `unpublish` | `knowledge:write` | Idempotent. 404 if the policy was never saved. |

Roles: `owner`/`admin`/`manager` read and write; `staff`/`viewer` read only.

## What the assistant sees

- **Published content only.** The assistant's repository interface has no read for drafts or archived entries (`listPublishedFaqs`, `getPublishedPolicy`), the same way unverified allergens are invisible to it. Staff can prepare and review text safely.
- **`get_policy({kind})`** returns the published policy, or `{found:false}`.
- **`search_faq({query})`** ranks the restaurant's published FAQs in code (no AI, no external service; `rankFaqs` in `src/domain/knowledgeRules.ts`):
  query words found in the question score 3, in a staff keyword 2, in the answer 1; stop words are ignored, simple plurals and the Arabic article are normalised.
  An entry is returned only if at least one word hits its question or keywords **and** at least half of the query words are found. Up to 3 entries, none under half of the best score.
  No match is `{found:false}`: a wrong answer is worse than none, and the fallback for "no answer" is the restaurant's phone number.
  **Add keywords** (`kids`, `baby`, `puppy`, `wi-fi`, ...) to FAQs: they are how synonyms are found without an embedding model.
- The model is told to use an entry only if it clearly answers the question and to add nothing the entry does not say; if nothing is found, to answer `type=contact`.
- Amounts written in published FAQ or policy text (a $25 corkage fee) are treated as grounded for that turn, so the price guard does not reject a correct quote; any other amount is still rejected.

## Safety decisions

- **Drafts first, publish on purpose.** Nothing becomes customer-facing without an explicit publish. Restoring an archived FAQ returns it to draft.
- **Code, not the model, enforces "no invented policies".** `ChatService.safetyOverride` replaces any answer with the contact number (reason `unverified_information`) when the customer's message is about a policy topic
  (cancellation, refunds, children, pets, payment, delivery/takeaway, corkage, parking, accessibility, private events, service charge/tipping; English and Arabic) and no `get_policy`/`search_faq` call returned published content that turn.
  The patterns are deliberately specific so "hot dogs" or "my kids love the salmon, how much is it?" are not blocked (`mentionsPolicyTopic`, covered by tests).
- **Tenant isolation as everywhere else:** both collections go through `ScopedCollection`; neither tool has a restaurant parameter; unique indexes are `{restaurantId, slug}` and `{restaurantId, kind}`; migration `004` adds strict validators.
- **Strict bodies:** a `restaurantId`, `status` or `publishedAt` in a request is rejected, not ignored.
- **Audited** (`faq.created|updated|published|unpublished|archived|restored`, `policy.created|updated|published|unpublished`). Entries record which fields changed and whether the edit was **live**, never the text itself. No-op edits write nothing.
- **Per-user write limit** (`ADMIN_WRITE_RATE_LIMIT_PER_MIN`) on mutations.

## Known limits (tracked, not hidden)

- **Editing a published entry is live immediately** (the audit entry says `live: true`). For a review step, unpublish, edit, publish.
- Retrieval is lexical. A customer who uses a word that neither the question nor the keywords contain will get "no match" and the phone number. Semantic search (RAG) is the planned upgrade; the 100-entry cap and the tool interface are designed so it can replace `rankFaqs` without changing anything else.
- The policy-topic guard covers the topics above. A question outside that list (for example "do you do wine tastings?") is protected by the prompt and by `search_faq` returning `found:false`, not by a code check.
- The assistant may translate an English entry for an Arabic-speaking customer. Staff can't currently store a separate Arabic text per entry; write bilingual answers or add an Arabic FAQ with Arabic keywords.
- Phone numbers: the assistant must not state one; the number comes from the restaurant record. Do not put phone numbers in FAQ or policy text (not enforced).
- 100 live FAQs per restaurant is enforced by the service; two simultaneous creates at 99 could briefly reach 101 (retrieval would then ignore the last one by slug order).
