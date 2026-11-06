// Steps for the F1.1 holiday-calendar feature (e2e/features/hr-holidays.feature).
//
// Conventions (mirrors hr-steps.js):
//  • Dates are UTC date strings injected into <input type="date"> via the
//    native value setter (React-controlled inputs).
//  • The Holidays tab renders inside the HR console (hr:admin gate).
//  • Errors surface as sonner toasts ([data-sonner-toast]).

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");
const {
  iso,
  mondayAtLeast,
  setInputValue,
} = require("./hr-steps");

// NOTE: "I open the {string} tab" lives in hr-directory-steps.js (the HR
// console tab switch) — a Holidays branch was added there; reuse it.

Then("the HR console should not show a {string} tab", async function (tabLabel) {
  const driver = await this.getDriver();
  // EXACT text match — a contains() check would also match the sidebar's
  // self-scoped leaves (e.g. "My Attendance" contains "Attendance"), which
  // every role legitimately has.
  const tabs = await driver.findElements(
    By.xpath(`//button[normalize-space(.) = "${tabLabel}"]`),
  );
  assert.strictEqual(tabs.length, 0, `the "${tabLabel}" tab should not be visible`);
});

// ---------------------------------------------------------------------------
// Year browsing + reads
// ---------------------------------------------------------------------------

/** Walk the Holidays tab to `year` from wherever it was left (the tab opens
 * on the current UTC year; scenarios may chain browses — e.g. 2026 then
 * 2027 — so the world remembers the last year shown). */
async function browseToYear(world, year) {
  const driver = await world.getDriver();
  const from = world.e2eHolidayYear ?? new Date().getUTCFullYear();
  world.e2eHolidayYear = year;
  const forward = year > from;
  const steps = Math.abs(year - from);
  for (let i = 0; i < steps; i += 1) {
    const arrow = await driver.wait(
      until.elementLocated(
        By.css(`button[aria-label^="${forward ? "Next" : "Previous"} year"]`),
      ),
      10_000,
      `no ${forward ? "next" : "previous"}-year arrow`,
    );
    await arrow.click();
    await driver.sleep(400);
  }
  // The year label sits next to the arrows; wait until it shows the target.
  await driver.wait(
    async () => (await driver.getPageSource()).includes(String(year)),
    10_000,
    `the calendar did not browse to ${year}`,
  );
  await driver.sleep(400); // entries reload per year change
}

When("I browse the holiday calendar to {int}", async function (year) {
  await browseToYear(this, year);
});

When("I browse the holiday calendar to the year of that Monday", async function () {
  assert.ok(this.e2eHolidayMonday, "no far-future Monday was marked in this scenario");
  await browseToYear(this, this.e2eHolidayMonday.getUTCFullYear());
});

Then("the holiday calendar should show {string}", async function (label) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="holiday-row"]//*[contains(text(), "${label}")]`),
    ),
    10_000,
    `the calendar does not show "${label}"`,
  );
});

Then("the holiday calendar should show exactly one entry for {string}", async function (date) {
  const driver = await this.getDriver();
  // Rows render dates in en-GB display order (25/12/2026) — match the row's
  // data-date attribute (ISO) instead of the human-formatted text.
  const rows = await driver.findElements(
    By.css(`[data-testid="holiday-row"][data-date="${date}"]`),
  );
  assert.strictEqual(rows.length, 1, `expected exactly one entry for ${date}, got ${rows.length}`);
});

// ---------------------------------------------------------------------------
// Create / delete
// ---------------------------------------------------------------------------

async function addHolidayOn(world, dateStr, label) {
  const driver = await world.getDriver();
  const addBtn = await driver.wait(
    until.elementLocated(By.xpath(`//button[contains(normalize-space(.), "Add holiday")]`)),
    10_000,
    "no Add holiday button",
  );
  await addBtn.click();
  const dialog = await driver.wait(
    until.elementLocated(By.css('[role="dialog"]')),
    10_000,
    "the Add holiday modal did not open",
  );
  await setInputValue(driver, await dialog.findElement(By.css("#hol-date")), dateStr);
  const labelEl = await dialog.findElement(By.css("#hol-label"));
  await labelEl.clear();
  await labelEl.sendKeys(label);
  // The modal's submit button is the dialog's only type="submit".
  await dialog.findElement(By.css('button[type="submit"]')).click();
  // Toast + list reload round-trip (either success or a friendly error).
  await driver.sleep(1_200);
}

When("I add a holiday on {string} labeled {string}", async function (dateStr, label) {
  await addHolidayOn(this, dateStr, label);
});

