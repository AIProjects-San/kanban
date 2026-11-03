# Right-to-Erasure & Data-Retention Notice — TEMPLATE

> **For the workspace owner.** This is a fill-in template, not a published
> notice. The mechanics described below are **what the software actually
> does** (verified against the code: `eraseUser()` in
> `src/server-actions/trash.ts`, the daily maintenance pass in
> `src/lib/audit-prune-core.ts`, the schema cascades in `prisma/schema.prisma`).
> Fill in every `【…】` placeholder, have it reviewed by whoever owns privacy
> compliance for your jurisdiction, then publish it where data subjects can
> find it (e.g. `https://your-domain.example/privacy`).
>
> Related docs: `docs/DEPLOY.md` (operations), `docs/PRODUCTION_READINESS.md`
> §3b PR-38 (the erasure mechanism), `docs/SECURITY.md` (hygiene practices).

---

## 1. Who processes your data

| | |
|---|---|
| Controller | 【company / organisation legal name】 |
| Product | Fernly HR — workspace collaboration & HR module |
| Data subjects | Workspace members (accounts), plus HR-module employees represented in the roster |
| Privacy contact | 【email / DPO contact】 |
| Applicable regime | 【e.g. UK/EU GDPR, NZ Privacy Act 2020 — state which】 |

## 2. What "erase my account" does (two-step, admin-supervised)

Erasure is **deliberately two-step**: an administrator first soft-deletes the
account (recoverable for 【soft-delete window — currently unlimited while in
trash; decide your policy】), then confirms permanent erasure from the trash.
Neither step can be performed by the erased person themselves, and an
administrator cannot erase their own account.

**Permanent erasure deletes:**

- The **account row** — email, name, hashed password, avatar, role, session
  state, notification settings, message read-state, password-reset tokens and
  task assignments (removed by the database's cascade rules).
- The **HR roster profile** — the TeamMember row carrying name, work email,
  avatar and staffing fields.
- **Display identity on shared messages** — the person's name on direct
  messages is replaced with "Erased user".

**Permanent erasure retains (with reasons):**

| Retained data | Why it is kept | Window |
|---|---|---|
| Audit-trail rows naming the action (incl. one `user.erased` record) | Security/incident evidence and administrative integrity; the record documents that an erasure happened, not the erased person's content. | Audit retention below |
| **Message bodies** in team/chat conversations | Counterpart-data integrity: messages were sent TO other people; deleting them would damage other members' records. Sender identity is anonymised (above). | 【owner decision — currently never auto-purged】 |
| **Business records** — tasks, bugs, projects, time entries, calendar events, reminders | They document work products shared with the whole workspace, not the individual's personal data. | 【owner decision — currently never auto-purged】 |
| Time entries / project ownership | Ownership links are cleared to null on erasure; the records remain as workspace history. | 【owner decision】 |

## 3. Automatic retention windows (daily maintenance, 03:00 UTC)

| Data | Window | Notes |
|---|---|---|
| Audit log | **180 days** by default (administrator-settable per workspace, floor **30 days**) | The window is clamped so a misconfiguration cannot wipe recent evidence. |
| Read notifications | **90 days** after being read | Unread notifications are never purged. |
| Message read-state (soft-deleted messages) | **90 days** | Only rows whose message was already soft-deleted. |
| Used password-reset tokens | **24 hours** after use | Incident forensics grace period; expired tokens are removed on the same pass. |
| Soft-deleted (trashed) content | 【decide: auto-purge after N days, or manual-only — currently manual-only】 | Trash is the recovery stage before erasure. |

## 4. What we ask you to decide before publishing

1. **Audit retention** — keep the 180-day default or set your workspace's
   number (Workspace Config → retention; minimum 30 days).
2. **Trash policy** — whether soft-deleted accounts/content auto-purge.
3. **Message & business-record retention** — the system never auto-purges
   these; if your regime requires a bound, schedule an owner review.
4. **Published location + review date** — set the next review of this notice.

## 5. Data-subject request handling

- **Export**: members can export their own data from Settings
  (【confirm the export scope offered by your build】).
- **Erasure**: request via 【contact point】; an administrator verifies
  identity, performs the two-step erasure, and the audit trail records it.
- **Response target**: 【e.g. within 30 days, per GDPR art. 12(3)】.

---

*Template version: PR-42 (production-readiness round 2 continuation).
The retention numbers above are generated from the shipped code —
`deploy-and-ops.test.ts` fails if this table drifts from the constants.*
