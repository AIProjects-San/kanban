// Steps for the HR leave-management feature (e2e/features/hr-leave.feature).
//
// Conventions:
//  • Dates are computed as UTC date strings and injected into <input type="date">
//    via the native value setter + input/change events (React-controlled).
//  • Requests are located by their unique REASON text — scenarios share the
//    seeded DB in file order, so reason strings are the deterministic key.
//  • Errors surface as sonner toasts ([data-sonner-toast]).

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

// ---------------------------------------------------------------------------
// Date helpers (UTC, matching the server's parseDay normalization)
// ---------------------------------------------------------------------------

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function todayUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** The first Monday at least `daysOut` days from today (UTC).
 * F1.1: skips weeks whose following 10 days contain a seeded holiday — the
 * fixed-date calendar would otherwise make day-count assertions depend on
 * which day CI runs (a holiday inside "Mon → following Tuesday" changes the
 * denormalized `days`). */
function mondayAtLeast(daysOut) {
  const { hasHolidayInRange } = require("../support/holidays");
  const d = todayUTC();
  d.setUTCDate(d.getUTCDate() + daysOut);
  while (d.getUTCDay() !== 1 || hasHolidayInRange(d, dayAfter(d, 10))) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

/** `base` + `n` days, UTC-midnight (helper for mondayAtLeast's window). */
function dayAfter(base, n) {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

/** The coming Saturday (today, if today is Saturday). */
function comingSaturday() {
  const d = todayUTC();
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function dayOffset(days) {
  const d = todayUTC();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Set a React-controlled input's value through the native setter so React's
 * onChange actually fires (plain sendKeys is unreliable on date inputs).
 */
async function setInputValue(driver, element, value) {
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    element,
    value,
  );
}

async function waitForToast(driver, keyword, timeout = 10_000) {
  const target = keyword.toLowerCase();
  // Toasts re-render/animate (sonner) — a toast can go stale between
  // locate and read, so staleness means "not this poll", never a failure.
  await driver.wait(
    async () => {
      try {
        const toasts = await driver.findElements(By.css("[data-sonner-toast]"));
        for (const t of toasts) {
          const text = (await t.getText()).toLowerCase();
          if (text.includes(target)) return true;
        }
        return false;
      } catch (e) {
        if (e && /stale/i.test(String(e.name || e.message))) return false;
        throw e;
      }
    },
    timeout,
    `no toast mentioning "${keyword}" appeared`,
  );
}

// Table row containing a reason text (works for both the self-service and
// the HR-queue tables — both render the reason inside the row).
const rowWithReason = (reason) =>
  By.xpath(`//table//tr[contains(., "${reason}")]`);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

When("I sign out", async function () {
  await this.logout();
});

// ---------------------------------------------------------------------------
// Leave view — read assertions
// ---------------------------------------------------------------------------

Then("the leave balance for {string} should show {int} days available", async function (typeName, days) {
  const driver = await this.getDriver();
  // Re-locate on every poll: the view re-renders after mutations and React
  // replaces the card node, invalidating any held element reference. The
  // getText can STILL go stale in the locate→read window (the cancel flow
  // re-renders the card mid-poll — the CI flake of run 140), so a
  // StaleElementReferenceError is swallowed into "not yet" and the next
  // poll re-locates — never a step failure.
  await driver.wait(
    async () => {
      try {
        const cards = await driver.findElements(
          By.xpath(`//div[contains(@class, "f-card")][contains(., "${typeName}")]//*[@data-testid='balance-available']`),
        );
        if (cards.length === 0) return false;
        return (await cards[0].getText()).trim() === String(days);
      } catch (e) {
        if (e && /stale/i.test(String(e.name || e.message))) return false;
        throw e;
      }
    },
    10_000,
    `balance for "${typeName}" never showed ${days} days`,
  );
});

Then("my requests list should contain a pending {string} request", async function (typeName) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementsLocated(By.xpath(`//table//tr[contains(., "${typeName}")][contains(., "Pending")]`)),
    10_000,
    `no pending ${typeName} request row found`,
  );
});

Then("my requests list should not show other members' requests", async function () {
  const driver = await this.getDriver();
  await driver.wait(until.elementsLocated(By.css("table tbody tr")), 10_000, "requests table did not render");
  const body = await driver.findElement(By.css("main")).getText();
  assert.ok(!body.includes("Lena Okafor"), "another member's request leaked into the self-service list");
});

Then("my requests list should contain exactly {int} pending requests", async function (count) {
  const driver = await this.getDriver();
  await driver.wait(until.elementsLocated(By.css("table tbody tr")), 10_000, "requests table did not render");
  await driver.wait(
    async () => {
      const rows = await driver.findElements(
        By.xpath(`//table//tbody/tr[contains(., "Pending")]`),
      );
      return rows.length === count;
    },
    10_000,
    `pending request count never reached ${count}`,
  );
});

Then("a request with reason {string} should appear as Pending in my requests", async function (reason) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementsLocated(By.xpath(`//table//tr[contains(., "${reason}")][contains(., "Pending")]`)),
    10_000,
    `request with reason "${reason}" never appeared as Pending`,
  );
});

