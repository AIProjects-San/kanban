// Steps for the F1.3 attendance feature (e2e/features/hr-attendance.feature).
//
// Conventions (mirrors hr-holidays-steps.js):
//  • Dates are UTC date strings injected into inputs via the native value
//    setter (React-controlled); the month pickers are <input type="month">
//    taking "YYYY-MM".
//  • The Attendance tab renders inside the HR console (attendance:manage
//    gate — the tab is hidden for managers).
//  • Errors surface as sonner toasts ([data-sonner-toast]).
// The leave request / approve / cancel steps are reused from hr-steps.js.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");
const {
  iso,
  mondayAtLeast,
  setInputValue,
} = require("./hr-steps");

/** The far-future Monday used by the marking scenario (~300 days out —
 * beyond every relative range the other feature files use). */
async function farFutureMonday(world) {
  if (!world.e2eAttMonday) {
    world.e2eAttMonday = mondayAtLeast(300);
  }
  return world.e2eAttMonday;
}

/** Set the HR grid's month picker to the month of a date. */
async function browseGridToMonthOf(world, date) {
  const driver = await world.getDriver();
  const value = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const input = await driver.wait(
    until.elementLocated(By.css("#att-month")),
    10_000,
    "attendance month picker not found",
  );
  await setInputValue(driver, input, value);
  await driver.sleep(500); // grid reloads per month change
}

/** The grid cell for (member, date) — data-status "" when unmarked. */
async function gridCell(world, userName, date) {
  const driver = await world.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="attendance-row"][@data-name="${userName}"]`),
    ),
    10_000,
    `no attendance row for "${userName}"`,
  );
  return row.findElement(
    By.css(`[data-testid="attendance-cell"][data-date="${iso(date)}"]`),
  );
}

async function markOn(world, userName, status, date) {
  const driver = await world.getDriver();
  await browseGridToMonthOf(world, date);
  // A leftover dialog from a previous (failed/retried) attempt would
  // intercept the Mark-a-day click — close it first.
  const stale = await driver.findElements(By.css('[role="dialog"]'));
  if (stale.length > 0) {
    const cancel = await stale[0].findElement(By.css('button[type="button"]'));
    await cancel.click();
    await driver.sleep(400);
  }
  const addBtn = await driver.wait(
    until.elementLocated(By.xpath('//button[contains(normalize-space(.), "Mark a day")]')),
    10_000,
    "no Mark a day button",
  );
  await addBtn.click();
  const dialog = await driver.wait(
    until.elementLocated(By.css('[role="dialog"]')),
    10_000,
    "the Mark attendance modal did not open",
  );
  // Member select — pick the option containing the name.
  const select = await dialog.findElement(By.css("#att-user"));
  const option = await select.findElement(
    By.xpath(`./option[contains(normalize-space(.), "${userName}")]`),
  );
  await option.click();
  await setInputValue(driver, await dialog.findElement(By.css("#att-date")), iso(date));
  const statusSelect = await dialog.findElement(By.css("#att-status"));
  await statusSelect.findElement(By.xpath(`./option[@value="${status}"]`)).click();
  await dialog.findElement(By.css('button[type="submit"]')).click();
  // Toast + grid reload round-trip (success or a friendly error).
  await driver.sleep(1_200);
}

When("I mark {string} {string} on a far-future Monday", async function (userName, status) {
  const monday = await farFutureMonday(this);
  await markOn(this, userName, status, monday);
});

When("I mark {string} {string} on that same Monday again", async function (userName, status) {
  assert.ok(this.e2eAttMonday, "no far-future Monday was marked in this scenario");
  await markOn(this, userName, status, this.e2eAttMonday);
});

// S3 (F-R15) — the non-working-day guard: the Saturday AFTER the far-future
// Monday. The mark is refused server-side; the toast carries the reason.
When("I mark {string} {string} on a far-future Saturday", async function (userName, status) {
  const monday = await farFutureMonday(this);
  const saturday = new Date(monday.getTime() + 5 * 86_400_000);
  await markOn(this, userName, status, saturday);
});

Then("the attendance grid should show a row for {string}", async function (userName) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="attendance-row"][@data-name="${userName}"]`),
    ),
    10_000,
    `no attendance row for "${userName}"`,
  );
});

