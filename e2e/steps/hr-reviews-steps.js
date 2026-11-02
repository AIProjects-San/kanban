// Steps for the HR reviews feature (e2e/features/hr-reviews.feature).

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

// ---------------------------------------------------------------------------
// Queue assertions
// ---------------------------------------------------------------------------

const queueRow = (title) =>
  By.xpath(`//table//tr[@data-testid='review-row-${title}']`);

Then("the review queue should show a cycle {string} for {string} with status {string}", async function (title, employee, status) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(queueRow(title)),
    10_000,
    `review cycle "${title}" not found in the queue`,
  );
  const text = await row.getText();
  assert.ok(text.includes(employee), `cycle "${title}" is not for ${employee}`);
  assert.ok(text.includes(status), `cycle "${title}" does not show status ${status}`);
});

Then("the review queue should not show any cycle for {string}", async function (employee) {
  const driver = await this.getDriver();
  await driver.sleep(600);
  const rows = await driver.findElements(By.css("[data-testid='hr-reviews'] table tbody tr"));
  for (const row of rows) {
    const text = await row.getText();
    assert.ok(!text.includes(employee), `queue leaked a review cycle for "${employee}" outside the viewer's subtree`);
  }
});

// ---------------------------------------------------------------------------
// Employee self-service (Settings view)
// ---------------------------------------------------------------------------

async function myReviewRow(world, title) {
  const driver = await world.getDriver();
  return driver.wait(
    until.elementLocated(By.xpath(`//div[@data-testid='my-review-${title}']`)),
    10_000,
    `own review "${title}" not found in settings`,
  );
}

Then("my review {string} should show status {string}", async function (title, status) {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      const rows = await driver.findElements(By.xpath(`//div[@data-testid='my-review-${title}']`));
      if (rows.length === 0) return false;
      return (await rows[0].getText()).includes(status);
    },
    10_000,
    `own review "${title}" never showed status ${status}`,
  );
});

When("I write the self-assessment for {string} saying {string}", async function (title, text) {
  const driver = await this.getDriver();
  const row = await myReviewRow(this, title);
  await row.findElement(By.xpath(`.//button[contains(., "Write")]`)).click();
  const textarea = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role='dialog']//textarea`)),
    10_000,
    "self-assessment modal did not open",
  );
  await textarea.clear();
  await textarea.sendKeys(text);
});

When("I rate myself {int}", async function (rating) {
  const driver = await this.getDriver();
  const select = await driver.findElement(By.xpath(`//div[@role='dialog']//select`));
  await driver.executeScript(
    `const el = arguments[0], val = String(arguments[1]);
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    select, rating,
  );
});

When("I submit the self-assessment", async function () {
  const driver = await this.getDriver();
  await driver.findElement(By.xpath(`//div[@role='dialog']//button[contains(., "Save & submit")]`)).click();
  await driver.sleep(1_500);
});

Then("the self-assessment write button should be gone", async function () {
  const driver = await this.getDriver();
  await driver.sleep(500);
  const buttons = await driver.findElements(
    By.xpath(`//div[contains(@data-testid, "my-review-")]//button[contains(., "Write")]`),
  );
  assert.strictEqual(buttons.length, 0, "a submitted cycle still offers a Write button");
});

When("I acknowledge my review {string}", async function (title) {
  const driver = await this.getDriver();
  const row = await myReviewRow(this, title);
  const btn = await row.findElement(By.xpath(`.//button[contains(., "Acknowledge")]`));
  await btn.click();
  await driver.sleep(1_500);
});

// ---------------------------------------------------------------------------
// Manager decision (HR console)
// ---------------------------------------------------------------------------

When("I review {string} for {string} with comment {string} and rating {int}", async function (title, employee, comment, rating) {
  const driver = await this.getDriver();
  // Switch to the Submitted filter so the Review button is reachable.
  const row = await driver.wait(
    until.elementLocated(queueRow(title)),
    10_000,
    `review cycle "${title}" not found in the queue`,
  );
  const text = await row.getText();
  assert.ok(text.includes(employee), `cycle "${title}" is not for ${employee}`);
  await row.findElement(By.xpath(`.//button[contains(., "Review")]`)).click();
  const modal = await driver.wait(
    until.elementLocated(By.css("[data-testid='complete-review']")),
    10_000,
    "review decision modal did not open",
  );
  const textarea = await driver.findElement(By.xpath(`//div[@role='dialog']//textarea`));
  await textarea.clear();
  await textarea.sendKeys(comment);
  const select = await driver.findElement(By.xpath(`//div[@role='dialog']//select`));
  await driver.executeScript(
    `const el = arguments[0], val = String(arguments[1]);
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    select, rating,
  );
  await modal.click();
  await driver.sleep(1_500);
});