// The queue defaults to the PENDING filter, so a decided row LEAVES the
// table — status assertions must first switch to the "All" filter when
// one exists (the self-service view has no filter chip and is skipped).
async function showAllFilterIfPresent(driver) {
  const chips = await driver.findElements(By.xpath(`//button[contains(., "All")]`));
  if (chips.length > 0) {
    await chips[0].click();
    await driver.sleep(500);
  }
}

async function waitForRowWithStatus(driver, reason, status, timeoutMsg) {
  // Re-assert the "All" filter on every poll — a view remount resets it to
  // PENDING, which would hide decided rows (a race observed live).
  await driver.wait(
    async () => {
      await showAllFilterIfPresent(driver);
      const rows = await driver.findElements(
        By.xpath(`//table//tr[contains(., "${reason}")][contains(., "${status}")]`),
      );
      return rows.length > 0;
    },
    10_000,
    timeoutMsg,
  );
}

Then("my request with reason {string} should show status {string}", async function (reason, status) {
  await waitForRowWithStatus(await this.getDriver(), reason, status, `request "${reason}" never showed status ${status}`);
});

Then("the request with reason {string} should show status {string}", async function (reason, status) {
  await waitForRowWithStatus(await this.getDriver(), reason, status, `request "${reason}" never showed status ${status}`);
});

// ---------------------------------------------------------------------------
// Leave view — request form submissions
// ---------------------------------------------------------------------------

async function openRequestForm(driver) {
  await driver.wait(
    until.elementLocated(By.xpath(`//button[contains(., "Request Leave")]`)),
    10_000,
    '"Request Leave" button not found',
  ).then((b) => b.click());
  await driver.wait(until.elementLocated(By.css("#leave-type")), 10_000, "request form did not open");
}

async function selectLeaveType(driver, typeName) {
  const select = await driver.findElement(By.css("#leave-type"));
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    select,
    await driver.executeScript(
      `const el = arguments[0];
       return Array.from(el.options).find(o => o.textContent.includes(arguments[1]))?.value ?? "";`,
      select,
      typeName,
    ),
  );
}

async function fillAndSubmitLeave(driver, { typeName, startDate, endDate, reason }) {
  await openRequestForm(driver);
  await selectLeaveType(driver, typeName);
  await setInputValue(driver, await driver.findElement(By.css("#leave-start")), startDate);
  await setInputValue(driver, await driver.findElement(By.css("#leave-end")), endDate);
  const reasonEl = await driver.findElement(By.css("#leave-reason"));
  await reasonEl.clear();
  await reasonEl.sendKeys(reason);
  const submit = await driver.findElement(By.xpath(`//button[contains(., "Submit request")]`));
  const enabled = await submit.isEnabled();
  await submit.click();
  if (enabled) {
    // The modal close after a successful submission is asynchronous — the
    // next step's "Request Leave" click would otherwise be intercepted by
    // the still-mounted backdrop (ElementClickInterceptedError).
    try {
      await driver.wait(
        async () => (await driver.findElements(By.css("#leave-type"))).length === 0,
        8_000,
      );
    } catch {
      // Modal stays open on a server rejection — the toast tells that story.
    }
  }
}

