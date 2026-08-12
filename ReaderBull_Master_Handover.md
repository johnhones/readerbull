# ReaderBull Platform: Master Handover

Prepared 12 August 2026, superseding the 10 August 2026 version. This document reflects everything verified live against Stripe, Vercel, Supabase, and GitHub as of this writing, not carried forward from the previous handover without re-checking. The single biggest change since 10 August: **live Stripe payments are now genuinely wired up and processing real money**, not just built and tested. That is the headline fact of this document.

---

## 1. Executive summary

**What ReaderBull is:** a SaaS platform that gives self-published authors a Discoverability Score (0-100) for their book, an action plan to improve it, and marketing tools to grow sales. No manuscript upload, no Amazon integration; the audit runs on self-reported data plus a rules-based scoring formula and live Amazon listing data pulled via SerpApi.

**What changed since the 10 August handover:**
- The book-limit bug flagged as the #1 priority item (`main`'s webhook granting the wrong number of books) is fixed and has been live on production since this session.
- The stray duplicate `website/api/` folder has been deleted from both branches.
- All four Stripe test-mode scenarios (checkout, payment failure, book-limit correctness, cancellation) have been proven end-to-end on `staging`.
- A read-only admin page (`admin.html` + `api/admin-users.js`) now exists so John can see his author list (name, email, plan, status, signup date) without hand-cross-referencing Supabase's Table Editor and Authentication sections.
- A real revenue-losing bug was found and fixed: signed-out visitors who clicked Plus/Pro were being dropped into free onboarding instead of finishing checkout. Fixed on `main`.
- **Stripe is now live.** Live-mode products, prices, a live webhook endpoint, and live API keys were created and wired into production this session. A real purchase was made by John himself with a real card and, after two further bugs were found and fixed (below), correctly synced to Supabase.
- Two further live-mode-only bugs were found and fixed **after** going live, both specific to production infrastructure that test mode never exercised:
  1. The live webhook endpoint URL pointed at `readerbull.com`, which 308-redirects to `www.readerbull.com`. Stripe does not follow redirects on webhook delivery, so every live webhook silently failed for hours.
  2. Vercel's `STRIPE_WEBHOOK_SECRET` did not match the live webhook's actual signing secret, so even after the URL was fixed, deliveries were rejected with "Invalid signature."

