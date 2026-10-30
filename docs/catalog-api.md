# Menu, allergen and opening-hours management API (Step 7)

Until now menu items, allergen verification and opening hours could only be entered through the seed script / repositories.
Because the assistant **hands off** on any item whose allergens are unverified and on any restaurant with no hours,
a restaurant could not go live without a developer. This API lets authorised staff do it themselves.

Base path `/v1/restaurants/:restaurantId`, `Authorization: Bearer <session token>`. The `:restaurantId` is only a claim:
`requireTenant` checks membership and permission before anything runs (non-members get 404). It does **not** need `OPENAI_API_KEY`:
restaurants can enter and verify their data before chat is switched on.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /menu/items?status=active\|archived\|all&category=&after=&limit=` | `menu:read` | Cursor = last `slug`; response has `nextCursor`. |
| `POST /menu/items` | `menu:write` | `{name, category, priceCents, description?, slug?, available?, dietaryTags?}`. Currency is the restaurant's. Starts **unverified**. |
| `GET /menu/items/:slug` | `menu:read` | Includes archived items. |
| `PATCH /menu/items/:slug` | `menu:write` | name, description (`null` removes), category, priceCents, available, dietaryTags. Cannot change allergens. |
| `DELETE /menu/items/:slug` | `menu:write` | Archives (soft delete, idempotent). The assistant stops seeing it. |
| `POST /menu/items/:slug/restore` | `menu:write` | 409 if another active item now has the name. |
| `PUT /menu/items/:slug/allergens` | `allergens:verify` | `{allergens: [...], confirmed: true}`. The only way allergen data becomes usable by the assistant. |
| `DELETE /menu/items/:slug/allergens/verification` | `allergens:verify` | Back to unverified (e.g. recipe changed). |
| `GET /hours` | `hours:read` | `{timezone, configured, hours}`. |
| `PUT /hours` | `hours:write` | Replaces the whole schedule (`weekly`, `exceptions`). |

Roles: `owner`/`admin` everything; `manager` menu + hours + allergen verification; `staff`/`viewer` read-only.

## Safety decisions
- **Allergens are attested, not typed.** `confirmed: true` is mandatory, an empty list needs it too, and the verifier recorded on the item is the
  authenticated user (name + user id) - never a value from the request body.
- **Allergens and labels must agree.** Verified allergens that contradict dietary labels (`vegan` + milk/eggs/fish/crustaceans/molluscs,
  `vegetarian` + fish/crustaceans/molluscs, `dairy_free` + milk, `gluten_free` + gluten) are rejected with 422 `allergen_tag_conflict`, in both directions.
- **No duplicate active names.** Two active items with the same normalised name would make a price question ambiguous; creating, renaming or restoring into that state is 409 `duplicate_name`.
- **Money is integer cents**; floats are 400, never rounded. Bodies are strict: unknown fields (a `restaurantId`, a `currency`, a `verifiedBy`) are rejected.
- **Hours are validated as a whole**: no overlapping periods (including a late-night period running into the next opening, wrapping Saturday to Sunday),
  real calendar dates, no duplicate exception dates, `closed` consistent with `periods`, and at least one open period per week (an all-closed week is almost always a mistake and would tell every customer "closed"). Violations are 422 `invalid_hours`.
- **Everything is audited** (`menu_item.created|updated|archived|restored|allergens_verified|allergens_unverified`, `hours.updated`) with before/after for price, name and allergens; no-op edits write nothing.
- **Per-user write limit** (`ADMIN_WRITE_RATE_LIMIT_PER_MIN`, default 60) on mutations.

## Known limits (tracked, not hidden)
- Editing `name`/`description` does **not** auto-revoke allergen verification (no ingredient data exists to compare). If a recipe changes, call the revoke endpoint or re-verify.
- Read-modify-write on PATCH: two people editing the *same field* at once: last write wins (different fields do not clobber each other).
- The duplicate-name check is check-then-write, not a unique index; a precise race between two staff creating the same name can slip through. A partial unique index on `(restaurantId, nameNormalized)` for active items would close it (needs a migration and a clean-up of existing data first).
- Exceptions are validated per date; a late-night exception period running past midnight is not compared with the next date's schedule.
- No bulk import (CSV/JSON).
- `tests/integration/catalog.int.test.ts` covers the real repository against MongoDB but needs `MONGODB_TEST_URI`; it has **not** been run in the environment where this step was written (no MongoDB available).