/** Shared request-submission helper — start/end are UTC Date objects. */
async function submitRange(world, typeName, start, end, reason) {
  const driver = await world.getDriver();
  await fillAndSubmitLeave(driver, { typeName, startDate: iso(start), endDate: iso(end), reason });
}

When("I request {string} from a Monday {int} days out to the following day with reason {string}", async function (typeName, daysOut, reason) {
  const monday = mondayAtLeast(daysOut);
  this.lastE2EMonday = monday; // for the "same Monday" overlap step
  await submitRange(this, typeName, monday, new Date(monday.getTime() + 86_400_000), reason);
});

When("I request {string} from the same Monday to the following day with reason {string}", async function (typeName, reason) {
  const monday = this.lastE2EMonday;
  assert.ok(monday, "no previous Monday-based request was made in this scenario");
  await submitRange(this, typeName, monday, new Date(monday.getTime() + 86_400_000), reason);
});

When("I request {string} from a Monday {int} days out to the following Friday", async function (typeName, daysOut) {
  const monday = mondayAtLeast(daysOut);
  await submitRange(this, typeName, monday, new Date(monday.getTime() + 4 * 86_400_000), "Insufficient balance e2e");
});

When("I request {string} from a Monday {int} days out to the following Tuesday with reason {string}", async function (typeName, daysOut, reason) {
  const monday = mondayAtLeast(daysOut);
  await submitRange(this, typeName, monday, new Date(monday.getTime() + 86_400_000), reason);
});

When("I request {string} starting today for one day", async function (typeName) {
  const today = todayUTC();
  await submitRange(this, typeName, today, today, "Notice test e2e");
});

When("I request {string} covering only the coming weekend", async function (typeName) {
  const driver = await this.getDriver();
  const rows = await driver.findElements(By.css("table tbody tr"));
  this.leaveRowCountBefore = rows.length;
  const saturday = comingSaturday();
  await submitRange(this, typeName, saturday, new Date(saturday.getTime() + 86_400_000), "Weekend test e2e");
});

/** Fill the request form WITHOUT submitting — for asserting client-side guards. */
async function fillOnlyRange(world, typeName, start, end, reason) {
  const driver = await world.getDriver();
  await openRequestForm(driver);
  await selectLeaveType(driver, typeName);
  await setInputValue(driver, await driver.findElement(By.css("#leave-start")), iso(start));
  await setInputValue(driver, await driver.findElement(By.css("#leave-end")), iso(end));
  const reasonEl = await driver.findElement(By.css("#leave-reason"));
  await reasonEl.clear();
  await reasonEl.sendKeys(reason);
}

When("I fill an {string} request from a Monday {int} days out to the following Tuesday", async function (typeName, daysOut) {
  const monday = mondayAtLeast(daysOut);
  await fillOnlyRange(this, typeName, monday, new Date(monday.getTime() + 86_400_000), "Advance leave e2e");
});

When("I fill a {string} request from a Monday {int} days out to the following Friday", async function (typeName, daysOut) {
  const monday = mondayAtLeast(daysOut);
  await fillOnlyRange(this, typeName, monday, new Date(monday.getTime() + 4 * 86_400_000), "Balance guard e2e");
});

Then("the request form should warn that the range contains no working days", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementsLocated(By.xpath(`//*[contains(text(), "no working days")]`)),
    10_000,
    "the form did not warn about the weekend-only range",
  );
});

Then("the request form should show 0 days available and disable submission", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    async () => (await driver.getPageSource()).includes("0 days available"),
    10_000,
    "the live balance preview did not show 0 days available",
  );
  const submit = await driver.findElement(By.xpath(`//button[contains(., "Submit request")]`));
  assert.strictEqual(await submit.isEnabled(), false, "submit should be disabled while the request exceeds the balance");
});

/**
 * Server-rejection proof without depending on toast rendering: on failure
 * the request form STAYS OPEN (only a successful submission closes it) and
 * no row is created.
 */
