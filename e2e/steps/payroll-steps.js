// Steps for the payroll feature (Recruitment R7).
// docs/RECRUITMENT_MODULE_PLAN.md §7 — runs in CI e2e (local sandbox has no
// Chrome; see e2e/README.md). Retry-safety: state-mutating steps tolerate
// "already done" outcomes so a cucumber retry on a shared seeded DB passes.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");
const { iso } = require("./hr-steps");
const { isHoliday } = require("../support/holidays");
const { markOn } = require("./hr-attendance-steps");

/** Next month as "YYYY-MM" from the browser clock (stable within the run). */
function nextMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** The first working (non-holiday) Monday of next month — F1.4's auto-LOP
 * e2e date. Falls forward day-by-day past seeded holidays so the derivation
 * always charges the marked days no matter when CI runs. */
function firstWorkingMondayOfNextMonth() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  while (isHoliday(d) || d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

/** The next working day strictly after `from` (skips weekends + holidays). */
function nextWorkingDayAfter(from) {
  const d = new Date(from.getTime() + 86_400_000);
  while (isHoliday(d) || d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

Then("the payroll view should show runs for at least {int} months", async function (min) {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="payroll-runs"]')), 15_000);
  const rows = await driver.findElements(By.css('[data-testid^="run-row-"]'));
  assert.ok(rows.length >= min, `expected >= ${min} payroll runs, got ${rows.length}`);
});

Then("the payroll view should show a LOCKED run and an OPEN run", async function () {
  const driver = await this.getDriver();
  // CI-stabilization: `^=` is CSS-only syntax and made these XPath queries
  // invalid (InvalidSelectorError) — payroll e2e never passed in CI. XPath
  // 1.0 spells it starts-with(@attr, "prefix").
  await driver.wait(
    until.elementLocated(By.xpath('//*[starts-with(@data-testid, "run-row-")]//*[contains(text(), "LOCKED")]')),
    15_000,
    "no LOCKED run rendered",
  );
  await driver.wait(
    until.elementLocated(By.xpath('//*[starts-with(@data-testid, "run-row-")]//*[contains(text(), "OPEN")]')),
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
  // P10 — the form is cadence + anchor DATE (the MONTHLY select defaults
  // untouched), so the anchor is the first day of the target month and the
  // resolved period key is still "YYYY-MM".
  const anchorDate = `${this.payrollPeriod}-01`;
  // CI-stabilization: assigning `.value` directly defeats React's value
  // tracker on controlled inputs — onChange never fires, the period stays
  // at its default, and the create duplicates the existing month. Use the
  // native prototype setter (the same trick as setReactInputValue in
  // hr-steps.js) so the dispatched input event registers as a real change.
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    input,
    anchorDate,
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

// --- F1.4: auto-derived LOP from attendance marks -------------------------

When("I mark {string} {string} on the first working Monday of next month", async function (userName, status) {
  const day1 = firstWorkingMondayOfNextMonth();
  this.e2eLopDay1 = day1;
  await markOn(this, userName, status, day1);
});

When("I mark {string} {string} on the next working day", async function (userName, status) {
  assert.ok(this.e2eLopDay1, "no first working Monday was marked in this scenario");
  const day2 = nextWorkingDayAfter(this.e2eLopDay1);
  await markOn(this, userName, status, day2);
});

Then("the payslip list should show the LOP hint {string} marked {string} for {string}", async function (hint, provenance, name) {
  const driver = await this.getDriver();
  // The newly created run is the newest period → selected by default.
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="payslip-row"]//*[contains(text(), "${name}")]`),
    ),
    15_000,
    `no payslip row for "${name}"`,
  );
  const slip = await row.findElement(By.xpath('ancestor::*[@data-testid="payslip-row"]'));
  const text = await slip.getText();
  assert.ok(
    text.includes(`LOP ${hint}`),
    `payslip should show "LOP ${hint}", got: ${text}`,
  );
  assert.ok(
    text.includes(`(${provenance})`),
    `payslip should tag the LOP "(${provenance})", got: ${text}`,
  );
});

Then("the payslip provenance note should say the LOP was auto-derived", async function () {
  const driver = await this.getDriver();
  const note = await driver.wait(
    until.elementLocated(By.css('[data-testid="payslip-lop-source"]')),
    10_000,
    "no LOP provenance note rendered",
  );
  const text = await note.getText();
  assert.ok(
    /Auto-derived/i.test(text),
    `provenance note should say Auto-derived, got: ${text}`,
  );
});

// ---------------------------------------------------------------------------
// P22 (PR-C01–04, PR-N01–06) — the analytics panel on the Payroll view.
// ---------------------------------------------------------------------------

Then("the payroll analytics panel should render the six number cards", async function () {
  const driver = await this.getDriver();
  const panel = await driver.wait(
    until.elementLocated(By.css('[data-testid="payroll-analytics"]')),
    15_000,
    "no analytics panel rendered",
  );
  const cards = await panel.findElements(
    By.css('[data-testid="payroll-analytics-cards"] > *'),
  );
  assert.ok(
    cards.length === 6,
    `expected 6 analytics cards, got ${cards.length}`,
  );
});

Then("the outgoing salary chart should show paid months", async function () {
  const driver = await this.getDriver();
  const chart = await driver.wait(
    until.elementLocated(By.css('[data-testid="chart-outgoing-salary"]')),
    15_000,
    "no outgoing-salary chart rendered",
  );
  const text = await chart.getText();
  // Seeded LOCKED runs exist (the runs scenario pins that), so the trend has
  // real buckets: a max callout and a month label must render.
  assert.ok(/max \$/.test(text), `outgoing chart should show the max callout, got: ${text}`);
  assert.ok(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/.test(text),
    `outgoing chart should show month labels, got: ${text}`);
});

Then("the statutory cards should render the ADR-014 note", async function () {
  const driver = await this.getDriver();
  const cards = await driver.wait(
    until.elementLocated(By.css('[data-testid="payroll-analytics-cards"]')),
    15_000,
    "no analytics cards rendered",
  );
  const text = await cards.getText();
  assert.ok(
    text.includes("statutory, declined (ADR-014)"),
    `the statutory cards should name the ADR-014 decline, got: ${text}`,
  );
  assert.ok(
    text.includes("—"),
    `the statutory cards should render an em dash, never a fake zero, got: ${text}`,
  );
});

// --- P23: percent modes + the default package (PR-02/PR-03) --------------

Then("the structure list should show the default package chip", async function () {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.css('[data-testid="structure-default-chip"]')),
    15_000,
    "no DEFAULT PKG chip rendered on a structure row",
  );
  const text = await chip.getText();
  assert.strictEqual(text, "DEFAULT PKG", `chip text, got: ${text}`);
});

