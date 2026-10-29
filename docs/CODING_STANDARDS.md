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

## 5. Styling

- Custom CSS design system: OKLCH tokens + `f-*` utility classes in `globals.css`.
  Tailwind utilities are allowed for layout/spacing; **colors always via tokens**
  (`text-primary`, `bg-card`, …) so themes and dark mode keep working.
- Never hardcode hex/oklch values in components — use the accent/priority/tag class
  helpers (`priorityClass()`, `tagClass()`) or picker components.
- Dark mode = `dark` class on `<html>`, driven by the persisted per-user setting.

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