Then("the rejected request form should still be open with no {string} row created", async function (reason) {
  const driver = await this.getDriver();
  await driver.sleep(1_200); // let any would-be success path finish
  const formOpen = await driver.findElements(By.css("#leave-type"));
  assert.ok(formOpen.length > 0, "the form closed — the submission apparently succeeded");
  const rows = await driver.findElements(By.xpath(`//table//tr[contains(., "${reason}")]`));
  assert.strictEqual(rows.length, 0, `a request row with reason "${reason}" was created despite the rejection`);
});

Then("the submission should be rejected with an error mentioning {string}", async function (keyword) {
  await waitForToast(await this.getDriver(), keyword);
});

Then("no weekend request should appear in my requests", async function () {
  const driver = await this.getDriver();
  await driver.sleep(800); // let a (wrongly) created row render
  const rows = await driver.findElements(By.css("table tbody tr"));
  assert.strictEqual(
    rows.length,
    this.leaveRowCountBefore,
    "a weekend-only request was created although it should have been rejected",
  );
});

// ---------------------------------------------------------------------------
// Cancellation (self-service)
// ---------------------------------------------------------------------------

When("I cancel my request with reason {string}", async function (reason) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(rowWithReason(reason)),
    10_000,
    `request row with reason "${reason}" not found`,
  );
  const cancel = await row.findElement(By.xpath(`.//button[contains(., "Cancel")]`));
  await cancel.click();
});

// ---------------------------------------------------------------------------
// HR console — decisions
// ---------------------------------------------------------------------------

When("I approve the request with reason {string}", async function (reason) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(rowWithReason(reason)),
    10_000,
    `queue row with reason "${reason}" not found`,
  );
  await row.findElement(By.xpath(`.//button[contains(., "Decide")]`)).click();
  await driver.wait(until.elementLocated(By.css("[data-testid='approve-request']")), 10_000, "decision modal did not open");
  await driver.findElement(By.css("[data-testid='approve-request']")).click();
  await waitForToast(driver, "approved");
});

When("I reject the request with reason {string} with note {string}", async function (reason, note) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(rowWithReason(reason)),
    10_000,
    `queue row with reason "${reason}" not found`,
  );
  await row.findElement(By.xpath(`.//button[contains(., "Decide")]`)).click();
  const noteEl = await driver.wait(until.elementLocated(By.css("#decision-note")), 10_000, "decision modal did not open");
  await noteEl.sendKeys(note);
  await driver.findElement(By.css("[data-testid='reject-request']")).click();
  await waitForToast(driver, "rejected");
});

Then("the decision note {string} should be visible for that request", async function (note) {
  const driver = await this.getDriver();
  await showAllFilterIfPresent(driver);
  await driver.wait(
    until.elementsLocated(By.xpath(`//table//tr[contains(., "${note}")]`)),
    10_000,
    `decision note "${note}" is not visible`,
  );
});

Then("the leave queue should not contain a request from {string}", async function (name) {
  const driver = await this.getDriver();
  // Switch to the "All" filter so the assertion covers decided requests too.
  await showAllFilterIfPresent(driver);
  await driver.sleep(600);
  const rows = await driver.findElements(By.css("table tbody tr"));
  for (const row of rows) {
    const text = await row.getText();
    assert.ok(!text.includes(name), `queue leaked a request from "${name}" outside the viewer's subtree`);
  }
});

// ---------------------------------------------------------------------------
// Calendar integration
// ---------------------------------------------------------------------------

Then("the calendar should show approved leave for {string}", async function (name) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementsLocated(By.xpath(`//main//*[contains(text(), "${name}")][contains(., "Annual Leave") or contains(../../., "Annual Leave")]`)),
    10_000,
    `calendar does not show approved leave for ${name}`,
  );
});

// ---------------------------------------------------------------------------
// Time-guard integration (task modal time log)
// ---------------------------------------------------------------------------