Then("the payslip list should show a deduction hint for {string}", async function (name) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="payslip-row"]//*[contains(text(), "${name}")]`),
    ),
    15_000,
    `no payslip row for "${name}"`,
  );
  const slip = await row.findElement(By.xpath('ancestor::*[@data-testid="payslip-row"]'));
  const text = await slip.getText();
  // Seeded Lena structure: basic 66,000 (+5,500/mo) + 8%-of-gross variable
  // pay (+440/mo) → gross 5,940; 6%-of-net advance recovery on the running
  // net (no flat deductions, no LOP, no adjustments) = 356.40 → net 5,583.60.
  assert.ok(
    /deductions \$356\.40/.test(text),
    `payslip should show the percent-of-net deduction (deductions $356.40), got: ${text}`,
  );
  assert.ok(/5,940/.test(text), `payslip should show the resolved gross (5,940), got: ${text}`);
});

// P39 (EM-16 advances half) — the salary-advances panel.

When("I open the advances panel", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css("[data-testid='advances-btn']")),
    10_000,
    "Advances button not found",
  );
  await btn.click();
  await driver.wait(
    until.elementLocated(By.css("[data-testid='salary-advances-list']")),
    10_000,
    "advances list did not render",
  );
});

Then("the advances list shows {string} with {string}", async function (name, expected) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(By.css(`[data-testid='advance-${name}']`)),
    10_000,
    `advance row for ${name} not found`,
  );
  const text = await row.getText();
  assert.ok(
    text.includes(expected),
    `advance row for ${name} does not show "${expected}" (got: ${text.replace(/\n/g, " | ")})`,
  );
});

When("I issue a {int} advance to {string} over {int} installments from {string}", async function (amount, name, installments, startPeriod) {
  const driver = await this.getDriver();
  const select = await driver.findElement(By.css("[data-testid='advance-employee']"));
  const value = await driver.executeScript(
    `const el = arguments[0];
     return Array.from(el.options).find(o => o.textContent.includes(arguments[1]))?.value ?? "";`,
    select, name,
  );
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    select, value,
  );
  const amountInput = await driver.findElement(By.css("[data-testid='advance-amount']"));
  await amountInput.clear();
  await amountInput.sendKeys(String(amount));
  const instInput = await driver.findElement(By.css("[data-testid='advance-installments']"));
  await instInput.clear();
  await instInput.sendKeys(String(Number(installments)));
  const periodInput = await driver.findElement(By.css("[data-testid='advance-start-period']"));
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('input', { bubbles: true }));`,
    periodInput, startPeriod,
  );
  await driver.findElement(By.css("[data-testid='advance-issue-btn']")).click();
  await driver.sleep(1_500);
});
