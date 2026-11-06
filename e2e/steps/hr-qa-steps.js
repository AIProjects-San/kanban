// Steps for the QA-hardening feature (e2e/features/hr-qa-hardening.feature).
//
// These are the adversarial probes from docs/QA_FINDINGS_HR.md — each step
// reuses the exact helpers the hr-* step files use (imported from
// hr-steps.js) so the two suites can never drift apart.

const { When, Then, Before } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  mondayAtLeast,
  waitForToast,
  rowWithReason,
} = require("./hr-steps");

// ---------------------------------------------------------------------------
// State isolation — the QA scenarios are adversarial by design, so a failed
// or interrupted run leaves APPROVED "QA …" requests behind that permanently
// debit the member's balance. A naive re-run then hits the client-side
// balance guard (submit disabled) and fails somewhere completely different
// (poisoned-state cascade — exactly what happened in the first QA session).
// Every @hr-qa scenario therefore starts from a known baseline: QA-prefixed
// leave requests are deleted and any balance they debited is restored.
// ---------------------------------------------------------------------------

Before({ tags: "@hr-qa" }, async function () {
  // The cucumber process is not run through scripts/run-with-env.sh, so the
  // datasource URL has to be resolved here with the SAME precedence that
  // wrapper implements: .env overrides the system environment when it exists
  // (this sandbox exports a platform-wide DATABASE_URL pointing at a
  // different sqlite file — db/custom.db — which would silently hit the
  // wrong database), while CI injects its own DATABASE_URL and has no .env
  // (it is gitignored), so the environment wins there.
  const envFile = path.join(__dirname, "..", "..", ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/);
      if (m) process.env.DATABASE_URL = m[1];
    }
  }
  const { PrismaClient } = require("@prisma/client");
  console.log("[qa-cleanup] effective DATABASE_URL:", process.env.DATABASE_URL);
  const db = new PrismaClient();
  try {
    const stale = await db.leaveRequest.findMany({ where: { reason: { startsWith: "QA " } } });
    for (const r of stale) {
      if (r.status === "APPROVED") {
        const year = r.startDate.getUTCFullYear();
        const bal = await db.leaveBalance.findUnique({
          where: { userId_leaveTypeId_year: { userId: r.userId, leaveTypeId: r.leaveTypeId, year } },
        });
        if (bal) {
          await db.leaveBalance.update({
            where: { userId_leaveTypeId_year: { userId: r.userId, leaveTypeId: r.leaveTypeId, year } },
            data: { used: { decrement: Math.min(r.days, bal.used) } },
          });
        }
      }
      await db.leaveRequest.delete({ where: { id: r.id } });
    }
    if (stale.length > 0) {
      console.log(`[qa-cleanup] removed ${stale.length} stale QA request(s) and restored their balances`);
    }
  } finally {
    await db.$disconnect();
  }
});

/**
 * Read the CURRENT available-days number from a balance card. The QA
 * scenarios assert RELATIVE deltas ("dropped by 12") instead of absolute
 * numbers — the seeded balance differs between a fresh seed (20 available)
 * and the state left by the hr-leave feature that runs earlier in the full
 * suite (18 available), and the scenario must hold in BOTH.
 */
async function readBalanceAvailable(driver, typeName) {
  await driver.wait(
    async () =>
      (await driver.findElements(
        By.xpath(`//div[contains(@class, "f-card")][contains(., "${typeName}")]//*[@data-testid='balance-available']`),
      )).length > 0,
    10_000,
    `balance card for "${typeName}" not found`,
  );
  const el = await driver.findElement(
    By.xpath(`//div[contains(@class, "f-card")][contains(., "${typeName}")]//*[@data-testid='balance-available']`),
  );
  return Number((await el.getText()).trim());
}

Then("I note the current leave balance for {string}", async function (typeName) {
  const driver = await this.getDriver();
  this.qaNotedBalance = await readBalanceAvailable(driver, typeName);
});

Then("the leave balance for {string} should have dropped by {int} days", async function (typeName, drop) {
  const driver = await this.getDriver();
  // POLL: the mutation's server action may still be in flight when this
  // step starts — the earlier one-shot read raced the client refresh and
  // failed even though the DB was already correct.
  await driver.wait(
    async () => (await readBalanceAvailable(driver, typeName)) === this.qaNotedBalance - drop,
    10_000,
    `balance for "${typeName}" never showed the noted ${this.qaNotedBalance} minus ${drop}`,
  );
});

