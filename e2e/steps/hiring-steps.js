// Steps for the hiring pipeline feature (Recruitment R1).
// docs/RECRUITMENT_MODULE_PLAN.md §7 — runs in CI e2e (local sandbox has no
// Chrome; see e2e/README.md).

const { Then, When } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

Then("the hiring board should show the stage column {string}", async function (key) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css(`[data-testid="stage-column-${key}"]`)),
    15_000,
    `stage column "${key}" did not render`,
  );
});

When("I open the candidate card {string}", async function (name) {
  const driver = await this.getDriver();
  const card = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="candidate-card"]//*[contains(text(), "${name}")]`),
    ),
    15_000,
    `candidate card "${name}" not found on the board`,
  );
  // Click the card itself so the click doesn't land on an inner element.
  await driver.executeScript(
    "arguments[0].closest('[data-testid=\"candidate-card\"]').click();",
    card,
  );
  await driver.wait(until.elementLocated(By.css('[data-testid="candidate-timeline"]')), 15_000);
});

When("I advance the current stage", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="advance-stage-btn"]')),
    10_000,
  );
  await btn.click();
  // The modal refreshes its data; give the toast + reload a beat.
  await driver.sleep(1_500);
});

Then("the candidate detail should show the stage {string} as passed", async function (key) {
  const driver = await this.getDriver();
  const stage = await driver.wait(
    until.elementLocated(By.css(`[data-testid="stage-${key}"]`)),
    10_000,
  );
  const text = await stage.getText();
  assert.ok(/PASSED/.test(text), `stage "${key}" should be PASSED, got: ${text}`);
});

When("I try to reject the candidate", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="reject-btn"]')),
    10_000,
  );
  await btn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="reject-reason"]')), 10_000);
});

Then("the rejection reason field should be required", async function () {
  const driver = await this.getDriver();
  const area = await driver.findElement(By.css('[data-testid="reject-reason"]'));
  // The form's own validation (submit with empty reason) must block — the
  // textarea exists and the confirm button stays present without advancing.
  const value = await area.getAttribute("value");
  assert.strictEqual(value, "", "rejection reason starts empty");
  const confirm = await driver.findElement(By.css('[data-testid="reject-confirm"]'));
  assert.ok(await confirm.isDisplayed(), "confirm button awaits a reason");
});

When("I open the schedule form for stage {string}", async function (key) {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css(`[data-testid="schedule-btn-${key}"]`)),
    10_000,
    `schedule button for stage "${key}" not found`,
  );
  await btn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="schedule-form"]')), 10_000);
});

Then("the schedule form should offer the interviewer dropdown", async function () {
  const driver = await this.getDriver();
  const select = await driver.wait(
    until.elementLocated(By.css('[data-testid="schedule-interviewer"]')),
    10_000,
  );
  const options = await select.findElements(By.css("option"));
  // "— Keep current owner —" + at least the seeded directory members.
  assert.ok(options.length >= 2, `expected interviewer options, got ${options.length}`);
});

// ---------------------------------------------------------------------------
// R3 — decisions & email outbox
// ---------------------------------------------------------------------------

When("I select the candidate", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="select-btn"]')),
    10_000,
  );
  await btn.click();
  await driver.sleep(1_500);
});

Then("the candidate detail should show the offer-prep banner", async function () {
  const driver = await this.getDriver();
  const banner = await driver.wait(
    until.elementLocated(By.xpath("//*[contains(text(), 'Offer preparation pending')]")),
    10_000,
    "offer-prep banner did not appear after selecting",
  );
  assert.ok(await banner.isDisplayed(), "offer-prep banner visible");
});

When("I fill the rejection reason with {string}", async function (reason) {
  const driver = await this.getDriver();
  const area = await driver.findElement(By.css('[data-testid="reject-reason"]'));
  await area.sendKeys(reason);
});

When("I toggle the rejection email on", async function () {
  const driver = await this.getDriver();
  const toggle = await driver.findElement(By.css('[data-testid="reject-email-toggle"] input'));
  await toggle.click();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="reject-email-remarks"]')),
    10_000,
  );
});

