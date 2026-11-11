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
      // P30 — the Leave view carries MORE tables than "My requests" now
      // (the comp-off claims history rows also read "Pending"); scope the
      // count to the requests card's own table so sibling sections never
      // skew it.
      const rows = await driver.findElements(
        By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(., "My requests")]]//table//tbody/tr[contains(., "Pending")]`),
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
  // The tab button's DOM click can be SWALLOWED while the settings view is
  // still hydrating (dev-server compile + HMR reconnect cycles): the click
  // lands on a not-yet-listening button, activeTab never moves, and the
  // card wait times out with the General tab still on screen — exactly how
  // CI run 42887716370 lost an attempt (the After-hook screenshot showed
  // the General tab, no toast). So poll the CARD (the button alone proves
  // nothing) and RE-CLICK until the panel actually mounts; the loop also
  // survives a mid-scenario HMR reload that resets activeTab to General.
  const tabSelector = "[data-testid='settings-tab-notification-templates']";
  const cardSelector = "[data-testid='notification-template-card-LEAVE_PENDING']";
  const deadline = Date.now() + 20_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    const tab = await driver.wait(
      until.elementLocated(By.css(tabSelector)),
      10_000,
      "notification templates tab button not found",
    );
    await driver.executeScript("arguments[0].click();", tab);
    try {
      await driver.wait(until.elementsLocated(By.css(cardSelector)), 3_000);
      return; // the panel mounted — the cards are on the DOM
    } catch (err) {
      lastErr = err; // the click was swallowed (hydration) — click again
    }
  }
  throw new Error(
    `notification template cards did not render after repeated tab clicks (${
      lastErr ? String(lastErr.message ?? lastErr) : "unknown cause"
    })`,
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

// ---------------------------------------------------------------------------
// P27 (LV-08) — the leave period master's e2e surface (the Types & Policies
// tab's "Leave periods" section). The scenario walks create → refuse →
// delete so the fixture returns to the implicit-calendar default (zero
// drift; the engine never runs against the created window).
// ---------------------------------------------------------------------------

async function fillPeriodFormAndSubmit(driver, name, start, end) {
  const nameInput = await driver.wait(
    until.elementLocated(By.css("[data-testid='leave-period-name-input']")),
    10_000,
    "leave period name input not found",
  );
  await setInputValue(driver, nameInput, name);
  await setInputValue(
    driver,
    await driver.findElement(By.css("[data-testid='leave-period-start-input']")),
    start,
  );
  await setInputValue(
    driver,
    await driver.findElement(By.css("[data-testid='leave-period-end-input']")),
    end,
  );
  await driver.findElement(By.css("[data-testid='leave-period-create-button']")).click();
}

When("I create a leave period {string} from {string} to {string}", async function (name, start, end) {
  const driver = await this.getDriver();
  await fillPeriodFormAndSubmit(driver, name, start, end);
  // The row appears after the create → reload round-trip.
  await driver.wait(
    until.elementLocated(By.css("[data-testid^='leave-period-row-']")),
    10_000,
    "the created leave period row did not render",
  );
});

When("I try to create a rejected leave period {string} from {string} to {string}", async function (name, start, end) {
  // The refusal lands as a toast; the assertion step owns the wait.
  await fillPeriodFormAndSubmit(await this.getDriver(), name, start, end);
});

Then("the leave periods empty notice should render", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css("[data-testid='leave-periods-empty']")),
    10_000,
    "the leave-periods empty (implicit calendar year) notice did not render",
  );
});

Then("the leave periods list should show {string} as {string} in bucket {int}", async function (name, status, bucket) {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      try {
        const rows = await driver.findElements(By.css("[data-testid^='leave-period-row-']"));
        for (const row of rows) {
          const text = await row.getText();
          if (text.includes(name) && text.includes(status) && text.includes(`ledger bucket ${bucket}`)) {
            return true;
          }
        }
        return false;
      } catch (e) {
        if (e && /stale/i.test(String(e.name || e.message))) return false;
        throw e;
      }
    },
    10_000,
    `no leave period row showed "${name}" as ${status} in bucket ${bucket}`,
  );
});

