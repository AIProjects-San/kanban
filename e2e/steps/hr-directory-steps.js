// Steps for the HR directory feature (e2e/features/hr-directory.feature).

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

const DIRECTORY_ROOT = By.css("[data-testid='hr-directory']");

async function openDirectoryTab(world) {
  const driver = await world.getDriver();
  const tab = await driver.wait(
    until.elementLocated(By.xpath(`//button[contains(., "Directory")]`)),
    10_000,
    "Directory tab button not found",
  );
  await driver.executeScript("arguments[0].click();", tab);
  await driver.wait(until.elementsLocated(DIRECTORY_ROOT), 10_000, "directory did not render");
}

When("I open the {string} tab", async function (label) {
  const driver = await this.getDriver();
  if (label === "Directory") {
    await openDirectoryTab(this);
    return;
  }
  if (label === "Reviews") {
    const tab = await driver.wait(
      until.elementLocated(By.xpath(`//button[contains(., "Reviews")]`)),
      10_000,
      "Reviews tab button not found",
    );
    await driver.executeScript("arguments[0].click();", tab);
    await driver.wait(until.elementsLocated(By.css("[data-testid='hr-reviews']")), 10_000, "reviews queue did not render");
    return;
  }
  if (label === "Onboarding") {
    const tab = await driver.wait(
      until.elementLocated(By.xpath(`//button[contains(., "Onboarding")]`)),
      10_000,
      "Onboarding tab button not found",
    );
    await driver.executeScript("arguments[0].click();", tab);
    await driver.wait(until.elementsLocated(By.css("[data-testid='hr-onboarding']")), 10_000, "onboarding tab did not render");
    return;
  }
  if (label === "Holidays") {
    // F1.1 — the holiday calendar tab (hr-holidays.tsx). It renders either
    // entries or the empty-state text; wait for the section header.
    const tab = await driver.wait(
      until.elementLocated(By.xpath(`//button[contains(normalize-space(.), "Holidays")]`)),
      10_000,
      "Holidays tab button not found",
    );
    await driver.executeScript("arguments[0].click();", tab);
    await driver.wait(
      until.elementLocated(By.xpath("//*[contains(text(), 'Holiday calendar')]")),
      10_000,
      "holiday calendar tab did not render",
    );
    return;
  }
  if (label === "Attendance") {
    // F1.3 — the attendance month grid tab (hr-attendance.tsx). EXACT text
    // match: the sidebar's "My Attendance" nav leaf also contains the word
    // "Attendance", and a contains() XPath would click THAT instead of the
    // console tab.
    const tab = await driver.wait(
      until.elementLocated(By.xpath(`//button[normalize-space(.) = "Attendance"]`)),
      10_000,
      "Attendance tab button not found",
    );
    await driver.executeScript("arguments[0].click();", tab);
    await driver.wait(
      until.elementsLocated(By.css("[data-testid='hr-attendance']")),
      10_000,
      "attendance tab did not render",
    );
    return;
  }
  if (label === "Types & Policies") {
    // P27 (LV-08) — the leave type/policy editor + the leave period master
    // (hr:admin-gated). EXACT match: nothing else carries the "&" label.
    const tab = await driver.wait(
      until.elementLocated(By.xpath(`//button[normalize-space(.) = "Types & Policies"]`)),
      10_000,
      "Types & Policies tab button not found",
    );
    await driver.executeScript("arguments[0].click();", tab);
    await driver.wait(
      until.elementsLocated(By.css("[data-testid='leave-periods-section']")),
      10_000,
      "types & policies tab did not render the leave period master",
    );
    return;
  }
  if (label === "Offboarding") {
    // F2.1 — the offboarding tab (hr-offboarding.tsx), hr:admin-gated.
    // EXACT match so the sidebar never shadows it.
    const tab = await driver.wait(
      until.elementLocated(By.xpath(`//button[normalize-space(.) = "Offboarding"]`)),
      10_000,
      "Offboarding tab button not found",
    );
    await driver.executeScript("arguments[0].click();", tab);
    await driver.wait(
      until.elementsLocated(By.css("[data-testid='hr-offboarding']")),
      10_000,
      "offboarding tab did not render",
    );
    return;
  }
  throw new Error(`unknown tab: ${label}`);
});

