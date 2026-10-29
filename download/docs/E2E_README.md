# Fernly E2E — Selenium + Cucumber (Node.js)

Browser end-to-end tests driven by [Cucumber.js](https://cucumber.io/docs/installation/javascript/)
and [Selenium WebDriver](https://www.selenium.dev/documentation/webdriver/).

## What is covered

| Feature file         | Scenarios                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `login.feature`      | valid sign-in, wrong password, unknown email, empty fields, brute-force lockout (5 → block) |
| `rbac.feature`       | admin vs member sidebar, project-create button gating, member workspace scoping            |
| `tasks.feature`      | create task, drag to another Kanban column, delete task                                    |
| `messaging.feature`  | send message, recipient inbox visibility, third-party inbox isolation                      |

## Prerequisites

1. **Chrome or Chromium** installed locally (or `SELENIUM_BROWSER=firefox` with Firefox).
2. **The app running** with a seeded database:

   ```bash
   bun run db:seed
   bun run dev          # http://localhost:3000
   ```

3. If the app runs elsewhere, point the suite at it:

   ```bash
   BASE_URL=https://your-deployment.example.com bun run test:e2e
   ```

## Running

```bash
bun run test:e2e              # headless Chrome against BASE_URL (default localhost:3000)
SELENIUM_HEADLESS=0 bun run test:e2e   # watch the browser
```

Failed scenarios automatically capture a screenshot into the Cucumber report.

## Environment variables

| Variable            | Default                  | Purpose                          |
| ------------------- | ------------------------ | -------------------------------- |
| `BASE_URL`          | `http://localhost:3000`  | Target app instance              |
| `SELENIUM_BROWSER`  | `chrome`                 | `chrome` \| `firefox` \| `edge`  |
| `SELENIUM_HEADLESS` | `1`                      | `0` opens a visible browser      |

## Design notes & honest limitations

- **Sequential by default** (`parallel: 0`): the suite shares one database, so
  parallel scenarios would race on shared state (e.g. the brute-force lockout
  test pollutes the login rate limiter for its email/IP window). Give each
  run a fresh seed if a scenario unexpectedly fails.
- The **lockout scenario depends on the in-memory limiter** — restarting the
  server between runs resets the counters.
- Step definitions prefer **roles, labels and keyboard shortcuts** over CSS
  classes, but the app's modal buttons still rely on text matching; if a
  button label changes, update the corresponding XPath.
- This sandboxed CI environment has **no browser installed**, so the suite is
  **not** part of the default `bun test`/`vitest` run — it must be executed on
  a machine with Chrome. The unit/integration suites
  (`src/**/*.test.ts`) cover the same authorization logic at the action layer
  and *do* run everywhere.
