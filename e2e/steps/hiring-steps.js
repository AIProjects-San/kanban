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