Then("the directory should show at least {int} profiles", async function (count) {
  const driver = await this.getDriver();
  // CI-stabilization: the seeded roster baseline is 13, but hiring.feature
  // (alphabetically earlier) provisions a 14th account via "mark joined"
  // before this scenario runs — an exact-13 wait could never pass since R6.
  // At-least semantics keep the intent (seeded roster renders) robust to
  // legitimate cross-feature data drift.
  await driver.wait(
    async () => {
      const cards = await driver.findElements(By.css("[data-testid='directory-name']"));
      return cards.length >= count;
    },
    15_000,
    `directory never showed at least ${count} profiles`,
  );
});

Then("the directory should show {int} profiles", async function (count) {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      const cards = await driver.findElements(By.css("[data-testid='directory-name']"));
      return cards.length === count;
    },
    10_000,
    `directory never showed exactly ${count} profiles`,
  );
});

async function directoryCard(world, name) {
  const driver = await world.getDriver();
  return driver.wait(
    until.elementLocated(
      By.xpath(`//div[@data-testid='hr-directory']//div[contains(@class, "f-card")][.//*[@data-testid='directory-name'][contains(text(), "${name}")]]`),
    ),
    10_000,
    `directory card for "${name}" not found`,
  );
}

Then("the directory card for {string} should show manager {string}", async function (name, manager) {
  const card = await directoryCard(this, name);
  const text = await card.getText();
  assert.ok(text.includes(manager), `card for ${name} does not mention manager ${manager}`);
});

Then("the directory card for {string} should show job title {string}", async function (name, title) {
  const card = await directoryCard(this, name);
  const text = await card.getText();
  assert.ok(text.includes(title), `card for ${name} does not show job title "${title}"`);
});

// F1.6 — employment lifecycle (§7.1): the card badge ("" renders as
// "Not set" per the QA-19 no-fabrication discipline).
Then("the directory card for {string} should show employment status {string}", async function (name, status) {
  const card = await directoryCard(this, name);
  const badge = await card.findElement(By.css("[data-testid='employment-status']"));
  const text = (await badge.getText()).trim();
  assert.ok(
    text.includes(status),
    `card for ${name} shows employment status "${text}", expected it to mention "${status}"`,
  );
});

// F1.6 — pick a new status in the edit modal and save. The guarded
// transitionEmployment action answers FIRST: a refusal (§9.3 hard gate,
// missing last working day) surfaces as an error toast and the save STOPS
// with the modal still open; a success proceeds to the plain profile save
// ("Profile updated" toast) and the modal closes + the directory reloads.
// The step stays outcome-agnostic — the scenarios assert which toast and
// card status followed.
When("I change {string} employment status to {string}", async function (name, status) {
  const driver = await this.getDriver();
  const card = await directoryCard(this, name);
  const editBtn = await card.findElement(By.xpath(`.//button[contains(@aria-label, "Edit")]`));
  await editBtn.click();
  const select = await driver.wait(
    until.elementLocated(By.css("[data-testid='employment-status-select']")),
    10_000,
    "employment status select not found in the profile edit modal",
  );
  // House pattern (hr-attendance-steps.js): click the <option> directly —
  // option.click() fires the change event React's onChange listens for.
  const option = await select.findElement(
    By.xpath(`./option[normalize-space(.) = "${status}"]`),
  );
  await option.click();
  await driver.findElement(By.xpath(`//button[contains(., "Save profile")]`)).click();
  await driver.wait(
    async () => {
      const toasts = await driver.findElements(By.css("[data-sonner-toast]"));
      for (const t of toasts) {
        const text = (await t.getText()).toLowerCase();
        if (text.includes("probation review outstanding") || text.includes("profile updated")) {
          return true;
        }
      }
      return false;
    },
    15_000,
    "no employment-transition outcome toast appeared",
  );
  await driver.sleep(1_200);
  // A refused transition leaves the modal open — close it so later card
  // assertions read a clean directory (a successful one already closed it).
  const cancel = await driver.findElements(
    By.xpath(`//div[@role='dialog']//button[contains(., "Cancel")]`),
  );
  if (cancel.length > 0) await driver.executeScript("arguments[0].click();", cancel[0]);
  // The directory reload after a successful save is asynchronous — re-open
  // the tab defensively if the view remounted to its default tab.
  const tabs = await driver.findElements(By.xpath(`//button[contains(., "Directory")]`));
  if (tabs.length > 0) {
    const root = await driver.findElements(DIRECTORY_ROOT);
    if (root.length === 0) await driver.executeScript("arguments[0].click();", tabs[0]);
  }
});