Then("the leave balance for {string} should be back at the noted value", async function (typeName) {
  const driver = await this.getDriver();
  // POLL for the same reason — the cancel's balance restore lands on the
  // server before the client's balance cards refresh.
  await driver.wait(
    async () => (await readBalanceAvailable(driver, typeName)) === this.qaNotedBalance,
    10_000,
    `balance for "${typeName}" never returned to the noted ${this.qaNotedBalance}`,
  );
});

/**
 * Wait until no dialog (nor its backdrop) is mounted. After a successful
 * submission the modal unmounts asynchronously — clicking "Request Leave"
 * again too early is intercepted by the leftover backdrop.
 */
async function waitForNoDialog(driver) {
  await driver.wait(
    async () =>
      (await driver.findElements(
        By.xpath("//div[contains(@class, \"backdrop-blur-sm\") or @role='dialog']"),
      )).length === 0,
    10_000,
    "a dialog or its backdrop is still mounted",
  );
}

// ---------------------------------------------------------------------------
// QA-1 — leave overdraft guard
// ---------------------------------------------------------------------------

/**
 * Request `workingDaysCount` Mon–Fri days starting from a Monday at least
 * `daysOut` days from today. The end date walks forward until the requested
 * number of working days (inclusive of both range ends) is covered — the
 * server counts working days the same way (hr-shared.ts workingDays),
 * including the F1.1 holiday exclusions (e2e/support/holidays.js mirrors
 * the seeded calendar so the walk and the server always agree).
 */
/** Shared body of the QA request steps: compute a working-day range from
 * `monday`, submit it, and fail loudly when the client-side balance guard
 * kept the form open (precondition break, not a timing issue). Stashes the
 * range on the world for the same-year step below. */
async function qaRequestRange(world, typeName, monday, workingDaysCount, reason) {
  const { isHoliday } = require("../support/holidays");
  const end = new Date(monday.getTime());
  let counted = 0;
  for (;;) {
    const dow = end.getUTCDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(end)) counted += 1;
    if (counted >= workingDaysCount) break;
    end.setUTCDate(end.getUTCDate() + 1);
  }
  const { submitRange } = require("./hr-steps");
  await waitForNoDialog(await world.getDriver());
  await submitRange(world, typeName, monday, end, reason);
  world.lastE2ERangeEnd = end;
  world.lastE2EYear = monday.getUTCFullYear();
  // The client-side balance guard disables the submit button when the
  // requested days exceed the CURRENT year's remaining balance — a click
  // on a disabled button silently does nothing and the request is never
  // submitted. Fail loudly instead of letting the scenario drift into an
  // unrelated timeout two steps later.
  const driver = await world.getDriver();
  const stillOpen = await driver.findElements(By.css("#leave-type"));
  if (stillOpen.length > 0) {
    const balText = await driver
      .findElement(By.xpath(`//span[contains(@class, "tabular-nums")]`))
      .getText()
      .catch(() => "(balance text not found)");
    throw new Error(
      `leave form still open after submit — the button was likely disabled by the balance guard (${balText}). ` +
        `Precondition broken: check for leftover APPROVED requests debiting the balance.`,
    );
  }
}

When(
  "I request {string} from a Monday {int} days out for {int} working days with reason {string}",
  async function (typeName, daysOut, workingDaysCount, reason) {
    await qaRequestRange(this, typeName, mondayAtLeast(daysOut), workingDaysCount, reason);
  },
);

/**
 * Same as above, but GUARANTEES the request starts in the same UTC year as
 * the scenario's previous Monday-based request. F1.1's holiday-week
 * skipping can push a far-future Monday across the year boundary — and a
 * cross-year request debits the NEXT year's balance (QA-7 behavior), which
 * silently breaks the QA-1 overdraft premise of "two requests together
 * exceeding ONE year's balance". When the year jumped, try candidate
 * Mondays of the anchor year walking back from its end (a holiday-week
 * START is fine — the day-count walk skips inner holidays, and only the
 * start year matters for the balance); a candidate whose range overlaps
 * another feature's leftover active request is rejected at the form, which
 * reads as "still open" and moves on to the previous Monday. When no
 * candidate works (suite running close to year end), the scenario reports
 * pending — the overdraft guard itself stays pinned by the hr-leave unit
 * tests, and QA-7 covers the cross-year behavior.
 */