Then("the attendance grid should show a {string} cell for {string} on that Monday", async function (status, userName) {
  const monday = await farFutureMonday(this);
  await browseGridToMonthOf(this, monday);
  const cell = await gridCell(this, userName, monday);
  const actual = await cell.getAttribute("data-status");
  assert.strictEqual(actual, status, `cell for ${userName} on ${iso(monday)} should be ${status}, got "${actual}"`);
});

Then("the attendance grid should show no record for {string} on that Monday", async function (userName) {
  const monday = await farFutureMonday(this);
  await browseGridToMonthOf(this, monday);
  const cell = await gridCell(this, userName, monday);
  const actual = await cell.getAttribute("data-status");
  assert.strictEqual(actual, "", `cell for ${userName} on ${iso(monday)} should be unmarked, got "${actual}"`);
});

Then("the attendance form should show an error mentioning {string}", async function (fragment) {
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
  // Close the still-open form modal so later steps start clean. In CREATE
  // mode the only type="button" is Cancel (Remove record only exists in
  // edit mode), so the first match is safe.
  const cancel = await driver.findElement(By.css('[role="dialog"] button[type="button"]'));
  await cancel.click();
  await driver.sleep(400);
});

When("I delete the attendance record for {string} on that Monday", async function (userName) {
  const monday = await farFutureMonday(this);
  await browseGridToMonthOf(this, monday);
  const cell = await gridCell(this, userName, monday);
  await cell.click(); // filled cell → edit modal
  const driver = await this.getDriver();
  const dialog = await driver.wait(
    until.elementLocated(By.css('[role="dialog"]')),
    10_000,
    "the edit attendance modal did not open",
  );
  await dialog.findElement(By.css('[data-testid="att-delete"]')).click();
  await driver.sleep(1_200); // delete + grid reload round-trip
});

// ---------------------------------------------------------------------------
// My Attendance (member self-scoped read)
// ---------------------------------------------------------------------------

When("I browse my attendance to the month of the far-future Monday", async function () {
  // The derivation scenario requests leave via the hr-steps request step,
  // which records the Monday it used on this.lastE2EMonday.
  const monday = this.lastE2EMonday ?? (await farFutureMonday(this));
  const driver = await this.getDriver();
  const value = `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}`;
  const input = await driver.wait(
    until.elementLocated(By.css("#my-att-month")),
    10_000,
    "my attendance month picker not found",
  );
  await setInputValue(driver, input, value);
  await driver.sleep(500); // calendar + list reload per month change
});

Then("my attendance calendar should show {string} on the far-future Monday", async function (status) {
  const monday = this.lastE2EMonday ?? (await farFutureMonday(this));
  const driver = await this.getDriver();
  const day = await driver.wait(
    until.elementLocated(
      By.css(`[data-testid="my-att-day"][data-date="${iso(monday)}"]`),
    ),
    10_000,
    `no calendar cell for ${iso(monday)}`,
  );
  const actual = await day.getAttribute("data-status");
  assert.strictEqual(actual, status, `my ${iso(monday)} should be ${status}, got "${actual}"`);
});

Then("my attendance calendar should show no {string} on the far-future Monday", async function (status) {
  const monday = this.lastE2EMonday ?? (await farFutureMonday(this));
  const driver = await this.getDriver();
  const day = await driver.wait(
    until.elementLocated(
      By.css(`[data-testid="my-att-day"][data-date="${iso(monday)}"]`),
    ),
    10_000,
    `no calendar cell for ${iso(monday)}`,
  );
  const actual = await day.getAttribute("data-status");
  assert.notStrictEqual(
    actual,
    status,
    `my ${iso(monday)} should no longer be ${status}, got "${actual}"`,
  );
});

// F1.4 — shared marking flow for the payroll feature's auto-LOP scenario
// (cross-file import follows the hr-attendance → hr-steps precedent).
module.exports = { markOn, browseGridToMonthOf };