When("I search the directory for {string}", async function (query) {
  const driver = await this.getDriver();
  const input = await driver.wait(
    until.elementLocated(By.css("input[aria-label='Search directory']")),
    10_000,
    "directory search input not found",
  );
  await input.clear();
  await input.sendKeys(query);
  await driver.sleep(600);
});

Then("the directory should not expose profile edit buttons", async function () {
  const driver = await this.getDriver();
  await driver.sleep(500);
  const buttons = await driver.findElements(
    By.xpath(`//div[@data-testid='hr-directory']//button[contains(@aria-label, "Edit")][contains(@aria-label, "profile")]`),
  );
  assert.strictEqual(buttons.length, 0, "a read-only viewer (manager) can see profile edit buttons");
});

When("I edit {string}'s profile setting job title to {string}", async function (name, title) {
  const driver = await this.getDriver();
  const card = await directoryCard(this, name);
  const editBtn = await card.findElement(By.xpath(`.//button[contains(@aria-label, "Edit")]`));
  await editBtn.click();
  const jobInput = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role='dialog']//input[1]`)),
    10_000,
    "profile edit modal did not open",
  );
  // The first input in the modal form is the job title field.
  await jobInput.clear();
  await jobInput.sendKeys(title);
  await driver.findElement(By.xpath(`//button[contains(., "Save profile")]`)).click();
  await driver.sleep(1_200);
  // The modal close + directory reload is asynchronous — re-open the tab
  // defensively in case the view remounted to its default tab.
  const tabs = await driver.findElements(By.xpath(`//button[contains(., "Directory")]`));
  if (tabs.length > 0) {
    const root = await driver.findElements(DIRECTORY_ROOT);
    if (root.length === 0) await driver.executeScript("arguments[0].click();", tabs[0]);
  }
});

When("I set my employee profile phone to {string}", async function (phone) {
  const driver = await this.getDriver();
  // The Settings view's employee-profile card: job data is read-only
  // (QA-10), so the FIRST text input in the card is the phone field.
  const section = await driver.wait(
    until.elementLocated(
      By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "Employee profile")]]`),
    ),
    10_000,
    "employee profile section not found in settings",
  );
  // NOTE: scope the input lookup to the SECTION — a driver-level
  // `.//input[1]` resolves against the whole document (the first input on
  // the Settings page), which silently typed the phone number into the
  // wrong field and made this scenario fail only after a fresh re-seed
  // (before that, the DB already held the expected value from a probe run).
  const phoneInput = await section.findElement(By.xpath(`.//input[1]`));
  await phoneInput.clear();
  await phoneInput.sendKeys(phone);
  const save = await section.findElement(By.xpath(`.//button[contains(., "Save employee profile")]`));
  await save.click();
  // Wait for the server action to COMPLETE (the success toast) — a fixed
  // sleep could reload the page while the POST is still in flight (dev
  // cold-compiles the action module on first call), silently losing the
  // save when the page unloads.
  const { waitForToast } = require("./hr-steps");
  await waitForToast(driver, "Employee profile saved");
});