When(
  "I request {string} from a Monday {int} days out for {int} working days in the same year as my last request with reason {string}",
  async function (typeName, daysOut, workingDaysCount, reason) {
    assert.ok(this.lastE2EYear, "no previous Monday-based request was made in this scenario");
    const anchorYear = this.lastE2EYear;
    const prevEnd = this.lastE2ERangeEnd;
    let monday = mondayAtLeast(daysOut);
    if (monday.getUTCFullYear() === anchorYear) {
      await qaRequestRange(this, typeName, monday, workingDaysCount, reason);
      return;
    }
    // Year jumped — walk candidate Mondays of the anchor year, newest first.
    let candidate = new Date(Date.UTC(anchorYear, 11, 31));
    while (candidate.getUTCDay() !== 1) candidate.setUTCDate(candidate.getUTCDate() - 1);
    for (let tries = 0; tries < 10; tries += 1) {
      if (candidate.getTime() > prevEnd.getTime()) {
        const submitted = await tryQARange(this, typeName, candidate, workingDaysCount, reason);
        if (submitted) return;
      }
      candidate.setUTCDate(candidate.getUTCDate() - 7);
    }
    return "pending";
  },
);

/** One submit attempt that may legitimately be rejected (overlap with a
 * leftover active request). Returns true when the request was submitted;
 * on rejection closes the form and returns false so the caller can try an
 * earlier Monday. */
async function tryQARange(world, typeName, monday, workingDaysCount, reason) {
  const { isHoliday } = require("../support/holidays");
  const end = new Date(monday.getTime());
  let counted = 0;
  for (;;) {
    const dow = end.getUTCDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(end)) counted += 1;
    if (counted >= workingDaysCount) break;
    end.setUTCDate(end.getUTCDate() + 1);
  }
  const { submitRange } = require("./hr-steps");
  const driver = await world.getDriver();
  await waitForNoDialog(driver);
  await submitRange(world, typeName, monday, end, reason);
  const stillOpen = await driver.findElements(By.css("#leave-type"));
  if (stillOpen.length === 0) {
    world.lastE2ERangeEnd = end;
    world.lastE2EYear = monday.getUTCFullYear();
    return true;
  }
  // Rejected at the form (overlap / balance) — close it and report.
  const close = await driver.findElement(
    By.xpath(`//div[@role='dialog']//button[@aria-label='Close dialog']`),
  );
  await close.click();
  await driver.sleep(400);
  return false;
}

/** Drive the Decide → Approve path WITHOUT waiting for a success toast. */
When("I try to approve the request with reason {string}", async function (reason) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(rowWithReason(reason)),
    10_000,
    `queue row with reason "${reason}" not found`,
  );
  await row.findElement(By.xpath(`.//button[contains(., "Decide")]`)).click();
  await driver.wait(until.elementLocated(By.css("[data-testid='approve-request']")), 10_000, "decision modal did not open");
  await driver.findElement(By.css("[data-testid='approve-request']")).click();
});

/**
 * The approval must be refused with the insufficient-balance message and the
 * decision modal must stay open (a success closes it) — then we close it so
 * later steps get a clean DOM.
 */
Then("the approval should fail with an insufficient-balance error", async function () {
  const driver = await this.getDriver();
  await waitForToast(driver, "insufficient balance");
  await driver.sleep(400); // let the modal settle on the failed path
  const modalOpen = await driver.findElements(By.css("[data-testid='approve-request']"));
  assert.strictEqual(modalOpen.length, 1, "the decision modal closed — the approval apparently succeeded");
  // Close the modal via its header X (the decision modal has no "Cancel"
  // button — only Reject / Approve) and WAIT for the unmount, so later
  // steps can never be intercepted by the leftover backdrop.
  await driver
    .findElement(By.xpath(`//div[@role='dialog']//button[@aria-label='Close dialog']`))
    .click();
  await driver.wait(
    async () => (await driver.findElements(By.css("[data-testid='approve-request']"))).length === 0,
    10_000,
    "the decision modal did not close after clicking X",
  );
});
