# Fernly — Decision Records (ADRs)

Short, dated records of the architectural decisions that shape the codebase. Each entry
states the **decision**, the **context** that forced it, and the **consequences** we
accept. Supersede an ADR by writing a new one and linking back — never edit history.

---

## ADR-001 — HTTP client: native `fetch`, not axios

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** The maintainability review asked whether adopting axios would improve code
maintenance.

**Analysis.**

| Criterion | Native `fetch` | axios |
|---|---|---|
| Call sites in this repo | 1 (Resend API in `src/lib/mailer.ts`) | — |
| Internal data flow | Server Actions (typed RPC, no HTTP layer at all) | — |
| Bundle cost | 0 kB (platform) | ~13 kB gz + types |
| Next.js integration | Native: `cache`/`no-store`, `next.revalidate`, RSC-compatible | Interceptors fight framework caching semantics |
| Timeouts | `AbortSignal.timeout()` (used in mailer since this ADR) | Built-in |

The app has **exactly one** outbound HTTP call. Axios's value (interceptors, instance
defaults, wide REST surface support) pays off at dozens of call sites; at one it is pure
weight, and it would add a dependency to audit (see `scripts/check-audit.mjs`).

**Decision.** Stay on native `fetch`. The single call site is hardened with
`AbortSignal.timeout(10_000)` so a wedged provider cannot stall the password-reset flow.
If a second provider integration arrives (SES, Postmark), extract a typed
`postJson(url, body, {timeoutMs})` helper in `src/lib/` — still no axios.

**Consequences.** No interceptor layer: per-call concerns (auth header, timeout, error
shape) are explicit at the call site. Acceptable at this scale; revisit if outbound HTTP
grows past ~5 call sites.

---

## ADR-002 — UI pattern library: shadcn/ui pattern with local primitives, no component kit

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** The review asked whether a UI pattern library (MUI, Ant Design, Chakra,
full shadcn registry install) should replace hand-built components to reduce code
overhead.

**Analysis.**

- The repo **already follows the shadcn/ui pattern**: `components.json` (new-york
  style, lucide icons), `cn()` in `src/lib/utils.ts` (clsx + tailwind-merge), local
  primitives in `src/components/fernly/` (Modal with focus trap, Field/FormRow,
  StatCard, Toggle, EmptyState, RoleBadge, FilterBar, Section, Avatar, PasswordInput).
  "Code overhead" is already amortized into ~15 reusable primitives.
- A full kit (MUI/AntD/Chakra) would (a) fight the OKLCH token system and four-accent
  theming, (b) add 100–300 kB to the client bundle — directly against the L-P1-17
  bundle-budget gate (`scripts/check-bundle-budget.mjs`: 200 kB main, 250 kB lazy),
  and (c) impose its own design language on a product whose `f-*` classes are the
  design language.
- Local ownership means a11y fixes (L-P1-18 focus trap) land in our files, not behind
  an upstream release.

**Decision.** Keep the shadcn/ui **pattern** with locally-owned primitives. When a new
complex primitive is needed (combobox, date picker), generate it with
`bunx shadcn@latest add <component>` into `src/components/ui/` and restyle to tokens —
copy-in code we own, not a runtime dependency.

**Consequences.** We maintain ~15 primitive files ourselves. In exchange: zero kit
bundle weight, full token/theming control, and the bundle gate stays meaningful.

---

## ADR-003 — Tailwind v4 CSS-first configuration; delete the JS config

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** `tailwind.config.ts` (v3-style) still existed after the Tailwind v4
upgrade. v4 with `@tailwindcss/postcss` ignores it unless a `@config` directive is
present — and it had drifted badly: it declared `hsl(var(--…))` colors while the real
tokens are OKLCH, referenced a `--destructive-foreground` that no longer exists, and
pulled in the v3-only `tailwindcss-animate` plugin (the v4 path uses `tw-animate-css`,
already imported in CSS).

**Decision.** Delete `tailwind.config.ts` and the `tailwindcss-animate` dependency.
All configuration lives in CSS: `@theme inline` in `src/app/globals.css` +
`src/styles/tokens.css`. `tokens-sync.test.ts` asserts the legacy config stays gone.