When("I reload and reopen the Settings view", async function () {
  const driver = await this.getDriver();
  // A hard reload (not client-side navigation) so the persisted values are
  // re-fetched from the server — proving the save actually stuck.
  await driver.get(this.baseUrl || "http://localhost:3000");
  await driver.sleep(1_500);
  const body = await driver.findElement(By.css("body"));
  for (let i = 0; i < 10; i++) {
    await body.sendKeys("g", "s");
    await driver.sleep(800);
    const found = await driver.findElements(
      By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "Employee profile")]]`),
    );
    if (found.length > 0) return;
  }
  throw new Error("Settings view did not render the employee profile card after reload");
});

Then("my employee profile should show job data as read-only", async function () {
  const driver = await this.getDriver();
  const section = await driver.wait(
    until.elementLocated(
      By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "Employee profile")]]`),
    ),
    10_000,
    "employee profile section not found in settings",
  );
  // QA-10: the job-data strip exists, is not an input, and carries the
  // read-only testids.
  const roTitle = await driver.wait(
    until.elementLocated(By.css("[data-testid='ro-job-title']")),
    10_000,
    "read-only job title element not found — job data became editable again?",
  );
  const tag = await roTitle.getTagName();
  assert.strictEqual(tag, "span", `job title is editable (${tag}), expected a read-only span`);
  const jobInputs = await section.findElements(
    By.xpath(`.//input[@placeholder="e.g. Senior Frontend Engineer"]`),
  );
  assert.strictEqual(jobInputs.length, 0, "a job-title input is still present in the self-service card");
  const deptSelects = await section.findElements(By.css("select"));
  assert.strictEqual(deptSelects.length, 0, "a department select is still present in the self-service card");
});

Then("my employee profile should show phone {string}", async function (phone) {
  const driver = await this.getDriver();
  // Re-locate the card on EVERY poll — the section's children are replaced
  // when the async profile fetch resolves (loading → form), which can go
  // stale mid-poll.
  await driver.wait(
    async () => {
      const section = await driver.findElement(
        By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "Employee profile")]]`),
      );
      return (await section.findElement(By.xpath(`.//input[1]`)).getAttribute("value")) === phone;
    },
    10_000,
    "saved phone did not persist after reload",
  );
});

// ---------------------------------------------------------------------------
// P34 (EM-03) — the grouping axes: the org-slicing filter chips and the
// card's Grade / Type / Branch lines. The step waits for the roster BEFORE
// picking (the chips' grade/branch options derive from the loaded roster),
// then re-polls the count until React settles — the same discipline the
// search step uses.
// ---------------------------------------------------------------------------

async function pickFilterChip(world, testId, value) {
  const driver = await world.getDriver();
  await driver.wait(
    until.elementsLocated(By.css("[data-testid='directory-name']")),
    10_000,
    "directory roster did not render",
  );
  const chip = await driver.findElement(By.css(`[data-testid='${testId}']`));
  // Two-part fix (P36 verification round): (1) resolve the option by its
  // visible TEXT — the employment-type chip keys its option values
  // (INTERN / FULL_TIME) while the steps say "Intern" / "Full-time", and a
  // raw value assignment that matches nothing leaves the filter empty;
  // (2) drive the NATIVE value setter (the suite-wide discipline) so
  // React's tracker registers the change.
  const resolved = await driver.executeScript(
    `const el = arguments[0], label = arguments[1];
     const opt = Array.from(el.options).find(o => o.textContent.trim() === label || o.value === label);
     return opt ? opt.value : "";`,
    chip, value,
  );
  assert.ok(resolved, `filter chip option "${value}" not found`);
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    chip,
    resolved,
  );
  await driver.sleep(600);
}

When("I filter the directory by employment type to {string}", async function (value) {
  await pickFilterChip(this, "directory-filter-employment-type", value);
});

When("I filter the directory by grade to {string}", async function (value) {
  await pickFilterChip(this, "directory-filter-grade", value);
});

When("I filter the directory by branch to {string}", async function (value) {
  await pickFilterChip(this, "directory-filter-branch", value);
});

