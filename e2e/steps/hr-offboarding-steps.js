// Steps for the F2.1 offboarding feature (e2e/features/hr-offboarding.feature).
//
// The shared "I open the {string} tab" step (Directory/Reviews/Onboarding/
// Holidays/Attendance/Offboarding) lives in hr-directory-steps.js; the
// payslip steps ("I open the payslip for …" / "I set the loss-of-pay days
// to … and save") live in payroll-steps.js. This file owns the exit arc:
// directory exit with LWD, the offboarding card, the separation checklist,
// the exit interview lifecycle, and the statement generate/settle actions.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

async function offboardingCard(world, name) {
  const driver = await world.getDriver();
  return driver.wait(
    until.elementLocated(
      By.xpath(
        `//div[@data-testid='offboarding-card'][.//*[@data-testid='offboarding-name'][contains(text(), "${name}")]]`,
      ),
    ),
    15_000,
    `offboarding card for "${name}" not found`,
  );
}

// ---------------------------------------------------------------------------
// Directory: record the exit (status + last working day) via the profile
// edit modal — the guarded transitionEmployment action underneath.
// ---------------------------------------------------------------------------

When("I exit {string} with last working day {string}", async function (name, lwd) {
  const driver = await this.getDriver();
  const card = await driver.wait(
    until.elementLocated(
      By.xpath(
        `//div[@data-testid='hr-directory']//div[contains(@class, "f-card")][.//*[@data-testid='directory-name'][contains(text(), "${name}")]]`,
      ),
    ),
    15_000,
    `directory card for "${name}" not found`,
  );
  const editBtn = await card.findElement(By.xpath(`.//button[contains(@aria-label, "Edit")]`));
  await editBtn.click();

  const select = await driver.wait(
    until.elementLocated(By.css("[data-testid='employment-status-select']")),
    10_000,
    "employment status select not found in the profile edit modal",
  );
  // House pattern (hr-directory-steps.js): click the <option> directly so
  // React's onChange fires.
  const option = await select.findElement(By.xpath(`./option[normalize-space(.) = "Exited"]`));
  await option.click();

  // The LWD input only renders once "Exited" is the picked target.
  const lwdInput = await driver.wait(
    until.elementLocated(By.css("[data-testid='last-working-day-input']")),
    10_000,
    "last working day input not found after picking Exited",
  );
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    lwdInput,
    lwd,
  );

  await driver.findElement(By.xpath(`//button[contains(., "Save profile")]`)).click();
  await driver.wait(
    async () => {
      const toasts = await driver.findElements(By.css("[data-sonner-toast]"));
      for (const t of toasts) {
        const text = (await t.getText()).toLowerCase();
        if (text.includes("profile updated") || text.includes("last working day")) return true;
      }
      return false;
    },
    15_000,
    "no exit-transition outcome toast appeared",
  );
  await driver.sleep(1_200);
});

// ---------------------------------------------------------------------------
// The offboarding card
// ---------------------------------------------------------------------------

Then("the offboarding card for {string} should show status {string}", async function (name, status) {
  const card = await offboardingCard(this, name);
  const badge = await card.findElement(By.css("[data-testid='offboarding-status']"));
  const text = (await badge.getText()).trim();
  assert.ok(text.includes(status), `card for ${name} shows status "${text}", expected "${status}"`);
});

Then("the offboarding card for {string} should show last working day {string}", async function (name, lwd) {
  const card = await offboardingCard(this, name);
  const text = (await card.findElement(By.css("[data-testid='offboarding-lwd']")).getText()).trim();
  assert.ok(
    text.includes(lwd),
    `card for ${name} shows LWD "${text}", expected it to mention "${lwd}"`,
  );
});

// ---------------------------------------------------------------------------
// Separation checklist (kind SEPARATION via the shared machinery)
// ---------------------------------------------------------------------------

When("I start the separation checklist for {string}", async function (name) {
  const driver = await this.getDriver();
  const startBtn = await driver.wait(
    until.elementLocated(By.css("[data-testid='start-separation-btn']")),
    10_000,
    "Start separation button not found",
  );
  await startBtn.click();
  const select = await driver.wait(
    until.elementLocated(By.css("[data-testid='separation-user-select']")),
    10_000,
    "separation user select not found",
  );
  const option = await select.findElement(By.xpath(`./option[contains(normalize-space(.), "${name}")]`));
  await option.click();
  await driver.findElement(By.css("[data-testid='confirm-start-separation-btn']")).click();
  // The modal closes and the overview reloads with the new card section.
  await driver.sleep(1_500);
});

Then("the separation checklist for {string} should show {int} of {int} tasks done", async function (name, done, total) {
  const card = await offboardingCard(this, name);
  const checklist = await card.findElement(By.css("[data-testid='separation-checklist']"));
  const rows = await checklist.findElements(By.css("[data-testid^='separation-task-']"));
  assert.strictEqual(rows.length, total, `expected ${total} separation tasks, found ${rows.length}`);
  const doneCount = await checklist.findElements(
    By.css("[data-testid^='separation-task-'].bg-success"),
  );
  assert.strictEqual(doneCount.length, done, `expected ${done} done tasks, found ${doneCount.length}`);
});

// ---------------------------------------------------------------------------
// Exit interview lifecycle
// ---------------------------------------------------------------------------