When("I open the task {string}", async function (title) {
  const driver = await this.getDriver();
  // The board column scoping mirrors task-steps.js — document-wide text
  // matches would hit the RSC/Flight payload scripts.
  const card = await driver.wait(
    until.elementLocated(By.xpath(`//div[@data-testid='board-column']//*[contains(text(), "${title}")]`)),
    10_000,
    `task card "${title}" not found on the board`,
  );
  await card.click();
  await driver.wait(
    until.elementsLocated(By.xpath(`//*[contains(text(), "Time log")]`)),
    10_000,
    "task modal did not show its time-log section",
  );
});

When("I log {int} hours on that task for a date {int} days from today", async function (hours, daysFromToday) {
  const driver = await this.getDriver();
  const dateInput = await driver.wait(
    until.elementLocated(By.css("input[aria-label='Date']")),
    10_000,
    "time-log date input not found",
  );
  await setInputValue(driver, dateInput, iso(dayOffset(daysFromToday)));
  const hoursInput = await driver.findElement(By.css("input[aria-label='Hours']"));
  await hoursInput.clear();
  await hoursInput.sendKeys(String(hours));
  // Structural rejection proof baseline: the time-log entry rows.
  this.timeLogRowsBefore = await driver.findElements(
    By.xpath(`//*[contains(text(), "Time log")]/following::div[contains(@class, "bg-muted/40")]`),
  );
  await driver.findElement(By.xpath(`//button[contains(., "Log")]`)).click();
});

Then("the time log submission should be rejected with an error mentioning approved leave", async function () {
  const driver = await this.getDriver();
  await driver.sleep(1_500); // let a would-be success path finish
  const rowsAfter = await driver.findElements(
    By.xpath(`//*[contains(text(), "Time log")]/following::div[contains(@class, "bg-muted/40")]`),
  );
  assert.strictEqual(
    rowsAfter.length,
    this.timeLogRowsBefore.length,
    "a time entry was created although the date falls on approved leave",
  );
});

// Exposed for the QA-hardening steps (e2e/steps/hr-qa-steps.js) — the date
// math and form-driving helpers must stay identical to the ones this file
// uses, or the two suites would drift apart.
module.exports = {
  iso,
  todayUTC,
  mondayAtLeast,
  dayOffset,
  setInputValue,
  waitForToast,
  rowWithReason,
  submitRange,
  showAllFilterIfPresent,
};

// ---------------------------------------------------------------------------
// F2.4 — leave policy engine steps (docs/Fernly_Policy_Engine_Design.md §4).
// ---------------------------------------------------------------------------

Then("the request form should show the advance allowance of {int} days", async function (floorDays) {
  const driver = await this.getDriver();
  await driver.wait(
    async () =>
      (await driver.getPageSource()).includes(`advance allowed to \u2212${floorDays}`),
    10_000,
    `the live preview did not show the advance allowance of ${floorDays} days`,
  );
});

Then("the leave balance for {string} should show the accrued advance balance", async function (typeName) {
  const driver = await this.getDriver();
  // The EARNED strategy grants 2 days per whole elapsed month of the
  // current year (capped at 24) — compute what today's accrual must be.
  const now = new Date();
  const monthsElapsed = now.getUTCMonth() + 1; // January = 1
  const expected = Math.min(24, monthsElapsed * 2);
  await driver.wait(
    async () => {
      try {
        const cards = await driver.findElements(
          By.xpath(`//div[contains(@class, "f-card")][contains(., "${typeName}")]//*[@data-testid='balance-available']`),
        );
        if (cards.length === 0) return false;
        return (await cards[0].getText()).trim() === String(expected);
      } catch (e) {
        if (e && /stale/i.test(String(e.name || e.message))) return false;
        throw e;
      }
    },
    10_000,
    `balance for "${typeName}" never showed the accrued ${expected} days`,
  );
});

// ---------------------------------------------------------------------------
// P24 (PL-01) — notification templates (Settings → Notifications) + the
// leave render-through: the admin customizes the "leave decided" template,
// the member's decision notification renders from it, and Reset restores
// the system default (the already-written notification row is frozen text
// — resetting never rewrites history).
// ---------------------------------------------------------------------------

