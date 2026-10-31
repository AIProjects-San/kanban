# Fernly — Coding Standards

The rules below are **enforced or verified** where tooling allows, and otherwise reviewed
in PRs. The one-command check is: `bun run lint && bun run typecheck && bun run test`.

---

## 1. Language & types

- TypeScript in **strict** mode; `tsc --noEmit` must pass — never re-enable
  `ignoreBuildErrors` (it shipped a guaranteed runtime crash once; never again).
- No new `any` in server code. Existing `any`s are boundary cases (NextAuth token
  claims) documented inline; tighten them when touching the file.
- Client-facing DTOs live in `src/lib/types/` and are the **only** shapes views may
  consume. Server actions return exactly these (ISO-string dates, never `Date`).
- Shared unions (`Role`, `Permission`, `TaskStatus`, `AuditAction`, …) are defined once
  and imported — never re-declare locally.

## 2. Server actions (the security-critical layer)

Every exported action in a `"use server"` file is a **public HTTP endpoint**. Therefore:

1. **First statement** is an auth call: `requirePermission(…)`, `getSessionOrThrow()` or
   an explicit ownership check. No exceptions.
2. **Never trust action arguments for identity or authorization.** Roles, ids and
   ownership come from `getSession()` only.
3. Validate inputs with a zod schema from `lib/validation.ts` (add the schema there,
   not inline).
4. Mutations must: write an audit entry (`logAudit` with a typed action), call
   `revalidatePath("/")`, and bump the config cache when config tables change.
5. Multi-table writes go inside `db.$transaction`.
6. Errors: throw `AuthorizationError` for permission/validation failures (they carry the
   `digest` marker clients detect). Never leak internal error text to the client.

**Adding a new action — checklist**

```
[ ] permission gate        [ ] zod schema            [ ] ownership/scope check
[ ] $transaction (if multi-write)                    [ ] logAudit (typed action)
[ ] revalidatePath         [ ] unit tests (allow + deny paths)
```

## 3. React components

- **"use client"** only where interactivity requires it; keep logic in server components
  when possible.
- Components ≤ ~250 lines; beyond that, extract sub-components into the same file or a
  sibling under the same directory.
- Reuse the design system in `components/fernly/` (Field, FormRow, FormActions, Toggle,
  StatCard, Section, EmptyState, RoleBadge, Modal, EntityHistorySection, …) — **do not**
  re-implement inline equivalents**; that was the source of 8+ duplicated blocks before.
- Every icon-only button needs an `aria-label`. Every form input is wrapped in `Field`.
- Loading states: `Loader2` spinner pattern; failures: `toast.error(actionErrorMessage(e, fallback))`.
- No direct DOM manipulation; no `dangerouslySetInnerHTML` (security policy).

## 4. State & data flow

- Server data flows **down as props** from the server component; mutations call server
  actions and then `bumpRefresh()`. Do not mirror server data into Zustand.
- Zustand (`store/app-store.ts`) is for view/session state only: active view, modals,
  inbox, palette, shortcuts overlay, theme, refresh counter.
- Effects fetch data only via server actions with a `cancelled` guard (see any modal for
  the pattern).

## 5. Styling & design tokens