When("I filter the directory by department to {string}", async function (value) {
  await pickFilterChip(this, "directory-filter-department", value);
});

Then("the directory card for {string} should show grade {string}", async function (name, grade) {
  const card = await directoryCard(this, name);
  const line = await card.findElement(By.css("[data-testid='directory-grade']"));
  const text = (await line.getText()).trim();
  assert.ok(
    text.includes(grade),
    `card for ${name} shows grade "${text}", expected it to mention "${grade}"`,
  );
});

Then("the directory card for {string} should show employment type {string}", async function (name, typeLabel) {
  const card = await directoryCard(this, name);
  const line = await card.findElement(By.css("[data-testid='directory-employment-type']"));
  const text = (await line.getText()).trim();
  assert.ok(
    text.includes(typeLabel),
    `card for ${name} shows employment type "${text}", expected it to mention "${typeLabel}"`,
  );
});

Then("the directory card for {string} should show branch {string}", async function (name, branch) {
  const card = await directoryCard(this, name);
  const line = await card.findElement(By.css("[data-testid='directory-branch']"));
  const text = (await line.getText()).trim();
  assert.ok(
    text.includes(branch),
    `card for ${name} shows branch "${text}", expected it to mention "${branch}"`,
  );
});

// P36 (EM-21) — employee identification documents: the panel, the
// lifecycle (request / submit / verify) and the member self-service mount.

async function openIdPanel(world, name) {
  const driver = await world.getDriver();
  await openDirectoryTab(world);
  const btn = await driver.wait(
    until.elementLocated(By.xpath(`//button[@data-testid='directory-docs-${name}']`)),
    10_000,
    `identification-documents button for ${name} not found`,
  );
  await driver.executeScript("arguments[0].click();", btn);
  return driver.wait(
    until.elementLocated(By.css("[data-testid='employee-documents-panel']")),
    10_000,
    "identification-documents panel did not render",
  );
}

When("I open the identification documents panel for {string}", async function (name) {
  await openIdPanel(this, name);
});

When("I request the {string} identification document", async function (label) {
  const driver = await this.getDriver();
  const select = await driver.wait(
    until.elementLocated(By.css("[data-testid='employee-doc-type-select']")),
    10_000,
    "identification type select not found",
  );
  const value = await driver.executeScript(
    `const el = arguments[0];
     return Array.from(el.options).find(o => o.textContent.includes(arguments[1]))?.value ?? "";`,
    select, label,
  );
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    select, value,
  );
  await driver.findElement(By.xpath(`//form[@data-testid='employee-doc-request-form']//button[contains(., "Request")]`)).click();
  await driver.sleep(1_200);
});

Then("the identification panel shows {string} as {string}", async function (label, status) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(By.xpath(`//div[@data-testid='employee-doc-${label}']`)),
    10_000,
    `identification row "${label}" not found`,
  );
  const text = await row.getText();
  assert.ok(text.includes(status), `"${label}" row does not show ${status} (got: ${text})`);
});

When("I submit my identification document {string} with reference {string}", async function (label, fileRef) {
  const driver = await this.getDriver();
  const input = await driver.wait(
    until.elementLocated(By.css(`[data-testid='doc-fileref-${label}']`)),
    10_000,
    `file-reference input for "${label}" not found`,
  );
  await input.clear();
  await input.sendKeys(fileRef);
  await driver.findElement(By.css(`[data-testid='doc-submit-${label}']`)).click();
  await driver.sleep(1_200);
});

Then("my identification documents show {string} as {string}", async function (label, status) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(By.xpath(`//div[@data-testid='employee-doc-${label}']`)),
    10_000,
    `identification row "${label}" not found in settings`,
  );
  const text = await row.getText();
  assert.ok(text.includes(status), `"${label}" does not show ${status} (got: ${text})`);
});

When("I verify the identification document {string}", async function (label) {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css(`[data-testid='doc-verify-${label}']`)),
    10_000,
    `verify button for "${label}" not found`,
  );
  await driver.executeScript("arguments[0].click();", btn);
  await driver.sleep(1_200);
});

