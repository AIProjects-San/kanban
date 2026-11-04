# Security Policy

## Reporting a Vulnerability

We take security bugs seriously. Please report them privately instead of
opening a public issue.

- **Email:** `security@fernly.app` (replace the domain with your real
  production domain before launching — see `src/config/app.ts`).
- **PGP:** (optional — add a fingerprint here if you maintain a key)

Please include:
- A clear description of the issue and its impact.
- Steps to reproduce (proof-of-concept is appreciated but not required).
- The affected version / commit SHA if known.

## Response SLA

| Severity | Acknowledge | First status update | Fix or mitigation |
|---|---|---|---|
| Critical (RCE, auth bypass, data leak) | 24 h | 72 h | 7 days |
| High (privilege escalation, XSS) | 72 h | 7 days | 30 days |
| Medium / Low | 7 days | 30 days | Next release |

Reporters will be credited in the release notes unless they prefer to
remain anonymous. We do not pursue legal action against good-faith
security research.

## Out of Scope

- Issues in third-party dependencies — report upstream (and run
  `bun run audit:check` locally to see known advisories).
- Self-XSS or attacks requiring an already-compromised account.
- Findings from automated scanners without a proof-of-concept.
- Social engineering of staff or users.

## In-Tree Hardening

The full threat model, control inventory, and audit history live in
[`docs/SECURITY.md`](../docs/SECURITY.md). The launch-readiness review
is in [`docs/PRODUCTION_READINESS.md`](../docs/PRODUCTION_READINESS.md).

## Coordinated Disclosure

We ask for a 90-day coordinated disclosure window. We will publish an
advisory in this repository's GitHub Security Advisories tab and credit
the reporter when the fix ships.