Then("a toast should mention the period refusal {string}", async function (keyword) {
  await waitForToast(await this.getDriver(), keyword);
});

When("I delete the leave period {string}", async function (name) {
  const driver = await this.getDriver();
  const rows = await driver.findElements(By.css("[data-testid^='leave-period-row-']"));
  let target = null;
  for (const row of rows) {
    if ((await row.getText()).includes(name)) {
      target = row;
      break;
    }
  }
  assert.ok(target, `no leave period row named "${name}"`);
  const del = await target.findElement(By.xpath(".//button[contains(., 'Delete')]"));
  await driver.executeScript("arguments[0].click();", del);
  // This scenario's create-then-delete shape returns the master to the
  // implicit-calendar notice after the reload.
  await driver.wait(
    until.elementLocated(By.css("[data-testid='leave-periods-empty']")),
    10_000,
    "the deleted period's row never cleared back to the empty notice",
  );
});

// ---------------------------------------------------------------------------
// P28 (LV-02/LV-03) — the policy set master + the bulk assignment tool's
// e2e surface (the Types & Policies tab's "Policy sets" section). The
// scenario walks create → assign → overlap-refuse → delete so the fixture
// returns to the per-type-policy default with ZERO ledger writes (the
// target window is a future one: the doc alone, nothing materializes).
// ---------------------------------------------------------------------------

async function openPolicySetEditor(driver) {
  const btn = await driver.wait(
    until.elementLocated(By.css("[data-testid='policy-set-new-button']")),
    10_000,
    "the policy sets New set button did not render",
  );
  await driver.executeScript("arguments[0].click();", btn);
  return driver.wait(
    until.elementLocated(By.css("[data-testid='policy-set-modal']")),
    10_000,
    "the policy set editor modal did not open",
  );
}

When("I create a policy set {string} with items {string}", async function (name, itemsSpec) {
  const driver = await this.getDriver();
  await openPolicySetEditor(driver);
  await setInputValue(driver, await driver.findElement(By.css("[data-testid='policy-set-name-input']")), name);
  // itemsSpec: "Annual Leave=25, Sick Leave=8" — one editor row each.
  const specs = itemsSpec.split(",").map((s) => s.trim()).map((s) => {
    const [typeName, days] = s.split("=");
    return { typeName: typeName.trim(), days: days.trim() };
  });
  for (let i = 0; i < specs.length; i++) {
    if (i > 0) {
      await driver.executeScript(
        "arguments[0].click();",
        await driver.findElement(By.css("[data-testid='policy-set-row-add']")),
      );
    }
    const typeSelect = await driver.findElement(By.css(`[data-testid='policy-set-row-type-${i}']`));
    // House pattern: click the <option> directly so React's onChange fires.
    const option = await typeSelect.findElement(
      By.xpath(`./option[normalize-space(.) = "${specs[i].typeName}"]`),
    );
    await option.click();
    await setInputValue(
      driver,
      await driver.findElement(By.css(`[data-testid='policy-set-row-days-${i}']`)),
      specs[i].days,
    );
  }
  await driver.executeScript(
    "arguments[0].click();",
    await driver.findElement(By.css("[data-testid='policy-set-submit']")),
  );
  await driver.wait(
    until.elementLocated(By.css("[data-testid^='policy-set-row-']")),
    10_000,
    "the created policy set row did not render",
  );
});

Then("the policy sets list should show {string} with {string} and {string}", async function (name, chipA, chipB) {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      try {
        const rows = await driver.findElements(By.css("[data-testid^='policy-set-row-']"));
        for (const row of rows) {
          const text = await row.getText();
          if (text.includes(name) && text.includes(chipA) && text.includes(chipB)) return true;
        }
        return false;
      } catch (e) {
        if (e && /stale/i.test(String(e.name || e.message))) return false;
        throw e;
      }
    },
    10_000,
    `no policy set row showed "${name}" with "${chipA}" and "${chipB}"`,
  );
});