Then("the exit interview for {string} should show status {string}", async function (name, status) {
  const card = await offboardingCard(this, name);
  const badge = await card.findElement(By.css("[data-testid='exit-interview-status']"));
  const text = (await badge.getText()).trim();
  assert.ok(
    text.includes(status),
    `exit interview for ${name} shows status "${text}", expected "${status}"`,
  );
});

When("I record an exit interview for {string}", async function (name) {
  const driver = await this.getDriver();
  const card = await offboardingCard(this, name);
  const btns = await card.findElements(By.css("[data-testid='record-interview-btn']"));
  if (btns.length === 0) {
    // Cucumber's retry re-runs the scenario against shared state — an
    // interview this attempt already recorded is a satisfied precondition,
    // not a failure (the badge assertion that follows pins the status).
    const badge = await card.findElements(By.css("[data-testid='exit-interview-status']"));
    if (badge.length > 0) {
      const text = (await badge[0].getText()).trim();
      if (text === "Pending" || text === "Scheduled") return;
    }
    throw new Error(`record-interview button not found on ${name}'s card and no live interview badge to fall back on`);
  }
  await btns[0].click();
  await driver.sleep(1_500);
});

When("I schedule the exit interview for {string} on {string}", async function (name, date) {
  const driver = await this.getDriver();
  const card = await offboardingCard(this, name);
  const input = await driver.wait(
    until.elementLocated(By.css("[data-testid='interview-date-input']")),
    10_000,
    "interview date input not found",
  );
  // NEVER sendKeys into <input type="date">: Chrome's segmented (en-US
  // MM/DD/YYYY) date widget re-parses the keystrokes into garbage
  // ("2026-11-12" typed becomes 61112-02-02). Use the house React-setter
  // pattern (hr-directory-steps.js / payroll-steps.js): the native
  // prototype value setter + a bubbled input event is a real change.
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    input,
    date,
  );
  await card.findElement(By.css("[data-testid='schedule-interview-btn']")).click();
  await driver.sleep(1_500);
});

When("I complete the exit interview for {string} with notes {string}", async function (name, notes) {
  const driver = await this.getDriver();
  const card = await offboardingCard(this, name);
  const input = await driver.wait(
    until.elementLocated(By.css("[data-testid='interview-notes-input']")),
    10_000,
    "interview notes input not found",
  );
  await input.clear();
  await input.sendKeys(notes);
  await card.findElement(By.css("[data-testid='complete-interview-btn']")).click();
  await driver.sleep(1_500);
});

// ---------------------------------------------------------------------------
// Full-and-final statement
// ---------------------------------------------------------------------------

Then("the statement for {string} should show status {string}", async function (name, status) {
  const card = await offboardingCard(this, name);
  const badge = await card.findElement(By.css("[data-testid='fnf-status']"));
  const text = (await badge.getText()).trim();
  assert.ok(
    text.toLowerCase().includes(status.toLowerCase()),
    `statement for ${name} shows status "${text}", expected "${status}"`,
  );
});

Then("the statement for {string} should list the line {string}", async function (name, needle) {
  const card = await offboardingCard(this, name);
  const section = await card.findElement(By.css("[data-testid='fnf-lines']"));
  const text = await section.getText();
  assert.ok(
    text.includes(needle),
    `statement lines for ${name} do not mention "${needle}": ${text.replace(/\n/g, " | ")}`,
  );
});

When("I generate the full-and-final statement for {string}", async function (name) {
  const driver = await this.getDriver();
  const card = await offboardingCard(this, name);
  const btn = await driver.wait(
    until.elementLocated(By.css("[data-testid='generate-fnf-btn']")),
    10_000,
    `generate statement button not found on ${name}'s card`,
  );
  await btn.click();
  // The overview reloads with the UNSETTLED state.
  await driver.sleep(1_800);
});

When("I settle the full-and-final statement for {string}", async function (name) {
  const driver = await this.getDriver();
  const card = await offboardingCard(this, name);
  const btn = await driver.wait(
    until.elementLocated(By.css("[data-testid='settle-fnf-btn']")),
    10_000,
    `settle button not found on ${name}'s card`,
  );
  await btn.click();
  // Settlement freezes the LIVE computation server-side (ledger reads) —
  // give the reload a beat before the badge assertion.
  await driver.sleep(2_000);
});

// ---------------------------------------------------------------------------
// The payslip lock (settlement locks editing)
// ---------------------------------------------------------------------------

Then("the payslip refusal toast should mention the settled statement", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      const toasts = await driver.findElements(By.css("[data-sonner-toast]"));
      for (const t of toasts) {
        const text = (await t.getText()).toLowerCase();
        if (text.includes("full-and-final") && text.includes("settled")) return true;
      }
      return false;
    },
    15_000,
    "no payslip refusal toast mentioning the settled statement appeared",
  );
});

// P38 (EM-16/EM-B12) — the extended line space: the LIVE computation's
// pending-bonus / pending-encashment lines (rendered on the UNSETTLED
// card, where computed is the live read).

Then("the statement for {string} should list the live line {string}", async function (name, needle) {
  const card = await offboardingCard(this, name);
  const section = await card.findElement(By.css("[data-testid='fnf-lines']"));
  const text = await section.getText();
  assert.ok(
    text.includes(needle),
    `live statement lines for ${name} do not mention "${needle}": ${text.replace(/\n/g, " | ")}`,
  );
});
