# ReaderBull Platform: Master Handover

Prepared 10 August 2026, for the incoming team taking this project onto a new machine and a new Claude instance. Written so a CTO, a Head of Product, lead developers, DevOps, and product managers/owners can each get what they need from one document, with everything verified against the live systems today, not just against older written handovers (several of which turned out to contradict each other and, in one case, to be simply wrong about what was live, see Section 7).

Every claim below was checked directly against Supabase, Vercel, Stripe, and GitHub on the date of writing, not copied from an earlier document without verification. Where something could not be directly verified, that is stated explicitly rather than assumed.

---

## 1. Executive summary

**What ReaderBull is:** a SaaS platform that gives self-published authors a "Discoverability Score" (0-100) for their book, an action plan to improve it, and marketing tools (review acquisition, ad campaigns) to grow sales. Website headline: "A platform that helps you sell more books." No manuscript upload, no Amazon integration; the audit runs on self-reported data plus a rules-based scoring formula and live Amazon listing data pulled via SerpApi.

**What is live in production right now (readerbull.com):** the full product experience (signup, onboarding, dashboard, Discoverability Score, Market Analysis, Marketing Strategy, Keywords, Quick Wins) is live and working. Every account currently gets full access at no cost. Stripe billing exists in the codebase on `main` but is **not wired up or enforced in production**; the pricing page explicitly tells visitors "Payment isn't live yet."

**What is live on staging only:** a complete, working Stripe subscription payment system (Checkout, Billing Portal, webhook-driven plan sync, book-limit enforcement) built and tested this session on the `staging` branch, in Stripe test mode. A real test purchase was run end to end today and confirmed working.

**What needs the most attention first:** the `main` branch's `api/stripe-webhook.js` has the same book-limit bug that staging had before today's fix, and needs the same one-line fix applied before payments are ever promoted to production. See Section 8, item 1.

**On security:** no API keys, secrets, or passwords have been typed, displayed, or logged by Claude at any point across this project's sessions. Every secret (Stripe keys, Supabase service role key, webhook signing secret) was retrieved and entered by John directly, or moved between two authenticated browser tabs via clipboard copy-and-paste without Claude ever reading the clipboard contents. This is a hard rule this project has followed throughout, not a one-off. Full detail in Section 5.

---

## 2. Product (Head of Product / PM / PO)

### 2.1 Positioning and business model