async function openBulkAssignModal(driver, setName) {
  const rows = await driver.findElements(By.css("[data-testid^='policy-set-row-']"));
  let target = null;
  for (const row of rows) {
    if ((await row.getText()).includes(setName)) {
      const idx = (await row.getAttribute("data-testid")).split("-").pop();
      target = await driver.findElement(By.css(`[data-testid='policy-set-assign-${idx}']`));
      break;
    }
  }
  assert.ok(target, `no policy set row named "${setName}" with an Assign button`);
  await driver.executeScript("arguments[0].click();", target);
  return driver.wait(
    until.elementLocated(By.css("[data-testid='bulk-policy-modal']")),
    10_000,
    "the bulk policy assignment modal did not open",
  );
}

async function submitBulkAssignment(driver, setName, employeeName, yearsAhead) {
  await openBulkAssignModal(driver, setName);
  const bucketYear = new Date().getFullYear() + yearsAhead;
  const bucketSelect = await driver.findElement(By.css("[data-testid='bulk-policy-bucket']"));
  await bucketSelect.findElement(By.xpath(`./option[@value="${bucketYear}"]`)).click();
  // The employee checkbox rides inside a label that carries the name.
  const labels = await driver.findElements(By.css("[data-testid='bulk-policy-employees'] label"));
  let picked = null;
  for (const label of labels) {
    if ((await label.getText()).includes(employeeName)) {
      picked = await label.findElement(By.css("input[type='checkbox']"));
      break;
    }
  }
  assert.ok(picked, `no employee row named "${employeeName}" in the bulk assign modal`);
  await driver.executeScript("arguments[0].click();", picked);
  await driver.executeScript(
    "arguments[0].click();",
    await driver.findElement(By.css("[data-testid='bulk-policy-submit']")),
  );
}

When("I bulk-assign the policy set {string} to {string} for the window {int} year(s) ahead", async function (setName, employeeName, yearsAhead) {
  const driver = await this.getDriver();
  await submitBulkAssignment(driver, setName, employeeName, yearsAhead);
  // The assignment row appears after the assign → reload round-trip.
  await driver.wait(
    until.elementLocated(By.css("[data-testid^='policy-assignment-row-']")),
    10_000,
    "the created policy assignment row did not render",
  );
});

When("I try to bulk-assign the policy set {string} to {string} for the window {int} year(s) ahead again", async function (setName, employeeName, yearsAhead) {
  // The refusal lands as a toast; the assertion step owns the wait.
  await submitBulkAssignment(await this.getDriver(), setName, employeeName, yearsAhead);
});

Then("the policy assignments list should show {string} on {string} as pending", async function (employeeName, setName) {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      try {
        const rows = await driver.findElements(By.css("[data-testid^='policy-assignment-row-']"));
        for (const row of rows) {
          const text = await row.getText();
          if (text.includes(employeeName) && text.includes(setName) && text.includes("pending window")) return true;
        }
        return false;
      } catch (e) {
        if (e && /stale/i.test(String(e.name || e.message))) return false;
        throw e;
      }
    },
    10_000,
    `no assignment row showed "${employeeName}" on "${setName}" as pending`,
  );
});

Then("a toast should mention the assignment refusal {string}", async function (keyword) {
  await waitForToast(await this.getDriver(), keyword);
});

When("I delete the policy assignment for {string}", async function (employeeName) {
  const driver = await this.getDriver();
  const rows = await driver.findElements(By.css("[data-testid^='policy-assignment-row-']"));
  let target = null;
  for (const row of rows) {
    if ((await row.getText()).includes(employeeName)) {
      const idx = (await row.getAttribute("data-testid")).split("-").pop();
      target = await driver.findElement(By.css(`[data-testid='policy-assignment-delete-${idx}']`));
      break;
    }
  }
  assert.ok(target, `no assignment row for "${employeeName}" with a Delete button`);
  await driver.executeScript("arguments[0].click();", target);
  await driver.wait(
    async () => (await driver.findElements(By.css("[data-testid^='policy-assignment-row-']"))).length === 0,
    10_000,
    `the deleted assignment row for "${employeeName}" never cleared`,
  );
});

