# ReaderBull: Stripe payment system handover

Written 5 August 2026, end of the session that built the payment system (Parallel Task Demonstration session). John is moving development to another Mac. This file is a straight factual record of what happened, no new work was done after this was written, per John's instruction.

## Summary: what is and isn't done

**Done:** all payment code written and pushed to the `staging` branch on GitHub. Four Stripe test-mode prices created. A Stripe test-mode webhook endpoint created. The `subscriptions` table created live in Supabase (shared DB, affects both staging and production).

**Not done:** no environment variables for Stripe have been added to Vercel yet, so none of the new endpoints will actually work until that happens. No test payment has been run. Nothing has been merged to `main`. Nothing is live on readerbull.com. Everything Stripe-side is test mode only, no live-mode equivalents exist yet.

## What shipped this session, in order

1. Confirmed the pricing model to build against: Free (1 book, $0), Plus (up to 3 books, $9/mo or $90/yr), Pro (4 to 10 books, $28/mo or $280/yr), Custom (11+ books, contact us, no self-serve checkout). These figures came from the live pricing page, not the stale local copy of `pricing.html` that existed at the start of this session (it still had old $29/$49 numbers).
2. John created four Stripe products/prices in test mode (see below).
3. Built the three payment API endpoints and wired the frontend (see "Code changes" below).
4. Uploaded everything to the `staging` branch on GitHub via the web upload interface (two commits, see "Git / GitHub state" below).
5. Ran the Supabase migration directly (via browser automation), creating the live `subscriptions` table.
6. Created the Stripe webhook endpoint in test mode.
7. Stopped there. Retrieving the webhook signing secret and the Stripe secret key, and pasting them into Vercel, were left for John to do himself, Claude does not handle API keys/secrets under any circumstance, this is a hard rule, not a preference.

## Stripe products and prices (TEST MODE / sandbox only)