// P37 (EM-19, PF-07, EM-18) — the skill master + employee skill maps: the
// card's top-skills line, the map panel and the member read-only view.

Then("the directory card for {string} should show top skills including {string}", async function (name, expected) {
  const card = await directoryCard(this, name);
  const line = await card.findElement(By.css("[data-testid='directory-top-skills']"));
  const text = await line.getText();
  assert.ok(text.includes(expected), `"${name}" top skills does not include "${expected}" (got: ${text})`);
});

async function openSkillPanel(world, name) {
  const driver = await world.getDriver();
  await openDirectoryTab(world);
  const btn = await driver.wait(
    until.elementLocated(By.xpath(`//button[@data-testid='directory-skills-${name}']`)),
    10_000,
    `skill-map button for ${name} not found`,
  );
  await driver.executeScript("arguments[0].click();", btn);
  return driver.wait(
    until.elementLocated(By.css("[data-testid='skill-map-panel']")),
    10_000,
    "skill-map panel did not render",
  );
}

When("I open the skill map panel for {string}", async function (name) {
  await openSkillPanel(this, name);
});

Then("the skill map summary shows no rated skills yet", async function () {
  const driver = await this.getDriver();
  const summary = await driver.wait(
    until.elementLocated(By.css("[data-testid='skill-map-summary']")),
    10_000,
  );
  const text = await summary.getText();
  assert.ok(/no rated skills yet/.test(text), `summary does not show the empty state (got: ${text})`);
});

Then("the skill map summary shows {int} skill(s)", async function (count) {
  const driver = await this.getDriver();
  const summary = await driver.wait(
    until.elementLocated(By.css("[data-testid='skill-map-summary']")),
    10_000,
  );
  const text = await summary.getText();
  assert.ok(new RegExp(`^${count} skill`).test(text), `summary does not show ${count} skill(s) (got: ${text})`);
});

When("I rate the {string} skill {int} with note {string}", async function (label, rating, note) {
  const driver = await this.getDriver();
  const select = await driver.wait(
    until.elementLocated(By.css("[data-testid='skill-rate-select']")),
    10_000,
    "skill select not found",
  );
  const value = await driver.executeScript(
    `const el = arguments[0];
     return Array.from(el.options).find(o => o.textContent.includes(arguments[1]))?.value ?? "";`,
    select, label,
  );
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    select, value,
  );
  const ratingSelect = await driver.findElement(By.css("[data-testid='skill-rate-value']"));
  await driver.executeScript(
    `const el = arguments[0], val = String(arguments[1]);
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    ratingSelect, rating,
  );
  const noteInput = await driver.findElement(By.xpath("//form[@data-testid='skill-rate-form']//input"));
  await noteInput.clear();
  await noteInput.sendKeys(note);
  await driver.findElement(By.xpath("//form[@data-testid='skill-rate-form']//button[contains(., 'Rate')]")).click();
  await driver.sleep(1_200);
});

Then("the skill map shows {string} rated {string}", async function (label, ratingText) {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.css(`[data-testid='skill-rating-${label}']`)),
    10_000,
    `rating chip for "${label}" not found`,
  );
  const text = await chip.getText();
  assert.ok(text.includes(ratingText), `"${label}" rating chip does not show "${ratingText}" (got: ${text})`);
});

Then("my skill map shows {string} rated {string}", async function (label, ratingText) {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.css(`[data-testid='skill-rating-${label}']`)),
    10_000,
    `rating chip for "${label}" not found in settings`,
  );
  const text = await chip.getText();
  assert.ok(text.includes(ratingText), `"${label}" does not show "${ratingText}" (got: ${text})`);
});

Then("my skill map shows no rating form", async function () {
  const driver = await this.getDriver();
  const forms = await driver.findElements(By.css("[data-testid='skill-rate-form']"));
  assert.strictEqual(forms.length, 0, "the read-only mount must not render the rating form");
});
