// Steps for the payroll feature (Recruitment R7).
// docs/RECRUITMENT_MODULE_PLAN.md §7 — runs in CI e2e (local sandbox has no
// Chrome; see e2e/README.md). Retry-safety: state-mutating steps tolerate
// "already done" outcomes so a cucumber retry on a shared seeded DB passes.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

/** Next month as "YYYY-MM" from the browser clock (stable within the run). */
function nextMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

Then("the payroll view should show runs for at least {int} months", async function (min) {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="payroll-runs"]')), 15_000);
  const rows = await driver.findElements(By.css('[data-testid^="run-row-"]'));
  assert.ok(rows.length >= min, `expected >= ${min} payroll runs, got ${rows.length}`);
});

Then("the payroll view should show a LOCKED run and an OPEN run", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.xpath('//*[@data-testid^="run-row-"]//*[contains(text(), "LOCKED")]')),
    15_000,
    "no LOCKED run rendered",
  );
  await driver.wait(
    until.elementLocated(By.xpath('//*[@data-testid^="run-row-"]//*[contains(text(), "OPEN")]')),
    15_000,
    "no OPEN run rendered",
  );
});

Then("the payroll view should list salary structures", async function () {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="structures-panel"]')), 15_000);
  const rows = await driver.findElements(By.css('[data-testid="structure-row"]'));
  assert.ok(rows.length >= 1, "expected at least one salary structure row");
});

Then("the payslip list should show the LOP hint for {string}", async function (name) {
  const driver = await this.getDriver();
  // The OPEN run is selected by default (newest period).
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="payslip-row"]//*[contains(text(), "${name}")]`),
    ),
    15_000,
    `no payslip row for "${name}"`,
  );
  const slip = await row.findElement(By.xpath('ancestor::*[@data-testid="payslip-row"]'));
  const text = await slip.getText();
  assert.ok(/LOP \d+d/.test(text), `payslip should show the LOP hint, got: ${text}`);
});

When("I open the payslip for {string}", async function (name) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="payslip-row"]//*[contains(text(), "${name}")]`),
    ),
    15_000,
    `no payslip row for "${name}"`,
  );
  await driver.executeScript(
    "arguments[0].closest('[data-testid=\"payslip-row\"]').click();",
    row,
  );
  await driver.wait(until.elementLocated(By.css('[data-testid="payslip-modal"]')), 10_000);
});

Then("the payslip editor should show the live net total", async function () {
  const driver = await this.getDriver();
  const totals = await driver.wait(
    until.elementLocated(By.css('[data-testid="payslip-totals"]')),
    10_000,
  );
  const text = await totals.getText();
  assert.ok(/Net pay/.test(text), `totals should label the net pay, got: ${text}`);
  assert.ok(/\$[\d,]+\.\d{2}/.test(text), `net should render as money, got: ${text}`);
});

When("I set the loss-of-pay days to {int} and save", async function (days) {
  const driver = await this.getDriver();
  const input = await driver.wait(
    until.elementLocated(By.css('[data-testid="payslip-lop-days"]')),
    10_000,
  );
  await input.clear();
  await input.sendKeys(String(days));
  await driver.findElement(By.css('[data-testid="payslip-save"]')).click();
  // Toast + list reload round-trip.
  await driver.sleep(2_000);
  await driver.wait(until.elementLocated(By.css('[data-testid="payslip-row"]')), 10_000);
});

When("I create a payroll run for next month", async function () {
  const driver = await this.getDriver();
  this.payrollPeriod = nextMonth();
  const input = await driver.wait(
    until.elementLocated(By.css('[data-testid="new-run-period"]')),
    10_000,
  );
  await driver.executeScript(
    "arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('input', { bubbles: true })); arguments[0].dispatchEvent(new Event('change', { bubbles: true }));",
    input,
    this.payrollPeriod,
  );
  await driver.findElement(By.css('[data-testid="create-run-btn"]')).click();
  // The run row appears whether the create succeeded or already existed
  // (cucumber retry on a shared DB) — wait for the row either way.
  await driver.wait(
    until.elementLocated(By.css(`[data-testid="run-row-${this.payrollPeriod}"]`)),
    15_000,
    `run row for ${this.payrollPeriod} did not appear`,
  );
});

Then("the new run should appear as OPEN", async function () {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(By.css(`[data-testid="run-row-${this.payrollPeriod}"]`)),
    10_000,
  );
  const text = await row.getText();
  assert.ok(/OPEN/.test(text), `new run should be OPEN, got: ${text}`);
});

When("I lock the new run", async function () {
  const driver = await this.getDriver();
  // Retry tolerance: if a previous attempt already locked it, done.
  const lockBtns = await driver.findElements(
    By.css(`[data-testid="lock-run-${this.payrollPeriod}"]`),
  );
  if (lockBtns.length === 0) return;
  await lockBtns[0].click();
  const confirm = await driver.wait(
    until.elementLocated(By.css(`[data-testid="lock-confirm-${this.payrollPeriod}"]`)),
    10_000,
  );
  await confirm.click();
  await driver.sleep(2_000);
});

Then("the new run should be locked", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="run-row-${this.payrollPeriod}"]//*[contains(text(), "LOCKED")]`),
    ),
    15_000,
    `run ${this.payrollPeriod} did not render as LOCKED`,
  );
});