- **`src/styles/tokens.css` is the single source of truth** for every color, radius,
  and shadow value (semantic light/dark themes, accent engine, tag / priority /
  avatar palettes — see the file's table of contents). It is imported by
  `src/app/globals.css`, which keeps only theme wiring (`@theme inline`), base
  styles, `f-*` component classes (referencing `var(--…)`), and animations.
- **Never hardcode hex/oklch values** in components or in `globals.css` classes —
  use the `f-*` classes / Tailwind token utilities (`text-primary`, `bg-card`, …).
  A few render-time values JS needs inline (accent swatches, chart anchors) come
  from the typed mirror `src/styles/tokens.ts`.
- `tokens-sync.test.ts` enforces the CSS ↔ TS mirror stays identical **and** that
  `globals.css` contains no raw color literals. If you change a token, change its
  mirror in the same commit or the build goes red.
- Dark mode = token overrides on `.dark` (in tokens.css), **never**
  `.dark .f-*` rule duplicates. Accent themes only re-map the `--accent-*`
  triplet.
- Tailwind is configured **CSS-first (v4)** — there is no `tailwind.config.ts` on
  purpose (ADR-003). Do not reintroduce one.
- Status/tag/priority labels and their classes are defined once in
  `src/lib/config.ts` (`TASK_STATUSES`, `EVENT_TYPES`, `priorityClass()`, …) —
  import them, never redeclare locally.

## 5b. Product identity (branding)

- The product name, slug, tagline, support email and identifier domain live **only**
  in `src/config/app.ts` (`APP`), which also derives `STORAGE_KEYS`,
  `ERROR_BRIDGE_KEY`, `DEFAULT_WORKSPACE_NAME`, `DEFAULT_MAIL_FROM`.
- Any user-visible surface (title metadata, sidebar/logo, emails, ICS PRODID/UID,
  placeholders, 404 copy) **imports from the config** — no `"Fernly"` string
  literals. `app-config.test.ts` pins the swept files; add new surfaces to its
  `CONFIG_CONSUMERS` list. Rebranding = one file (ADR-004).

## 5c. Secrets hygiene (MUST)

- **`.env` is the only home for secrets.** No credential, key, or password literal
  may appear in source, tests, scripts, features, Dockerfiles, or docs
  (ADR-006). Tests use obviously-fake values; scripts that need the demo
  password read it via `scripts/lib/demo-env.mjs` or `NEXT_PUBLIC_DEMO_PASSWORD`
  and fail loudly when unset.
- `.env` is gitignored; `.env.example` documents keys with placeholders. New env
  var → `.env.example` + `SECURITY.md` if security-relevant.
- If a secret ever lands in a commit (even a test fixture): scrub it, **rotate it**,
  and note the incident in `SECURITY.md`.

## 6. Database & Prisma

- Access only through the singleton in `lib/db.ts` (or the `tx` handle inside a
  transaction).
- Schema changes: edit `prisma/schema.prisma` → `bunx prisma validate` →
  `bunx prisma db push` (dev) / migration (prod) → `bunx prisma generate` → update
  `lib/types` DTOs if shapes changed → update seed → update tests.
- Relations: prefer `SetNull` for soft references (task→project), `Cascade` only where
  child rows are meaningless without the parent (assignments, role-permissions).
- No `$queryRaw` in application code (SQL-injection policy).

## 7. Testing

- Every bug fix ships a **regression test** that fails on the old code.
- Security-relevant changes require tests for **both** the allow path and every deny
  path (see `data.test.ts` for the pattern: fixture users ADMIN/MANAGER/MEMBER/OTHER).
- Coverage gates: 90% statements / 80% branches on `src/lib` + `src/server-actions`
  (enforced by `vitest.config.ts`).
- Mock the boundaries (`@/lib/db`, `next-auth`), never the module under test. Use
  `vi.hoisted` for mock factories referenced inside `vi.mock`.
- Component tests: Testing Library, query by role/label, `userEvent` for interaction.

## 8. Dependencies

- Before adding a dependency: justify it against (a) a `lib/` implementation under 50
  lines, (b) an existing dependency, (c) the security surface. Prefer zero-dep code for
  small utilities.
- Architecture-level choices are recorded as ADRs in `docs/DECISIONS.md` — read them
  before re-litigating axios / a UI kit / a Tailwind JS config (ADRs 001–003).
- Unused dependencies are removed in the same PR that orphans them (45 dead UI files and
  49 packages accumulated once — never again).
- Lockfile (`bun.lock`) is committed; updates go through `bun update <pkg>` with the
  full check suite re-run.

## 9. Commits & PRs

- Conventional commits: `feat(tasks): …`, `fix(auth): …`, `test:`, `docs:`, `chore:`.
- PR checklist: lint ✓ typecheck ✓ tests ✓ build ✓ docs updated ✓ migration noted ✓
  audit action registered (for new mutations) ✓.
- Never merge with a red gate. Never disable a gate to "unblock" — fix the issue.

## 10. Documentation

- New view → add a row to `ARCHITECTURE.md` §7 and a manual test section in `TESTING.md`.
- New permission → update `rbac.ts` matrix, the Users page matrix, `PRD.md` §3.
- New audit action → add to `AuditAction` union **and** `ACTION_META` (compile error
  otherwise — by design).
- New env var → `.env.example` + `SECURITY.md` if security-relevant.