async function openNotificationsSettingsTab(driver) {
  const tab = await driver.wait(
    until.elementLocated(By.css("[data-testid='settings-tab-notification-templates']")),
    10_000,
    "notification templates tab button not found",
  );
  await driver.executeScript("arguments[0].click();", tab);
  await driver.wait(
    until.elementsLocated(By.css("[data-testid='notification-template-card-LEAVE_PENDING']")),
    10_000,
    "notification template cards did not render",
  );
}

When("I open the notification templates settings tab", async function () {
  await openNotificationsSettingsTab(await this.getDriver());
});

async function waitForTemplateBadge(driver, eventKey, text) {
  // Re-locate per poll — the card re-renders (new config prop) after the
  // save/reset reload, invalidating held element references.
  await driver.wait(
    async () => {
      try {
        const badge = await driver.findElement(By.css(`[data-testid='tpl-badge-${eventKey}']`));
        return (await badge.getText()) === text;
      } catch {
        return false;
      }
    },
    10_000,
    `${eventKey} template badge never showed "${text}"`,
  );
}

Then("the leave decided template shows the system default", async function () {
  await waitForTemplateBadge(await this.getDriver(), "LEAVE_DECIDED", "System default");
});

When("I customize the leave decided notification to title {string} and message {string}", async function (title, message) {
  const driver = await this.getDriver();
  const titleEl = await driver.wait(
    until.elementLocated(By.css("[data-testid='tpl-title-LEAVE_DECIDED']")),
    10_000,
    "leave decided title field not found",
  );
  await titleEl.clear();
  await titleEl.sendKeys(title);
  const messageEl = await driver.findElement(By.css("[data-testid='tpl-message-LEAVE_DECIDED']"));
  await messageEl.clear();
  await messageEl.sendKeys(message);
  await driver.findElement(By.css("[data-testid='tpl-save-LEAVE_DECIDED']")).click();
  // The badge flips after the save → reload round-trip.
  await waitForTemplateBadge(driver, "LEAVE_DECIDED", "Customized");
});

When("I reset the leave decided notification template", async function () {
  const driver = await this.getDriver();
  await driver.findElement(By.css("[data-testid='tpl-reset-LEAVE_DECIDED']")).click();
  await waitForTemplateBadge(driver, "LEAVE_DECIDED", "System default");
});

When("I open the notifications bell", async function () {
  const driver = await this.getDriver();
  const bell = await driver.wait(
    until.elementLocated(By.css("button[aria-label='Notifications']")),
    10_000,
    "notifications bell not found",
  );
  await bell.click();
  await driver.wait(
    until.elementLocated(By.xpath("//*[contains(text(), 'Mark all read')]")),
    10_000,
    "notifications dropdown did not open",
  );
});

Then("the notification feed should mention {string}", async function (text) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.xpath(`//*[contains(text(), ${JSON.stringify(text)})]`)),
    10_000,
    `notification feed never mentioned "${text}"`,
  );
});

// ---------------------------------------------------------------------------
// P25 (PL-02) — the engagement reminder engine's settings surfaces.
// ---------------------------------------------------------------------------

Then("the engagement reminder toggles should render", async function () {
  const driver = await this.getDriver();
  for (const testId of [
    "birthday-reminders-toggle",
    "anniversary-reminders-toggle",
    "holiday-reminders-toggle",
    "engagement-email-toggle",
    "holiday-days-ahead-input",
  ]) {
    await driver.wait(
      until.elementLocated(By.css(`[data-testid='${testId}']`)),
      10_000,
      `${testId} did not render`,
    );
  }
});

// ---------------------------------------------------------------------------
// P26 (PL-03/RJ-B18) — the interview reminder engine's settings surfaces.
// ---------------------------------------------------------------------------

Then("the interview reminder toggles should render", async function () {
  const driver = await this.getDriver();
  for (const testId of [
    "interview-reminders-toggle",
    "interview-email-toggle",
  ]) {
    await driver.wait(
      until.elementLocated(By.css(`[data-testid='${testId}']`)),
      10_000,
      `${testId} did not render`,
    );
  }
});

Then("the {string} notification template card should render", async function (eventKey) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css(`[data-testid='notification-template-card-${eventKey}']`)),
    10_000,
    `${eventKey} template card did not render`,
  );
});