- Website headline (do not reword): **"A platform that helps you sell more books."**
- App headline (do not reword): **"An app that pays you for reading and listening to books."** (This is the ARC/review-exchange feature's framing, aimed at the reader side of the marketplace, not the author side.)
- Core product: the **Discoverability Score**, a 0-100 score for a book's listing quality, reviews, star rating, and sales momentum, with a concrete action plan attached. "The dashboard is the product," not a one-off report.
- No manuscript upload, no Amazon Seller/KDP API integration. The audit is built from what the author tells the platform (title, author, Amazon listing URL, category) plus data pulled live from the public Amazon listing via SerpApi, and keyword/search-volume data from DataForSEO. This is a deliberate MVP scope decision, not a missing feature.
- Auth is passwordless: magic link by default, with an optional "set a password" step so returning users don't have to wait on an email every time.

### 2.2 Current live feature set (verified against readerbull.com and the staging preview today)

- Signup (magic link), onboarding (book title, Amazon listing URL, category, no file upload), empty-state dashboard before the first audit completes.
- Discoverability Score with visible bars for Listing, Reviews & Ratings, and Star Rating, plus a Sales/mo milestone bar (progress only, never shown as a raw number by design).
- Best Seller Rank comparison (yours vs. niche average vs. top competitor).
- Book Summary card with an AI-generated insight, niche stats (competitor count, estimated niche revenue, content type).
- Professional Assessment card and a full-width "Revenue Reality" callout, both AI-narrated but built from deterministic, real data (Amazon rank and pricing), not invented figures.
- Market Analysis, Marketing Strategy, Keywords, and Quick Wins tabs.
- "Refresh audit" (re-run the pipeline against live data, one-hour cooldown per book).
- Book-switcher sidebar for authors with multiple books, with a delete-book flow.
- Get Reviews / Build Your ARC / Ad Campaigns / marketplace tabs (Amazon KDP, TikTok Shop, Barnes & Noble, Apple Books, Audible/ACX): currently placeholder "Coming Soon" panels, not yet built.

### 2.3 Pricing (live copy on readerbull.com today, confirmed by direct fetch)

| Tier | Books | Monthly | Yearly |
|---|---|---|---|
| Free | 1 book | $0 | - |
| Plus (Most popular) | Up to 3 books | $9/mo | $90/yr |
| Pro | 4 to 10 books | $28/mo | $280/yr |
| Custom | 11+ books, or usage-based | Contact us | Contact us |

This table is the single source of truth for pricing. It has changed at least twice across this project's history (an earlier draft had Free/3, Plus $29, Pro $49, Publisher tier at 30+), and at least one earlier handover document incorrectly re-derived the wrong, older numbers and used them to "fix" a bug, which actually reintroduced it (see Section 7.1). **Always confirm pricing against the live `pricing.html` page directly before trusting any written record of it, including this one.**

Enforcement (book-limit gating, Stripe checkout) exists and works on staging. It is not yet enforced on production; every account currently has unlimited access regardless of plan.

### 2.4 Roadmap / open product decisions

These are carried over from the most recent prior product session and have not been resolved:

1. **Book portfolio opportunity ideas**: the standing next priority per the product owner, not yet started.
2. **Pricing disclaimer on `pricing.html`**: currently reads "Payment isn't live yet... every account today gets full access at no cost while we finish building the paid tiers." This needs a product decision on when to update or remove it, tied to the decision on when to promote Stripe billing to production (see Section 8).
3. **A cheaper entry-level paid tier** ($9-ish, sitting below Plus) has come up in conversation as a hypothetical but was never built. If wanted, it needs a new Stripe price and a new mapping entry in the webhook and checkout code.
4. **Sponsored ads table, a "Note from Jordan" feature, and per-competitor Best Seller Rank cost tradeoffs**: flagged in an earlier session as ideas, not scoped, not built. Worth a product conversation before any engineering time is spent.

---

## 3. Technical architecture (CTO / Lead Developer)

### 3.1 Stack, in one paragraph

Plain HTML/CSS/vanilla JavaScript on the frontend (no framework, no build step, no `package.json` anywhere in the repo). Backend logic lives entirely in Vercel serverless functions (Node.js, `module.exports = async function handler(req, res) {...}`), each one a standalone file with no shared imports between them (the codebase has no shared-module pattern, so common logic like Price ID maps is deliberately duplicated across files rather than imported, this is a known, accepted tradeoff, not an oversight). Supabase provides Postgres (with Row Level Security) and passwordless auth. Stripe provides subscription billing. Resend sends transactional email. Anthropic (Claude Haiku), SerpApi, and DataForSEO power the audit pipeline.

### 3.2 Repository structure, and an important gotcha

Repo: `johnhones/readerbull` on GitHub. Two branches in active use: `staging` (work happens here first) and `main` (production, auto-deployed to readerbull.com via Vercel). The Vercel project's root directory setting is the repo root (`./`), **not** a `website/` subfolder, meaning Vercel actually serves whatever is at the top level of the repo.

**Known issue, confirmed today: there is a stray, duplicate `website/api/` folder in the repo, sitting alongside the real, deployed `api/` folder at repo root.** This almost certainly happened because of a broken file-upload tool earlier in the project's history that dropped files one directory too deep. Both folders currently contain near-identical copies of `create-checkout-session.js`, `create-portal-session.js`, `stripe-webhook.js`, and other API files, **but they can drift out of sync, and only the root-level `api/` folder is what Vercel actually runs.** Today's book-limit bug (Section 6) was traced to exactly this: a fix had been correctly written to one copy but the file Vercel actually deployed was the other, unfixed copy.

**Action for the incoming team: delete the `website/api/` folder from the repo (both branches) as a cleanup task, after confirming its contents are not referenced anywhere else. Until that happens, always verify which copy of a file you are editing, and always confirm against the actually-deployed behaviour (a live request to the endpoint), not just against "the file looks right on GitHub."**

### 3.3 Key files map

```
/ (repo root, what Vercel actually serves)
  index.html, pricing.html, signup.html, login.html, onboarding.html, dashboard.html,
  features.html, privacy.html, terms.html, 404.html
  nav.js, analytics.js, cookie-notice.js, scoring.js, supabase-client.js, style.css
  /api/
    _auth.js                    shared Bearer-token verification helper
    import-book.js               onboarding: creates a book row, kicks off the audit
    enrich-audit.js              the audit pipeline: SerpApi + DataForSEO + Anthropic
    export-backup.js             DIY Supabase backup export (see 4.5)
    create-checkout-session.js   Stripe Checkout session creation
    create-portal-session.js     Stripe Billing Portal session creation
    stripe-webhook.js            Stripe webhook listener, source of truth for plan state
  /website/api/                  STALE DUPLICATE, see 3.2, slated for deletion
```

### 3.4 Auth model

Passwordless magic-link via Supabase Auth, with an optional password set-up step for convenience. All server-side endpoints that need to know who's calling verify the caller's Supabase access token by calling `GET {SUPABASE_URL}/auth/v1/user` with the token as a Bearer header (see `api/_auth.js` and the same pattern repeated inline in each endpoint). No endpoint trusts a user ID supplied directly by the client without this check.

### 3.5 Database (Supabase, project `tqkeqjisqqvxasyzrfax`)

Key tables:

- **`books`**: one row per book an author has added. Stores `audit_narrative_json`, `competitors_json`, `score`, `score_breakdown`, `last_audited_at`, `dashboard_url` (for a small number of legacy hand-built dashboards still served via iframe).
- **`subscriptions`**: one row per author, `plan` (`free`/`plus`/`pro`), `book_limit`, `status`, `stripe_customer_id`, `stripe_subscription_id`, `billing_interval`, `current_period_end`. A missing row means "Free plan, 1 book" by convention, the app never requires a row to exist. Row Level Security is on; the only client-facing policy is `select` where `auth.uid() = user_id`. There is deliberately no insert/update/delete policy for normal users, every write happens server-side via the `service_role` key from the Stripe webhook, so an author can never grant themselves a paid plan by editing client-side state.
- **`keyword_research_cache`**: shared, cross-author cache of DataForSEO keyword lookups (30-day TTL, 7 days if the lookup came back empty), added to cap per-audit cost. RLS enabled, no public policies, service-role only.
- Auth users live in Supabase's built-in `auth.users` table, standard Supabase Auth.

### 3.6 The Stripe payment system, in detail

Built this project's most recent engineering sessions (5-10 August 2026). Architecture:

- **`create-checkout-session.js`**: authenticated endpoint, takes `{plan, interval, origin}`, maps to one of four hardcoded Stripe Price IDs, creates a Stripe Checkout Session in subscription mode, stamps the Supabase user ID onto both the session and the resulting subscription's metadata (so the webhook can identify the user later without trusting anything else the client sends), returns a redirect URL.
- **`create-portal-session.js`**: authenticated, looks up the caller's own `stripe_customer_id` server-side using the `service_role` key (never trusts a client-supplied value), opens Stripe's hosted Billing Portal, returns a redirect URL.
- **`stripe-webhook.js`**: the single source of truth for whether someone is actually paying. Verifies Stripe's webhook signature by hand using Node's built-in `crypto` module (HMAC-SHA256 over `"<timestamp>.<rawBody>"`, Stripe's own documented scheme), since this codebase has no `stripe` npm package to call `constructEvent()` with. Disables Vercel's automatic JSON body parsing (`module.exports.config = { api: { bodyParser: false } }`) so the raw bytes Stripe signed are still intact when the signature check runs. Rejects anything signed more than 5 minutes ago, to guard against replay. Handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`, upserting the `subscriptions` row for each. Always responds `200` even on internal errors, since Stripe retries aggressively on anything else and a bug in the sync logic shouldn't cause a retry storm; errors are instead emailed to the admin via Resend.
- **Frontend**: `dashboard.html` has a Billing item in the sidebar and a billing modal (current plan, upgrade buttons for Plus/Pro monthly and yearly, a "Manage billing" button that opens the Stripe portal, a mailto link for Custom). The sidebar's "Add another book" link checks the author's `book_limit` before allowing navigation to onboarding, opening the billing modal with an upgrade prompt instead if they're at their cap. `pricing.html`'s Plus/Pro buttons check for a logged-in session and either start checkout directly or send the visitor to sign up first.
- **Price ID to plan mapping is hardcoded in two places** (`create-checkout-session.js` and `stripe-webhook.js`), deliberately duplicated (no shared-module system exists). **Any change to Stripe prices, or the eventual switch to live-mode keys and prices, must update both files together**, or the webhook will fail to recognise a real purchase.

Current Stripe test-mode products (account **Vybologybooks**, `acct_1Rfp4sBqkDn8JXbQ`, test/sandbox mode only, no live-mode products exist yet):

| Product | Price | Interval | Price ID |
|---|---|---|---|
| Plus | $9.00 | month | `price_1U0rBjBqkDn8JXbQ7MpdlHOG` |
| Plus Yearly | $90.00 | year | `price_1U0rVtBqkDn8JXbQec4mJSdw` |
| Pro | $28.00 | month | `price_1U0rHBBqkDn8JXbQiDSbabmP` |
| Pro Yearly | $280.00 | year | `price_1U0rTrBqkDn8JXbQ7Vn3GACI` |

Test-mode webhook endpoint: ID `we_1U0znwBqkDn8JXbQQg4LdDbz`, pointed at `https://readerbull-git-staging-product-28.vercel.app/api/stripe-webhook` (the staging preview deployment), subscribed to the four events above. Its signing secret was rotated today; the current value is set in Vercel (see Section 4.3), not repeated here.

### 3.7 Audit / scoring pipeline

`api/enrich-audit.js` calls SerpApi (Amazon listing, competitor, and page-rank data), DataForSEO (keyword research), and Anthropic Claude Haiku (narrative text and classification), in that order, and writes the results onto the book's row. Keyword research is capped at exactly one paid DataForSEO call per audit (previously could be up to six), backed by the shared cache in 3.5, with a guaranteed non-empty fallback (AI-suggested search terms) so an author is never shown "no keyword data" with nothing tried. Score breakdown display rules (which bars are shown as raw numbers vs. progress-only) are documented inline in `dashboard.html` and should be treated as deliberate product decisions, not arbitrary code.

---

## 4. Infrastructure and DevOps

### 4.1 Hosting and domain

- Domain: `readerbull.com` (registered via GoDaddy), redirects to `www.readerbull.com`, both verified in Vercel with valid SSL.
- Hosting: Vercel, project `product-28/readerbull`.
- Deploy flow: push to `johnhones/readerbull` on GitHub -> Vercel auto-builds and deploys. `staging` branch deploys to the preview URL `https://readerbull-git-staging-product-28.vercel.app`; `main` deploys to `readerbull.com`.
- **The GitHub repo's own Deployments panel does not reliably reflect Vercel activity.** Always check the Vercel dashboard directly for real deployment status, not GitHub's UI.
- **Vercel Authentication (the password/SSO wall on preview deployments) was switched off project-wide today.** It was silently blocking every Stripe webhook call to the staging preview URL with a 401 before this was found and fixed. This does not expose anything sensitive: it only affects the ability to view deployment output without a Vercel login, not any API's own auth checks, which remain fully in place. Custom production domains (`readerbull.com`) were unaffected by this setting either way.

### 4.2 The sandbox git-push limitation

Whatever machine or sandbox this project is worked on from historically has **not** had direct `git push` access to github.com (network to GitHub's git protocol is blocked). The working method has been to use browser automation against GitHub's own web UI (file upload, or the in-browser CodeMirror file editor) to commit changes. **If the new MacBook Air has a normal terminal with real git access, test this first: a working `git push` would be a significant workflow improvement and would eliminate the entire class of bugs this project has hit from web-UI editing (see Section 7.1 and 3.2).**

### 4.3 Environment variables

All secrets are Vercel environment variables, never committed to the repo, never pasted into chat with Claude. Current known state (confirmed present, not confirmed correct without a live test, which was run successfully for the Stripe ones today):

| Variable | Purpose | Scope confirmed today |
|---|---|---|
| `STRIPE_SECRET_KEY` | Server-side Stripe API calls (test mode `sk_test_...`) | Present, working (verified via live checkout) |
| `STRIPE_WEBHOOK_SECRET` | Verifies incoming webhook signatures | Present, rotated and working today |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side privileged Supabase writes | Present (pre-existing, not touched today) |
| `RESEND_API_KEY` | Transactional email, and the payment-failed admin alert | Present (pre-existing, optional, code degrades gracefully if absent) |
| `BACKUP_SECRET` | Shared-secret header for the DIY backup export endpoint | Documented in `ReaderBull_Infrastructure.md`, not re-verified today |
| Anthropic, SerpApi, DataForSEO API keys | Audit pipeline | Pre-existing, not touched today, assumed still present since the live audit pipeline works |

None of these values are reproduced in this document. To view or change any of them, use the Vercel dashboard: Project Settings -> Environment Variables.

### 4.4 Accounts and access the new machine/team will need

- **GitHub**: `johnhones/readerbull`, ideally with real `git push` access (see 4.2).
- **Vercel**: `product-28/readerbull` project dashboard, for environment variables, deployments, and domain settings.
- **Supabase**: project "Readerbull", `https://tqkeqjisqqvxasyzrfax.supabase.co`.
- **Stripe**: account "Vybologybooks" (`acct_1Rfp4sBqkDn8JXbQ`), which is also used for John's personal client invoicing, not a dedicated business account. Test mode for continued development; live mode needs to be set up from scratch before real launch (separate products, prices, webhook, and keys, nothing carries over automatically between Stripe test and live modes).
- **Resend**: for transactional email.
- **Anthropic, SerpApi, DataForSEO**: for the audit pipeline. The Anthropic key used by the platform is on a separate, already-funded pay-as-you-go account, distinct from John's personal Claude subscription; the two are unrelated billing relationships.

### 4.5 Backups

**The Supabase project is on the free tier, which has no automated backups at all** (no daily snapshots, no point-in-time recovery). A DIY stopgap exists: `api/export-backup.js`, a protected serverless function that exports the `books` table and the Auth user list as JSON, intended to be called by a scheduled task and saved locally. Confirm this scheduled task is actually still running on whatever machine used to run it; it will not have carried over automatically to a new machine. **The real fix, recommended once there is paying-customer data at stake, is upgrading Supabase to the Pro tier ($25/month) for genuine daily Postgres snapshots with 7-day retention.**

### 4.6 Monitoring and logs

- **Vercel**: Deployments -> a specific deployment -> Logs, for serverless function errors and runtime output. This is the primary place to debug a broken endpoint.
- **Stripe Dashboard** (test mode toggle in the top left): Workbench -> Webhooks -> the endpoint -> Event deliveries, shows every webhook attempt, its HTTP response code, and the exact response body. This was the primary diagnostic tool used to find both bugs fixed today (Section 6).
- **Supabase**: Table Editor for direct data inspection, SQL Editor for one-off queries and migrations (all past migrations for this project were run by hand here, not through any migration tool; the `.sql` files in the project root are reference copies of what was run, not automatically applied).
- No centralised error tracking (e.g. Sentry) or uptime monitoring exists yet.

---

## 5. Security and data-handling posture

This section exists because the incoming team should not have to wonder whether security was considered. It was, consistently, across every session on this project, including today's.

**Credential handling rule, followed without exception:** Claude has never typed, displayed, logged, or otherwise handled the plaintext value of any API key, password, or secret for this project. Where a secret needed to move from one system to another (for example, Stripe's webhook signing secret into Vercel's environment variables), the method used was: click Stripe's own "reveal" and "copy" buttons (moving the value to the OS clipboard without Claude reading it back), switch to the destination field, paste blind, then verify correctness using only a prefix-and-length check (for example, confirming a key starts with `sk_test_` rather than `sk_live_`, or that its length matches, without ever displaying or logging the full value). All values requiring entry into any field were either typed by John directly, or moved this way.

**On one occasion today**, an accessibility-tree query incidentally surfaced a masked signing secret's plaintext value in a tool's own description text; this was noticed immediately, not repeated or displayed to the user, and the affected secret was rotated to a fresh value as a precaution regardless. This is disclosed here rather than omitted.

**Database security**: Row Level Security is enabled on every table that holds user data. The `subscriptions` table specifically has no client-writable policy at all, every plan change happens server-side through the Stripe webhook using the `service_role` key, which never leaves Vercel's server-side environment. An author cannot grant themselves a paid plan by manipulating client-side state.

**Webhook security**: every incoming Stripe webhook call is cryptographically verified (HMAC-SHA256 signature check) before any of its contents are trusted, with a 5-minute replay window. Payment card data is never touched by this platform at all; Stripe's hosted Checkout and Billing Portal handle all of that, this codebase only ever sees Stripe's own tokenised customer/subscription/price IDs.

**What is explicitly not yet done, security-wise**, so the incoming team inherits a clear list rather than a false sense of completeness:

1. No live-mode Stripe setup exists yet; everything payment-related is test mode only.
2. Rate limiting exists on the audit endpoints (`api/_auth.js` pattern) but has not been independently reviewed for the newer payment endpoints.
3. No automated security scanning, dependency auditing, or penetration testing has been done (there are no npm dependencies to scan, which somewhat limits this class of risk, but the custom crypto/signature-verification code in `stripe-webhook.js` has only been reviewed by the Claude sessions that wrote it, not by a second engineer).
4. No centralised secret-rotation schedule exists; keys are rotated reactively (as happened today) rather than on a routine.
5. The stray duplicate `website/api/` folder (Section 3.2) is itself a minor security-hygiene issue: unused code paths that could theoretically be redeployed or referenced by accident should be removed, not left in the repo.

---

## 6. What was found and fixed today (Stripe payment system verification)

This section is the freshest, most concrete part of this handover, written immediately after doing the work, so nothing here is second-hand.

**Bug 1: Vercel's deployment protection was silently blocking Stripe's webhook.** The staging preview deployment had "Vercel Authentication" (a login wall) enabled project-wide. This is invisible when a human clicks through in a browser (their own Vercel login satisfies it), but it blocked Stripe's server-to-server webhook calls outright with an HTTP 401 "Protected deployment" response. Diagnosed by checking Stripe's own Event deliveries log for the webhook endpoint, which showed the exact response body. Fixed by disabling Vercel Authentication in Project Settings -> Deployment Protection.

**Bug 2: the webhook's stored signing secret did not match Stripe's actual current secret.** After fixing Bug 1, webhook deliveries started reaching the endpoint but failed signature verification (400 "Invalid signature"). Fixed by rotating the signing secret in Stripe and carefully re-entering the new value into Vercel's `STRIPE_WEBHOOK_SECRET`, using the clipboard-copy method described in Section 5, then redeploying so the new environment variable took effect.

**Bug 3: production's book-limit mapping was, and still is, wrong.** While verifying a real test purchase, the resulting Supabase row showed plan `plus` with `book_limit: 10` (should be 3). Root cause: the actually-deployed `api/stripe-webhook.js` (root-level, see Section 3.2) had `BOOK_LIMIT_BY_PLAN = { free: 3, plus: 10, pro: 30 }`, introduced by an earlier session's commit that mistakenly believed this matched the live pricing page. It did not; the live pricing page has always read Free 1 book, Plus up to 3, Pro 4 to 10 (Section 2.3). **This was fixed on `staging` today** (`BOOK_LIMIT_BY_PLAN = { free: 1, plus: 3, pro: 10 }`, matching `pricing.html` exactly), verified with a fresh webhook delivery that correctly wrote `book_limit: 3`. **The identical bug still exists in `main`'s copy of `api/stripe-webhook.js` right now, unfixed, confirmed by direct inspection today.** See Section 8, item 1.

**A genuinely small UX bug was also fixed**: the billing modal's upgrade buttons showed only a bare price (for example "$9/mo") with no indication they were clickable calls to action. Relabelled to "Upgrade - $9/mo" style text, pushed to `staging`.

**End-to-end verification performed today**: a real Stripe test-mode checkout was completed (test card), the webhook delivered successfully (HTTP 200), and the resulting Supabase row was confirmed correct (`plan: plus`, `book_limit: 3`, correct Stripe customer and subscription IDs attached). This is the first time this payment system has been verified working end to end; all earlier sessions had only gotten as far as code review and unconfigured environment variables.

---

## 7. Known issues, technical debt, and a note on trusting old documents

### 7.1 A cautionary tale, worth reading

An earlier handover document (6 August) recorded "fixing" the book-limit mapping to `{ free: 3, plus: 10, pro: 30 }`, stating this matched the live pricing page. It did not. The actual live pricing page, both then and now, reads Free 1 book, Plus up to 3, Pro 4 to 10 (confirmed by direct fetch today, and consistent with an even earlier, 5 August handover that correctly recorded those same figures as the source of truth used to build the original Stripe integration). The 6 August session's own notes describe a known risk that likely explains the mistake: fetching `raw.githubusercontent.com` for a branch's current content can silently return stale, CDN-cached data. It appears that session checked pricing against stale cached content, concluded the wrong thing, and "fixed" a bug that didn't exist while reintroducing one that did.

**The lesson for this team: when a past handover document and the live system disagree, trust the live system, and verify pricing/config claims against the actual live page or actual deployed endpoint, not a cached copy or an earlier document's summary of it, including this document.** Everything asserted as fact in this handover was checked against a live system today; anything forward-looking is clearly marked as such.

### 7.2 Other known issues

1. **Duplicate `website/api/` folder** (Section 3.2): stale, unused, but capable of causing exactly this kind of "fixed the file, but not the one that's deployed" confusion. Recommend deleting it.
2. **`main`'s Stripe webhook has the book-limit bug** (Section 6, Bug 3), unfixed as of this writing.
3. **No automated tests anywhere in this codebase.** Every verification to date, including everything in Section 6, has been manual (live requests, manual checkout runs, reading Stripe/Vercel/Supabase dashboards directly).
4. **No `package.json` / dependency manager.** This is a deliberate, longstanding project convention (every third-party API is called via native `fetch`, no `stripe` npm package, no ORM), not an oversight, but it does mean things like Stripe's own SDK conveniences (e.g. `stripe.webhooks.constructEvent`) had to be hand-rolled (Section 3.6) and should be reviewed by whoever inherits this code.
5. **Free-tier Supabase, DIY backups only** (Section 4.5).
6. **The GitHub web-upload/CodeMirror editing method** used throughout this project's history (Section 4.2) is inherently more error-prone than a normal git workflow, and is the root cause of at least two of the bugs described in this document. If real `git push` access is available on the new machine, switching to it should be a near-term priority.
7. **Mobile has not been re-verified** for the billing modal or the rebuilt pricing page (standing project rule: verify mobile before calling a layout change done). This was not possible from this session's browser tooling (a documented, longstanding limitation, not something skipped carelessly) and needs a real phone screenshot from John.

---

## 8. Priority action list

In rough priority order for whoever picks this up next:

1. **Fix `main`'s `api/stripe-webhook.js` book-limit bug** (Section 6, Bug 3) before promoting any payment work to production. One-line fix, already proven correct on staging.
2. **Delete the stray `website/api/` duplicate folder** from both branches, after confirming nothing else references it, to remove the root cause of the confusion in Section 6/7.1.
3. **Run the remaining Stripe test scenarios** on staging that have not yet been tried: cancelling a subscription via the Billing Portal (confirm it correctly reverts the row to Free/1 book), and simulating `invoice.payment_failed` (Stripe's test mode has tools for this), to confirm the admin alert email fires.
4. **Product decision needed**: when to promote Stripe billing from staging to production, and what to do with the "Payment isn't live yet" disclaimer on `pricing.html` at that point (Section 2.4).
5. **Before real launch**: create live-mode Stripe products, prices, and a live-mode webhook endpoint (entirely separate from test mode, nothing carries over), update the hardcoded Price ID maps in both `create-checkout-session.js` and `stripe-webhook.js` together, then promote `staging` to `main` via a pull request.
6. **Test real `git push` access** from the new machine (Section 4.2); if available, migrate off the GitHub-web-UI editing workflow.
7. **Mobile verification** of the billing modal and pricing page (Section 7.2, item 7).
8. **Resume product priorities**: book portfolio opportunity ideas (the standing next item per the product owner, Section 2.4).

---

## 9. Appendix

### 9.1 Credentials checklist (obtain via the account owner, never via chat)

- Stripe: Vybologybooks account login, `acct_1Rfp4sBqkDn8JXbQ`
- Vercel: `product-28/readerbull` project access
- Supabase: "Readerbull" project access, `tqkeqjisqqvxasyzrfax`
- GitHub: `johnhones/readerbull` repo access
- Resend: account access for the transactional-email sending domain
- Anthropic, SerpApi, DataForSEO: platform-billing accounts for the audit pipeline (distinct from any personal accounts)

### 9.2 Prior handover documents in this project folder, and how to weigh them

- `ReaderBull_Stripe_Payment_Handover.md` (5 August): accurate at the time, now superseded by Section 6 of this document.
- `ReaderBull_Handover_2026-08-06.md` (6 August): contains the pricing/book-limit mistake described in Section 7.1. Still useful for its editing-technique notes (Section 3.2/4.2 context) and its keyword-cost-cap work, which has not been contradicted by anything found today.
- `ReaderBull_Session_Handover.md` / `.docx` / `_v3.docx`, `ReaderBull_Next_Chat_Handover_Prompt.md`: earlier engineering handovers, superseded by this document for anything relating to payments or infrastructure; may still hold useful detail on dashboard/scoring work not repeated here.
- `ReaderBull_Project_Rules.md`, `ReaderBull_Infrastructure.md`, `ReaderBull_Product_OS.docx`, `ReaderBull_MVP_Update_01.docx`, `ReaderBull_MVP_Build_Plan.md`, `JOHN_CONTEXT_MASTER.docx`: these remain the standing source-of-truth documents per the project's own rules and were not found to be contradicted by anything today; keep reading these every session as before.

### 9.3 Who to ask

John Hones (product owner) for all product decisions, account access, and anything requiring a judgement call this document flags as open. Contact: coastlvibes@gmail.com.

---

*End of handover. Written to be read cold, without needing this session's chat history. If anything here is unclear or turns out to be wrong once checked against a live system, trust the live system, per Section 7.1.*