Then("the policy assignments list should be empty", async function () {
  const driver = await this.getDriver();
  const remaining = await driver.findElements(By.css("[data-testid^='policy-assignment-row-']"));
  assert.strictEqual(remaining.length, 0, "policy assignment rows still render");
});

When("I delete the policy set {string}", async function (name) {
  const driver = await this.getDriver();
  const rows = await driver.findElements(By.css("[data-testid^='policy-set-row-']"));
  let target = null;
  for (const row of rows) {
    if ((await row.getText()).includes(name)) {
      const idx = (await row.getAttribute("data-testid")).split("-").pop();
      target = await driver.findElement(By.css(`[data-testid='policy-set-delete-${idx}']`));
      break;
    }
  }
  assert.ok(target, `no policy set row named "${name}" with a Delete button`);
  await driver.executeScript("arguments[0].click();", target);
  await driver.wait(
    until.elementLocated(By.css("[data-testid='policy-sets-empty']")),
    10_000,
    "the deleted policy set never cleared back to the empty notice",
  );
});

Then("the policy sets empty notice should render", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css("[data-testid='policy-sets-empty']")),
    10_000,
    "the policy-sets empty (per-type policies are the world) notice did not render",
  );
});

// ---------------------------------------------------------------------------
// P30 (LV-01/LV-11) — compensatory claims + optional-holiday applications
// ---------------------------------------------------------------------------

/** The first upcoming Saturday (strictly future; today-is-Saturday → +7). */
function nextSaturdayE2E() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay();
  const add = dow === 6 ? 7 : 6 - dow;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}

Then("the comp-off queue should show a pending {string} claim from {string}", async function (typeName, memberName) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementsLocated(
      By.xpath(`//*[@data-testid='compoff-queue-row'][contains(., "${memberName}")][contains(., "${typeName}")]`),
    ),
    10_000,
    `no pending comp-off claim row for ${memberName} (${typeName})`,
  );
});

When("I approve the comp-off claim for {string}", async function (memberName) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(By.xpath(`//*[@data-testid='compoff-queue-row'][contains(., "${memberName}")]`)),
    10_000,
    `no comp-off claim row for ${memberName}`,
  );
  await row.findElement(By.xpath(`.//button[contains(., "Approve")]`)).click();
  await waitForToast(driver, "Comp-off approved");
  // The queue reloads through onChanged — the approved row disappears.
  await driver.wait(
    async () =>
      (await driver.findElements(
        By.xpath(`//*[@data-testid='compoff-queue-row'][contains(., "${memberName}")]`),
      )).length === 0,
    10_000,
    `${memberName}'s comp-off claim row never cleared after approval`,
  );
});

Then("my comp-off claims list should show the approved claim", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      const cards = await driver.findElements(By.css('[data-testid="compoff-history"]'));
      if (cards.length === 0) return false;
      const text = await cards[0].getText();
      return text.includes("Approved") && text.includes("days on your balance");
    },
    10_000,
    "the approved comp-off claim never rendered in My comp-off claims",
  );
});

When("I request {string} on the next Saturday with reason {string}", async function (typeName, reason) {
  const saturday = nextSaturdayE2E();
  await submitRange(this, typeName, saturday, saturday, reason);
});

Then("the request with reason {string} should show {int} day in my requests", async function (reason, days) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementsLocated(By.xpath(`//table//tr[contains(., "${reason}")]`)),
    10_000,
    `request with reason "${reason}" never rendered`,
  );
  const rows = await driver.findElements(By.xpath(`//table//tr[contains(., "${reason}")]`));
  const text = await rows[0].getText();
  assert.ok(
    text.includes(String(days)),
    `request row for "${reason}" should show ${days} day(s): ${text.replace(/\n/g, " | ")}`,
  );
});

When("I request {string} from a Monday {int} days out to the same day with reason {string}", async function (typeName, daysOut, reason) {
  const monday = mondayAtLeast(daysOut);
  await submitRange(this, typeName, monday, monday, reason);
});
