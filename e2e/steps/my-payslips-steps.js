// Steps for the payslip self-service feature (persona-audit P0-1 / D-02).
// Every step runs as a MEMBER (yuki@fernly.app) — the persona that was
// completely locked out of payslip data before this fix. Retry-safety: all
// steps are read-only, so a cucumber retry on a shared seeded DB is safe.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

/** Current month label exactly as the app renders it (my-payslips-view's
 * monthLabel: en-GB "Month YYYY") — the OPEN draft that must NOT appear. */
function currentMonthLabel() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

Then("my payslip list should show at least {int} finalized payslip", async function (min) {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="my-payslips-view"]')), 15_000);
  const rows = await driver.wait(
    until.elementsLocated(By.css('[data-testid="my-payslip-row"]')),
    15_000,
    "no self-service payslip rows rendered",
  );
  assert.ok(rows.length >= min, `expected >= ${min} own payslips, got ${rows.length}`);
});

When("I open my latest payslip", async function () {
  const driver = await this.getDriver();
  const first = await driver.wait(
    until.elementLocated(By.css('[data-testid="my-payslip-row"]')),
    15_000,
    "no self-service payslip row to open",
  );
  await first.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="payslip-modal"]')), 10_000);
});

Then("my payslip viewer should be read-only with a print button", async function () {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="payslip-print"]')), 10_000);
  const saveButtons = await driver.findElements(By.css('[data-testid="payslip-save"]'));
  assert.strictEqual(
    saveButtons.length,
    0,
    "self-service payslip viewer must never offer a save button (read-only)",
  );
  // The payslip-modal testid is on the inner form; the uppercase run status
  // lives in the modal HEADER description (outside the form). What the form
  // itself states, in sentence case, is the locked-record footer note:
  // "The run is locked — this slip is the paid, immutable record." —
  // CI-stabilization: match case-insensitively (the old uppercase
  // includes("LOCKED") could never pass and this scenario never went green
  // in CI).
  const modal = await driver.findElement(By.css('[data-testid="payslip-modal"]'));
  const text = await modal.getText();
  assert.ok(/locked/i.test(text), `viewer should state the locked run status, got: ${text.slice(0, 120)}`);
});

Then("my payslip list should not include the current open month", async function () {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="my-payslips-view"]')), 15_000);
  // Wait until the list has actually loaded (rows or the empty state) so the
  // absence check can't pass vacuously while the fetch is in flight.
  await driver.wait(
    until.elementLocated(
      By.css('[data-testid="my-payslip-row"], [data-testid="my-payslips-empty"]'),
    ),
    15_000,
    "payslip list never rendered rows or the empty state",
  );
  const rows = await driver.findElements(By.css('[data-testid="my-payslip-row"]'));
  const label = currentMonthLabel();
  for (const row of rows) {
    const text = await row.getText();
    assert.ok(
      !text.includes(label),
      `the OPEN current month (${label}) must never appear in self-service, got row: ${text}`,
    );
  }
});

Then("the dashboard should show the latest payslip card", async function () {
  const driver = await this.getDriver();
  const card = await driver.wait(
    until.elementLocated(By.css('[data-testid="my-payslips-card"]')),
    15_000,
    "latest-payslip card did not render on the dashboard",
  );
  const text = await card.getText();
  assert.ok(/My Payslips/.test(text), `card should link to My Payslips, got: ${text}`);
});