When("I add a holiday on a far-future Monday labeled {string}", async function (label) {
  // 300 days out is beyond every relative range the other feature files use
  // (max observed: 70 days out + a 16-day span) — safe for shared state.
  const monday = mondayAtLeast(300);
  this.e2eHolidayMonday = monday;
  await addHolidayOn(this, iso(monday), label);
});

When("I delete the holiday labeled {string}", async function (label) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="holiday-row"]//*[contains(text(), "${label}")]/ancestor::*[@data-testid="holiday-row"]`),
    ),
    10_000,
    `no holiday row for "${label}"`,
  );
  await row.findElement(By.css('button[aria-label^="Delete"]')).click();
  await driver.sleep(1_200);
});

Then("the holiday form should show an error mentioning {string}", async function (fragment) {
  const driver = await this.getDriver();
  const toast = await driver.wait(
    until.elementLocated(By.css("[data-sonner-toast]")),
    10_000,
    "no error toast appeared",
  );
  const text = await toast.getText();
  assert.ok(
    text.includes(fragment),
    `toast should mention "${fragment}", got: "${text}"`,
  );
  // Close the still-open form modal so later steps start clean.
  const cancel = await driver.findElement(By.css('[role="dialog"] button[type="button"]'));
  await cancel.click();
  await driver.sleep(400);
});

// ---------------------------------------------------------------------------
// Leave-preview exclusion (uses the far-future Monday noted above)
// ---------------------------------------------------------------------------

When("I fill a {string} request from that Monday to the following day", async function (typeName) {
  const driver = await this.getDriver();
  const monday = this.e2eHolidayMonday;
  assert.ok(monday, "no far-future Monday was marked in this scenario");
  // openRequestForm + selectLeaveType + date inputs (hr-steps conventions).
  const { setInputValue: setVal } = require("./hr-steps");
  const openBtn = await driver.wait(
    until.elementLocated(By.xpath(`//button[contains(normalize-space(.), "Request Leave")]`)),
    10_000,
    "no Request Leave button",
  );
  await openBtn.click();
  const typeSelect = await driver.wait(
    until.elementLocated(By.css("#leave-type")),
    10_000,
    "the leave form did not open",
  );
  const options = await typeSelect.findElements(By.css("option"));
  let picked = false;
  for (const o of options) {
    if ((await o.getText()).includes(typeName)) {
      await typeSelect.findElement(By.xpath(`./option[contains(normalize-space(.), "${typeName}")]`)).click();
      picked = true;
      break;
    }
  }
  assert.ok(picked, `no leave type matching "${typeName}"`);
  await setVal(driver, await driver.findElement(By.css("#leave-start")), iso(monday));
  await setVal(driver, await driver.findElement(By.css("#leave-end")), iso(new Date(monday.getTime() + 86_400_000)));
});

Then("the request form should preview 1 working day with holidays excluded", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(
      By.xpath(`//*[contains(text(), "1 working day (weekends and holidays excluded)")]`),
    ),
    10_000,
    "the form did not preview 1 working day with holidays excluded",
  );
});

When("I submit the filled request with reason {string}", async function (reason) {
  const driver = await this.getDriver();
  const reasonEl = await driver.findElement(By.css("#leave-reason"));
  await reasonEl.clear();
  await reasonEl.sendKeys(reason);
  const submit = await driver.findElement(By.xpath(`//button[contains(., "Submit request")]`));
  await submit.click();
  // Modal closes asynchronously on success; on failure it stays open (toast).
  try {
    await driver.wait(
      async () => (await driver.findElements(By.css("#leave-type"))).length === 0,
      8_000,
    );
  } catch {
    // stay open — the follow-up assertion will fail with context
  }
  await driver.sleep(600);
});

// NOTE: "a request with reason … should appear as Pending in my requests"
// is already defined in hr-steps.js and reused as-is by this feature.

// ---------------------------------------------------------------------------
// Payroll denominator
// ---------------------------------------------------------------------------

Then("the payslip editor should show a loss-of-pay line of ${float}", async function (amount) {
  const driver = await this.getDriver();
  // The OPEN-run editor renders the LOP deduction with a testid (the visible
  // label is hyphenated "Loss-of-pay days", so a text match would miss).
  const line = await driver.wait(
    until.elementLocated(By.css('[data-testid="payslip-lop-amount"]')),
    10_000,
    "no loss-of-pay line in the payslip editor",
  );
  const text = await line.getText();
  assert.ok(
    text.includes(String(amount)),
    `the payslip editor should show a $${amount} loss-of-pay line (working-day denominator), got:\n${text}`,
  );
});