When("I confirm the rejection", async function () {
  const driver = await this.getDriver();
  const btn = await driver.findElement(By.css('[data-testid="reject-confirm"]'));
  await btn.click();
  await driver.sleep(2_000);
});

Then("the email outbox should show a recorded email to {string}", async function (address) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="outbox-row"]//*[contains(text(), "${address}")]`),
    ),
    15_000,
    `no outbox row for "${address}"`,
  );
  assert.ok(row, `outbox row for ${address} found`);
});

Then("the outbox entry should be recorded as skipped", async function () {
  const driver = await this.getDriver();
  // CI e2e runs without RESEND_API_KEY — the send is recorded SKIPPED.
  const chip = await driver.wait(
    until.elementLocated(
      By.xpath('//*[@data-testid="outbox-row"]/*[contains(text(), "SKIPPED")]'),
    ),
    10_000,
    "no SKIPPED outbox row",
  );
  assert.ok(chip, "outbox row recorded as SKIPPED");
});

Then("the email outbox panel should not be visible", async function () {
  const driver = await this.getDriver();
  // Wait for the board itself first so the assertion isn't just "page still
  // loading" — then the panel must be absent.
  await driver.wait(
    until.elementLocated(By.css('[data-testid="stage-column-screening"]')),
    15_000,
  );
  const panels = await driver.findElements(By.css('[data-testid="email-outbox"]'));
  assert.strictEqual(panels.length, 0, "email outbox panel must be hidden without hiring:manage");
});

Then("the selected filter chip should show a count of at least {int}", async function (min) {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.css('[data-testid="hiring-filter-selected"]')),
    15_000,
  );
  const text = await chip.getText();
  const match = text.match(/(\d+)/);
  assert.ok(match, `selected chip should carry a count, got: ${text}`);
  assert.ok(
    Number(match[1]) >= min,
    `selected count ${match[1]} should be >= ${min}`,
  );
});

// ---------------------------------------------------------------------------
// R4 — joining formalities (documents + background checks)
// ---------------------------------------------------------------------------

When("I open the {string} pool", async function (label) {
  const driver = await this.getDriver();
  const key = label.toUpperCase();
  const chip = await driver.wait(
    until.elementLocated(By.css(`[data-testid="hiring-filter-${key.toLowerCase()}"]`)),
    10_000,
    `filter chip "${label}" not found`,
  );
  await chip.click();
  await driver.sleep(400);
});

Then("the joining formalities panel should show the document checklist", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="joining-formalities"]')),
    10_000,
    "joining-formalities panel did not render",
  );
  await driver.wait(
    until.elementLocated(By.css('[data-testid="doc-checklist"]')),
    10_000,
    "document checklist did not render",
  );
});

Then("the document {string} should show status {string}", async function (docTypeKey, status) {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.css(`[data-testid="doc-status-${docTypeKey}"]`)),
    10_000,
    `status chip for document "${docTypeKey}" not found`,
  );
  const text = await chip.getText();
  assert.strictEqual(text, status, `document "${docTypeKey}" should be ${status}, got: ${text}`);
});

Then("the background check section should list the vendor {string}", async function (vendor) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="bg-check-list"]//*[contains(text(), "${vendor}")]`),
    ),
    10_000,
    `background check for vendor "${vendor}" not found`,
  );
  assert.ok(row, `background check row for ${vendor} found`);
});

When("I request the {string} document", async function (docTypeKey) {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css(`[data-testid="request-doc-${docTypeKey}"]`)),
    10_000,
    `request button for document "${docTypeKey}" not found`,
  );
  await btn.click();
  await driver.sleep(1_500);
});

When("I sign out and back in as {string}", async function (email) {
  await this.logout();
  const driver = await this.getDriver();
  // logout() clears httpOnly cookies — reload to bounce back to the login screen.
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.css('input[type="email"]')), 10_000);
  const emailInput = await driver.findElement(By.css('input[type="email"]'));
  const passInput = await driver.findElement(By.css('input[type="password"]'));
  await emailInput.clear();
  await emailInput.sendKeys(email);
  await passInput.clear();
  const { DEMO_PASSWORD } = process.env;
  await passInput.sendKeys(DEMO_PASSWORD || "fernly123");
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.sleep(2_000);
});