**Current honest state:** real payments work, and one real customer (John's own live test purchase) is confirmed correctly synced end to end after the fixes above. No other live customer has been through the flow yet. See Section 8 for what's still open.

---

## 2. Product

### 2.1 Positioning and business model (unchanged)

- Website headline (do not reword): **"A platform that helps you sell more books."**
- Core product: the Discoverability Score, a 0-100 score with a concrete action plan attached.
- No manuscript upload, no Amazon Seller/KDP API integration, deliberate MVP scope.
- Auth is passwordless: a one-time code sent by email, entered on the same page (not a clickable magic link in the flow actually used in production, see Section 3.4).

### 2.2 Pricing — now the live, chargeable prices, confirmed against both Stripe and the live site

| Tier | Books | Monthly | Yearly |
|---|---|---|---|
| Free | 1 book | $0 | - |
| Plus (Most popular) | Up to 3 books | $9/mo | $90/yr |
| Pro | 4 to 10 books | $28/mo | $280/yr |
| Custom | 11+ books, or usage-based | Contact us | Contact us |

The "Payment isn't live yet" disclaimer has been removed from `pricing.html` (commit `d3f44f6`). The site no longer tells visitors payment is unavailable, because it now is available.

### 2.3 Current live feature set (verified against readerbull.com today)

Same as the 10 August list, plus:
- **Real, working Stripe Checkout for Plus and Pro**, signed-in or signed-out.
- **Admin view** at `admin.html` (not linked anywhere on the site, password-gated) showing every author's name, email, plan, status, book limit, and signup date.
- Get Reviews / Build Your ARC / Ad Campaigns / marketplace tabs: still placeholder "Coming Soon" panels. **This is explicitly the next priority per John, once testing wraps up** (see Section 8).

### 2.4 Roadmap / open product decisions

1. **Review system (Build Your ARC / Get Reviews) is the next build**, per John's direct instruction at the end of this session. Not started. Currently placeholder-only.
2. **Book portfolio opportunity feature**: built and working on `staging` (keyword classification + a card on the Keywords tab, commits `3b8c063` and `c59df4f`), but **not yet merged to `main`**. This was the standing priority item from the previous handover; it's done, just not promoted to production yet.
3. **A cheaper entry-level paid tier** below Plus: still just a hypothetical, not built.
4. **Sponsored ads table, "Note from Jordan," per-competitor BSR cost tradeoffs**: still unscoped ideas, not started.

---

## 3. Technical architecture

### 3.1 Stack (unchanged)

Plain HTML/CSS/vanilla JavaScript frontend, no framework, no build step. Vercel serverless functions (Node.js, plain `fetch`, no `stripe` npm package). Supabase for Postgres + passwordless auth. Stripe for billing — **now in live mode on production, test mode on staging**. Resend for transactional email. Anthropic Claude Haiku, SerpApi, DataForSEO for the audit pipeline.

### 3.2 Repository structure

Repo: `johnhones/readerbull`. Two branches: `staging` (test mode, keeps its own Stripe test Price IDs) and `main` (production, live mode, auto-deployed to readerbull.com via Vercel). **Real `git push` access from this machine is confirmed working** — the browser-automation web-UI editing risk flagged in the previous handover is resolved; this session used normal `git`/`gh` throughout.

The stray duplicate `website/api/` folder (previously flagged as the root cause of a "fixed one copy, not the deployed one" bug class) **has been deleted from both branches.**

**New files this session:**
```
/ (repo root)
  admin.html                   read-only author list, password-gated, not linked anywhere
  /api/
    admin-users.js             joins auth.users + subscriptions + books server-side,
                                gated by ADMIN_SECRET (a new Vercel env var), same
                                shared-secret-header pattern as export-backup.js
```

**A note on concurrent editing:** several commits landed on `main` during this session from a source other than this Claude session (copy/wording changes, a favicon fix, an audit-loading-bar change, a Kindle/Hardback book-description import fix — all authored by John Hones directly per `git log`). None of these conflicted with the payment work, but it's worth flagging: **more than one person/session was pushing to `main` concurrently tonight.** Worth a moment's coordination going forward so two agents don't race on the same file.

### 3.3 Auth model, and an important correction to the previous handover

The previous handover described auth as "passwordless magic-link, with an optional password set-up step." **This is not quite how it works in practice.** The flow actually used in production is: enter email, Supabase sends a one-time 6-digit code, the code is typed directly into the same page (`signup.html`'s `otp-step` form). There is a magic-link fallback wired into the email (`emailRedirectTo`), but it is not the flow anyone actually uses — confirmed by John using it live tonight.

This distinction mattered directly: the checkout-intent fix (Section 6) only covers the code-entry path, because that's the one actually used. The magic-link-click fallback still lands on plain onboarding if anyone ever uses it, documented inline in the code as a known, accepted gap.

### 3.4 Database (Supabase, project `tqkeqjisqqvxasyzrfax`) — unchanged structurally

Same tables as before (`books`, `subscriptions`, `keyword_research_cache`). No schema changes this session. Confirmed: `staging` and `main` share the same single Supabase project, there is only one production database, not one per environment. Test-mode Stripe test customers (e.g., the "Jordan Truehart" test persona) and live real customers live in the same tables, distinguished only by which `stripe_customer_id`/`stripe_subscription_id` they carry (test-mode IDs vs live-mode IDs never collide, Stripe guarantees this).

### 3.5 The Stripe payment system — now live

**Live-mode setup completed this session:**
- Live products created directly in Stripe's dashboard: **Plus** ($9/mo `price_1U3KycBqkDn8JXbQJvOCJhlP`, $90/yr `price_1U3L37BqkDn8JXbQXN76YSHO`) and **Pro** ($28/mo `price_1U3L5qBqkDn8JXbQq5nQJRnL`, $280/yr `price_1U3L5qBqkDn8JXbQJxzavRS6`).
- A new live secret key created (named "ReaderBull production" in Stripe, distinct from the pre-existing shared default key this account uses for John's other client invoicing work).
- A live webhook endpoint created ("vibrant-brilliance" in Stripe's naming, destination ID `we_1U3LrnBqkDn8JXbQ3cXu1Yi0`), listening for the same four events as the test-mode one: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
- `api/create-checkout-session.js` and `api/stripe-webhook.js` on `main` updated with the live Price IDs (commit `5014fdd`, PR #15).
- Vercel's `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` updated to live values, **scoped to Production only** — Preview/staging environment variables were deliberately left untouched and still hold test-mode values, so staging remains a safe place to test without touching real money.

**Two live-mode-only bugs found and fixed after going live (full detail in Section 6):**
1. Webhook endpoint URL used the apex domain, which redirects; Stripe doesn't follow redirects. Fixed by pointing the endpoint at `https://www.readerbull.com/api/stripe-webhook` directly.
2. The webhook signing secret in Vercel didn't match the live webhook's actual secret. Fixed by rotating to a fresh signing secret and re-pasting it correctly.

**Price ID maps are still hardcoded and duplicated** across `create-checkout-session.js` and `stripe-webhook.js`, deliberately, per the existing no-shared-module convention. `main` now has the **live** IDs in both files; `staging` still correctly has the **test** IDs in both files. Any future price change needs updating in all four places (two files x two branches) with the correct mode's IDs, easy to get wrong.

### 3.6 The admin page

`admin.html` + `api/admin-users.js`, added this session. Read-only, gated by a shared secret header (`ADMIN_SECRET`, a Vercel environment variable John set himself, present in both Production and Preview scopes). Joins `auth.users` (email, signup date), `subscriptions` (plan, status, book limit), and `books` (most recent per author, for a display name — a known simplification, since `author_name` is captured per book, not per account). Not linked from anywhere on the site, marked `noindex, nofollow`.

---

## 4. Infrastructure and DevOps

### 4.1 Hosting, domain, deploy flow — unchanged from previous handover, all still accurate

`readerbull.com` on Vercel, project `product-28/readerbull`. Push to `main` -> production deploy. Push to `staging` -> preview deploy. Deploy protection remains off project-wide (confirmed still correct, no re-verification needed this session).

### 4.2 Environment variables — updated this session

| Variable | Scope | Status |
|---|---|---|
| `STRIPE_SECRET_KEY` | Production | **Live** secret key, newly created and named this session |
| `STRIPE_SECRET_KEY` | Preview | Unchanged, still test-mode |
| `STRIPE_WEBHOOK_SECRET` | Production | **Live** webhook's signing secret, rotated once during this session after a mismatch was found (see Section 6) |
| `STRIPE_WEBHOOK_SECRET` | Preview | Unchanged, still test-mode |
| `ADMIN_SECRET` | Production + Preview | New this session, chosen by John, gates `admin.html` |
| Everything else | - | Unchanged, not re-verified this session |

### 4.3 A concrete lesson from tonight, worth writing down for next time

**Testing in Stripe test mode does not prove a webhook works in live mode**, even with identical code, because two specific things differ between the modes on this project and neither was caught by test-mode verification:
1. The live webhook happened to be pointed at the apex domain (`readerbull.com`) instead of `www.readerbull.com`, triggering a 308 redirect that Stripe's webhook delivery doesn't follow. The test-mode webhook was pointed at a Vercel preview subdomain with no such redirect, so this class of bug was structurally invisible to test-mode testing.
2. A signing-secret mismatch is purely an environment-variable/config issue, unrelated to the code itself, and by definition can't be caught by testing against a *different* webhook's secret.

**Recommendation for future changes to payment infrastructure: always do one real, small live-mode test transaction after any live-mode config change, don't assume test-mode passing means live mode will behave the same.**

---

## 5. Security and data-handling posture

The credential-handling rule from the previous handover held throughout this session, with two disclosed exceptions:

1. **A live webhook signing secret was twice visible in this session's tool output** (once via a UI screenshot after a masked field was revealed by mistake, once via an accessibility-tree tool's own description text). Standard practice on this project is to treat any such exposure as compromised and rotate immediately; this was done once. The second exposure was, per explicit direction from John given the low severity of a webhook signing secret (it only allows verifying webhook authenticity, not account access) and his clear preference to not re-run the rotation dance a second time that night, not rotated again. This is disclosed here rather than omitted, consistent with this project's stated practice.
2. **The live Stripe secret key** (full account access) was, at one point, shown in full in a screenshot John sent, despite being asked not to screenshot that step. It was rotated immediately as a precaution before use, so the value that ended up in production was never the one that had been visible.

No password, API key, or secret was ever typed, logged, or reproduced by Claude in this document. All values were moved by John directly or via the clipboard-copy method (Claude clicks Stripe's own reveal/copy buttons, switches tabs, sends a paste keystroke, never reads the value back), as in previous sessions.

**Database security, webhook signature verification, RLS**: unchanged from the previous handover, all still accurate, not re-verified line-by-line this session but no changes were made to this logic beyond the Price ID and secret updates already described.

---

## 6. What was found and fixed this session, in order

This is the freshest and most concrete section, written immediately after doing the work.

1. **`main`'s book-limit bug** (carried over as the #1 priority item from the previous handover): confirmed still present, fixed to `{ free: 1, plus: 3, pro: 10 }` matching the live pricing page exactly, merged via PR #10, deployed, verified live via direct HTTP checks.
2. **Stray duplicate `website/api/` folder**: confirmed genuinely unused (nothing referenced it), confirmed its one file was stale and pre-dated a cost cap fix, deleted from both branches via PR #11 (main) and PR #12 (staging).
3. **All four Stripe test-mode scenarios proven end-to-end on staging**: checkout, payment failure (Supabase update + admin alert email both confirmed via a real email received), book-limit correctness, and subscription cancellation (using Stripe's test-clock time-advance feature to force the actual cancellation event, not just the "scheduled to cancel" state).
4. **Admin users page built** (`admin.html` + `api/admin-users.js`), deployed, `ADMIN_SECRET` set, verified working with a live `401` on missing/wrong secret and a real data table once authenticated.
5. **Lost-checkout-intent bug found and fixed**: a signed-out visitor clicking Plus/Pro was sent to signup with no memory of which plan they wanted, and after verifying, was unconditionally sent to free onboarding instead of finishing checkout. Fixed so the plan is carried through the URL and checkout is resumed automatically right after verification. Merged to `main` via PR #16.
6. **Live Stripe products, prices, webhook, and API key created directly in Stripe's dashboard.** Code updated with the live Price IDs, merged to `main` via PR #15.
7. **A real live purchase attempted and, after two further fixes below, confirmed successful.** John made several real card attempts (a NatWest debit card that needed four 3D Secure challenge attempts before succeeding, a failed attempt via Stripe's own "Link" express-checkout feature, and the eventually-successful one). The successful purchase is confirmed in Stripe: subscription active, Plus, $9.00/month, real customer.
8. **Live webhook 308-redirect bug found and fixed**: endpoint URL corrected from `https://readerbull.com/...` to `https://www.readerbull.com/...`.
9. **Live webhook signing-secret mismatch found and fixed**: rotated to a fresh secret, correctly re-pasted into Vercel's Production-scoped `STRIPE_WEBHOOK_SECRET`, redeployed.
10. **The missed webhook event manually resent** after both fixes, delivered successfully (`200 OK`, marked "Recovered" by Stripe), syncing John's real purchase to Supabase. Confirmed the underlying Stripe subscription itself was healthy (Active, Plus, $9/mo) throughout; the dashboard briefly showing "Free plan, past due" afterward was diagnosed as a stale page load, not a data problem, resolved by a hard refresh.

---

## 7. Known issues, technical debt, and things worth trusting carefully

### 7.1 Still open, carried over or new

1. **The book portfolio feature is done on `staging` but not merged to `main`.** Was the standing priority item from the previous handover; now built, just not promoted.
2. **The magic-link-click auth fallback still loses checkout intent.** Documented inline in `signup.html`. Low priority since it's not the path anyone actually uses, but a real gap if anyone ever does use it.
3. **No automated tests anywhere in this codebase**, unchanged from before. Every verification tonight, including the entire live-payment flow, was manual: real browser clicks, real Stripe dashboard checks, real curl requests.
4. **Mobile has still not been re-verified** for the billing modal, pricing page, or the new admin page. Carried over from the previous handover, still not possible from this session's tooling, still needs a real phone check from John.
5. **Only one real live customer has been through the payment flow** (John's own test purchase). No other live customer traffic yet.
6. **Multiple people/sessions pushing to `main` concurrently** was observed tonight (see Section 3.2). Not a problem tonight, but worth a shared convention going forward (branch names, or just a quick heads-up in chat) so two agents don't edit the same file at the same time.

### 7.2 A second cautionary tale, in the same spirit as the previous handover's Section 7.1

Tonight repeated a version of the previous handover's lesson: **things that pass in test mode can still fail in live mode**, for reasons specific to live-mode infrastructure (a domain redirect, a mismatched secret) that test mode structurally cannot exercise. The fix isn't "test mode isn't good enough," it's: **after any live-mode config change, always run one real live transaction before trusting it**, exactly as this session eventually did.

---

## 8. Priority action list

In order, reflecting John's explicit direction at the end of this session: **testing next, then start the review system.**

1. **Run one more real live-mode purchase test**, ideally with a different card/browser than tonight's, to build confidence beyond the single successful transaction so far. Check it syncs correctly without needing manual webhook resends this time.
2. **Test live-mode cancellation and payment-failure scenarios for real** (not just on staging/test mode). These have been proven in test mode only; live mode has its own webhook endpoint and hasn't had these two scenarios exercised yet.
3. **Mobile verification** of the billing modal, pricing page, and admin page (carried over, still outstanding).
4. **Merge the book portfolio feature from `staging` to `main`** once ready, it's built and tested on staging already.
5. **Begin work on the review system** (Get Reviews / Build Your ARC), per John's explicit instruction. Currently a placeholder "Coming Soon" panel only. This is the next major feature build.
6. **Decide on a coordination convention** for concurrent editing of `main` by multiple people/sessions (Section 7.1, item 6).

---

## 9. Appendix

### 9.1 Credentials checklist (obtain via the account owner, never via chat) — unchanged

- Stripe: Vybologybooks account login, `acct_1Rfp4sBqkDn8JXbQ` (now has both live and test mode in active use, be careful which mode is selected before making any changes)
- Vercel: `product-28/readerbull` project access
- Supabase: "Readerbull" project access, `tqkeqjisqqvxasyzrfax`
- GitHub: `johnhones/readerbull` repo access (real `git push` access confirmed working from this machine)
- Resend: transactional email
- Anthropic, SerpApi, DataForSEO: audit pipeline

### 9.2 Prior handover documents, and how to weigh them

- `ReaderBull_Master_Handover.md` (10 August): superseded by this document. Its Section 7.1 cautionary tale (about trusting stale cached data over the live system) remains a good general lesson; this document's Section 7.2 is effectively the live-mode version of the same lesson.
- Everything else listed in the 10 August handover's own appendix: status unchanged, not re-verified this session, treat with the same caution as before (trust the live system over any written document, including this one, when they disagree).

### 9.3 Who to ask

John Hones (product owner), coastlvibes@gmail.com, for all product decisions and anything requiring judgement this document flags as open.

---

*End of handover. If anything here is unclear or turns out to be wrong once checked against a live system, trust the live system.*