**Consequences.** One less config file; zero chance of a dead config drifting out of
sync with the live one. Anyone searching for "where is bg-primary defined" has exactly
two CSS files to read.

---

## ADR-004 — Product identity is code, in one config module

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** The product name was hardcoded in 14+ user-facing surfaces (page title,
sidebar, login screen, password-reset emails, ICS PRODID/UID, support email, storage
keys, the error-bridge window key…). Rebranding or white-labelling meant a repo-wide
grep-and-pray.

**Decision.** `src/config/app.ts` is the **single source of truth** for the name,
slug, tagline, support email and identifier domain. It derives `STORAGE_KEYS`,
`ERROR_BRIDGE_KEY`, `DEFAULT_WORKSPACE_NAME` and `DEFAULT_MAIL_FROM`. Every
user-facing surface imports from it; `app-config.test.ts` fails the build if a swept
file stops importing the config. (Internal module paths such as
`@/components/fernly/*` are code identifiers, not branding — they stay.)

**Consequences.** Renaming the product = editing one file. Tests pin the contract so
literals cannot quietly return.

---

## ADR-005 — Design tokens: one CSS file, one typed mirror, one sync test

**Date:** 2026-10-31 · **Status:** ACCEPTED · **Type:** maintainability

**Context.** Color values were duplicated in three places that could silently diverge:
`globals.css` utility classes hardcoded raw OKLCH values for tags/priorities/avatars,
`src/lib/constants.tsx` duplicated the accent colors as inline-style strings, and dark
variants were `.dark .f-tag-*` rule *duplicates* rather than token overrides.

**Decision.**

1. **`src/styles/tokens.css`** — every raw color/radius/shadow value, organized in
   sections (primitives, accent engine, semantic light, semantic dark, tag palette,
   priority palette, avatar palette). Dark mode = token overrides on `.dark`, never
   per-class rules.
2. **`src/styles/tokens.ts`** — typed mirror for the few render-time values JS needs
   (accent swatches, chart/legend anchors). `tokens-sync.test.ts` parses the CSS and
   compares, so drift is a build failure.
3. `globals.css` keeps only: theme wiring (`@theme inline`), base styles, `f-*`
   component classes that reference `var(--…)`, animations. It contains **zero** raw
   color literals (asserted by the sync test).

**Consequences.** Adding a tag/priority/accent is a token edit + (if JS needs it) a
mirror edit; the test enforces the pair. Slightly more indirection when reading a
class definition; vastly less drift risk.

---

## ADR-006 — Secrets: `.env` is the only home; no credential literal is ever committed

**Date:** 2026-10-31 · **Status:** ACCEPTED (enforces a MUST requirement) · **Type:** security

**Context.** The maintainability review set a hard requirement: *all secrets in `.env`,
no hardcoded secrets anywhere*. The audit that followed found: (a) the **real
`NEXTAUTH_SECRET` pasted into a committed unit test**, (b) the demo password hardcoded in the seed, 4 node scripts, 3 shell scripts, the k6
load test, and the e2e suite, (c) the DB password duplicated in a `.env` comment, (d) docs
publishing the demo password.

**Decision.**

1. `.env` (gitignored; `.env.example` documents keys without values) is the **only**
   home for secrets: `DATABASE_URL`, `NEXTAUTH_SECRET`, `RESEND_API_KEY`,
   `NEXT_PUBLIC_DEMO_PASSWORD`, …
2. Tests use obviously-fake values (`obviously-fake-unit-test-secret-…`); the leaked
   production secret was **rotated** and scrubbed.
3. Scripts read the demo password through `scripts/lib/demo-env.mjs` (or
   `NEXT_PUBLIC_DEMO_PASSWORD` for k6/e2e), which **fail loudly** when it is unset.
   Seed refuses to run without it.
4. `login-demo-gating.test.ts` greps seed/e2e/k6 sources for the literal and fails if
   it reappears; the bundle gate greps built output.

**Consequences.** Cloning the repo yields a credential-clean tree (verifiable by
`grep -r <password> .`). Rotating the demo password is a one-line `.env` edit.
Operational cost: contributors must copy `.env.example` first — already required for
`DATABASE_URL`.