Account: **Vybologybooks** (also used for John's regular client invoicing), account ID `acct_1Rfp4sBqkDn8JXbQ`. All four items below exist only in Stripe's test mode ("Sandbox" in the current Stripe UI, toggled via the account switcher). **No live-mode products, prices, or webhook exist yet.**

| Product (as named in Stripe) | Price | Interval | Price ID | Product ID |
|---|---|---|---|---|
| Plus | $9.00 | month | `price_1U0rBjBqkDn8JXbQ7MpdlHOG` | `prod_V0sxPQtsAI7xL7` |
| Plus Yearly | $90.00 | year | `price_1U0rVtBqkDn8JXbQec4mJSdw` | `prod_V0tIJda6bBlMfS` |
| Pro | $28.00 | month | `price_1U0rHBBqkDn8JXbQiDSbabmP` | `prod_V0t3pipQ4OFIGC` |
| Pro Yearly | $280.00 | year | `price_1U0rTrBqkDn8JXbQ7Vn3GACI` | `prod_V0tGFUKnCvcHeG` |

Note on the Product ID column: John pasted these four Product IDs once, in the order Plus Yearly / Pro Yearly / Pro / Plus, before Price IDs were requested instead. The mapping above assumes that was the same order as the Price IDs given afterwards (which was screenshot-confirmed). Worth a 30-second double-check in Stripe if it ever matters, but Product IDs aren't referenced anywhere in the code, only the four Price IDs are, and those are confirmed correct.

Each is a real recurring subscription price (not one-time). Created via Stripe's Product catalogue UI, no special configuration beyond name/price/interval.

## Stripe webhook endpoint (TEST MODE only)

- Endpoint ID: `we_1U0znwBqkDn8JXbQQg4LdDbz`
- URL: `https://readerbull-git-staging-product-28.vercel.app/api/stripe-webhook`
- Destination type: Webhook endpoint (not Amazon EventBridge / Azure Event Grid)
- Events subscribed: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Signing secret: **not known to Claude.** John was mid-step, revealing it in the Stripe dashboard, when this session ended. Unclear whether he finished copying it. Check the endpoint in Stripe (Developers > Webhooks, test mode) for the "Signing secret" field, click Reveal.

## Supabase: what actually changed (already live)

This ran directly against the real, shared Supabase project (same database used by both `staging` and `main`, per this project's existing convention), so it is **live now**, not something the new machine needs to redo.

Project: **Readerbull**, `https://tqkeqjisqqvxasyzrfax.supabase.co`.

A new table, `public.subscriptions`, was created:

```sql
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  plan text not null default 'free',
  billing_interval text,
  status text not null default 'active',
  book_limit integer not null default 1,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

RLS is enabled. One policy exists: `"Users can view their own subscription"` (select, using `auth.uid() = user_id`). Deliberately no insert/update/delete policy for the client roles, every write is meant to happen server-side via the `service_role` key (from `api/stripe-webhook.js` and, for reads only, `api/create-portal-session.js`), so an author can never grant themselves a paid plan client-side. Two indexes exist: `subscriptions_stripe_customer_idx`, `subscriptions_stripe_subscription_idx`.

Confirmed via the SQL Editor: "Success. No rows returned."

The source of this migration is saved locally at `subscriptions_migration.sql` in the project root. **This file was not uploaded to GitHub**, it's a local reference copy only, same convention as the project's other `*_migration.sql` files (`last_audited_at_migration.sql`, `api_call_log_migration.sql`), which are run by hand in Supabase's SQL Editor, not deployed as part of the site.

A missing row in this table means "Free plan, 1 book", the app code treats that as the default rather than requiring a row to exist for every user.

## Code changes

All of these exist on the `staging` branch on GitHub right now (see commits below). None are on `main`.

### New files (in `website/api/` locally, `api/` in the repo)

**`api/create-checkout-session.js`**
Authenticated (same Bearer-token pattern as `import-book.js`/`enrich-audit.js`). Takes `{ plan: "plus"|"pro", interval: "monthly"|"yearly", origin }`, maps to one of the four hardcoded Price IDs above, creates a Stripe Checkout Session (`mode: subscription`), stamps `client_reference_id` and `metadata.supabase_user_id` on both the session and the resulting subscription (so the webhook can identify the user later), returns `{ url }` to redirect the browser to. Calls the Stripe API directly via `fetch` (form-encoded body), no `stripe` npm package, this codebase has no `package.json`/dependencies anywhere.

**`api/create-portal-session.js`**
Authenticated. Looks up the caller's `stripe_customer_id` from `subscriptions` using the `service_role` key (never trusts anything the client sends for this). Opens a Stripe Billing Portal session, returns `{ url }`.

**`api/stripe-webhook.js`**
Verifies the Stripe signature by hand (Node's built-in `crypto.createHmac`, Stripe's documented HMAC-SHA256 scheme), since there's no `stripe` npm package to call `constructEvent` with. Exports `module.exports.config = { api: { bodyParser: false } }` so Vercel doesn't parse the JSON body before the signature check can see the raw bytes. Handles the four subscribed events, upserts into `subscriptions` (`on_conflict=user_id`). On `invoice.payment_failed`, also emails an alert to `coastlvibes@gmail.com` via Resend if `RESEND_API_KEY` is set (reuses the existing `sendErrorAlert` pattern from `enrich-audit.js`).

**Important for whoever continues this:** the four Price ID → plan/interval mappings are hardcoded in *two* places (`create-checkout-session.js` and `stripe-webhook.js`), duplicated deliberately since this codebase has no shared-module system between `/api` files. When switching to live-mode Stripe keys and prices later, **both files must be updated together**, or the webhook will fail to recognise a real purchase's price ID.

### Edited files

**`dashboard.html`**
- New "Billing" item in the sidebar's Account section.
- New `#billing-modal`: shows the author's current plan/book limit, four buttons (Plus monthly/yearly, Pro monthly/yearly) that POST to `create-checkout-session` and redirect to Stripe, a "Manage billing" button (shown only if a `stripe_customer_id` exists) that POSTs to `create-portal-session` and redirects, and a mailto link for Custom/11+.
- On page load, fetches the user's own `subscriptions` row directly via the browser's Supabase session (RLS-scoped), defaults to `{plan:'free', book_limit:1}` if no row exists.
- Auto-opens the billing modal if the URL has `?checkout=success` (Stripe's post-payment redirect) or `#billing` (link from `pricing.html`).
- **Book-limit gate:** the sidebar's "Add another book" link now checks `books.length >= subscription.book_limit` before navigating to `onboarding.html`. At the cap, it blocks navigation and opens the billing modal with an upgrade message instead. This is the "hard block with upgrade prompt" behaviour John chose earlier in the session.

**`pricing.html`**
- Rewritten in full. The local copy was stale (old $29/$49/no-Custom-tier numbers); this rewrite matches what was actually already live on readerbull.com (Free/Plus/Pro/Custom, $9/$28), and adds the Stripe wiring on top.
- Plus/Pro "Get started" are now buttons, not plain links. On click: checks for an active Supabase session; if logged in, POSTs to `create-checkout-session` with the selected interval and redirects to Stripe; if logged out, sends to `signup.html`.
- The monthly/yearly toggle now drives real Plus/Pro prices (previously the yearly figures weren't populated for these two tiers).

## Git / GitHub state

- Repo: `johnhones/readerbull`
- Branch: **`staging`** (not `main`, nothing here is live)
- Two commits, both made directly to `staging` via GitHub's web upload interface (this project's established deploy method, the working sandbox has no `git push` access to github.com):
  1. **"Add Stripe checkout/portal/webhook endpoints"** — added `api/create-checkout-session.js`, `api/create-portal-session.js`, `api/stripe-webhook.js`
  2. **"Wire Stripe billing into dashboard and pricing page"** — replaced `dashboard.html` and `pricing.html` at the repo root
- Both confirmed present on `staging` by browsing the GitHub file tree after each commit.
- Vercel auto-deploys `staging` on push. Preview URL: `https://readerbull-git-staging-product-28.vercel.app`
- `main` is untouched by this session. Production's `pricing.html` already had the correct tier numbers (that's where they were sourced from) but its Plus/Pro buttons are still the old plain, non-functional links, no Stripe wiring exists on production.
- `subscriptions_migration.sql` was never uploaded to GitHub (see Supabase section above).

If the new Mac has real `git push` access to github.com (worth testing, the no-push limitation was specific to this session's sandboxed environment, not necessarily a property of the new machine), normal git workflows can replace the web-upload method going forward.

## What is explicitly NOT done

1. `STRIPE_WEBHOOK_SECRET` has not been added to Vercel. John was mid-step retrieving it when this session ended.
2. `STRIPE_SECRET_KEY` (test mode) has not been retrieved or added to Vercel either.
3. **Because of 1 and 2, none of the three new API endpoints will actually function yet** — each checks for these env vars and returns a "not configured yet" error if missing.
4. No test checkout has been run end to end. Nothing beyond code review and the Supabase migration's success message has been verified working.
5. `staging` has not been promoted to `main`. Nothing from this session is live on readerbull.com.
6. Everything Stripe-side is test mode only. Live-mode products, prices, and a live-mode webhook endpoint all still need to be created from scratch before real launch, test and live are entirely separate data sets in Stripe, nothing carries over automatically.
7. No mobile check has been done on the new billing modal or the rebuilt pricing page (standing project rule 9).
8. Minor cosmetic leftover: a couple of empty "Untitled query" tabs were created in Supabase's SQL Editor while getting the migration into the right tab. Harmless, safe to delete or ignore.
9. Custom (11+ books) intentionally has no Stripe checkout, contact-us only, by design, matches `pricing.html`.

## Environment variables and access needed on the new machine

**Not yet set anywhere, needed before this feature works at all:**
- `STRIPE_SECRET_KEY` — Stripe test mode secret key (`sk_test_...`), from Stripe Developers > API keys. Add to Vercel, scope at least "Preview".
- `STRIPE_WEBHOOK_SECRET` — the signing secret (`whsec_...`) from the webhook endpoint created above. Add to Vercel, scope at least "Preview".
- Later, before going live: live-mode equivalents of both, plus live-mode Stripe products/prices/webhook (see item 6 above), scoped to "Production".

**Already existing, this feature depends on them but they were not touched this session, confirm they're still set:**
- `SUPABASE_SERVICE_ROLE_KEY` (used by `create-portal-session.js` and `stripe-webhook.js`)
- `RESEND_API_KEY` (optional, only used for the payment-failed admin alert email)

**Access the new machine will need:**
- GitHub: `johnhones/readerbull`, push access to `staging` (and eventually `main`)
- Vercel: the project's dashboard, to manage the environment variables above
- Stripe: the Vybologybooks account (`acct_1Rfp4sBqkDn8JXbQ`), test mode for continued testing, will need live mode set up before launch
- Supabase: project "Readerbull" (`tqkeqjisqqvxasyzrfax`), already has everything this feature needs, no further setup required there

## Suggested next steps, once resumed

1. Finish retrieving `STRIPE_SECRET_KEY` (test) and `STRIPE_WEBHOOK_SECRET`, add both to Vercel.
2. Run a full test checkout on staging using Stripe's test card (`4242 4242 4242 4242`), confirm: Checkout redirects correctly, the webhook fires and populates the `subscriptions` row, the dashboard billing modal reflects the new plan, the book-limit gate raises to 3 (Plus) or 10 (Pro), and "Manage billing" opens the portal correctly.
3. Test cancelling via the portal, confirm the webhook correctly reverts the row to Free / 1 book.
4. Test the `invoice.payment_failed` path (Stripe's test mode has tools to simulate this).
5. Once verified on staging: switch to live-mode Stripe keys, create live-mode products/prices/webhook, update the hardcoded Price ID maps in both `create-checkout-session.js` and `stripe-webhook.js`, then promote to `main` via the project's established staging-then-PR workflow.
6. Mobile check on the billing modal and the rebuilt pricing page before calling any of this fully done, per standing project rule 9.
