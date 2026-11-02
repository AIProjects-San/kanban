// Steps for the HR onboarding feature (e2e/features/hr-onboarding.feature).

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

async function checklistCard(world, title) {
  const driver = await world.getDriver();
  return driver.wait(
    until.elementLocated(By.xpath(`//div[@data-testid='checklist-${title}']`)),
    10_000,
    `onboarding checklist "${title}" not found`,
  );
}

Then("the onboarding checklist {string} should show {int} of {int} tasks done", async function (title, done, total) {
  const card = await checklistCard(this, title);
  const text = await card.getText();
  assert.ok(
    text.includes(`${done}/${total} tasks`),
    `checklist "${title}" does not show ${done}/${total} tasks (got: ${text.split("\n").slice(0, 3).join(" | ")})`,
  );
});

When("I start onboarding for {string} titled {string}", async function (hire, title) {
  const driver = await this.getDriver();
  await driver.findElement(By.xpath(`//button[contains(., "New Checklist")]`)).click();
  const select = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role='dialog']//select`)),
    10_000,
    "create-checklist modal did not open",
  );
  const hireValue = await driver.executeScript(
    `const el = arguments[0];
     return Array.from(el.options).find(o => o.textContent.includes(arguments[1]))?.value ?? "";`,
    select, hire,
  );
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    select, hireValue,
  );
  const titleInput = await driver.findElement(By.xpath(`//div[@role='dialog']//input`));
  await titleInput.clear();
  await titleInput.sendKeys(title);
  await driver.findElement(By.xpath(`//div[@role='dialog']//button[contains(., "Create checklist")]`)).click();
  await driver.sleep(1_500);
});

When("I add the task {string} to {string}", async function (task, checklistTitle) {
  const driver = await this.getDriver();
  const card = await checklistCard(this, checklistTitle);
  await card.findElement(By.xpath(`.//button[contains(@aria-label, "Add task")]`)).click();
  const input = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role='dialog']//input`)),
    10_000,
    "add-task modal did not open",
  );
  await input.clear();
  await input.sendKeys(task);
  await driver.findElement(By.xpath(`//div[@role='dialog']//button[contains(., "Add task")]`)).click();
  await driver.sleep(1_500);
});

// ---------------------------------------------------------------------------
// Self-service (Settings view)
// ---------------------------------------------------------------------------

Then("my onboarding list should show no tasks", async function () {
  const driver = await this.getDriver();
  const section = await driver.wait(
    until.elementLocated(
      By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "My onboarding")]]`),
    ),
    10_000,
    "My onboarding section not found in settings",
  );
  const text = await section.getText();
  assert.ok(
    /No onboarding checklists involve you/.test(text),
    "expected the empty state, got: " + text.split("\n").slice(0, 4).join(" | "),
  );
});

Then("my onboarding list should show {int} remaining tasks", async function (count) {
  const driver = await this.getDriver();
  const section = await driver.wait(
    until.elementLocated(
      By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "My onboarding")]]`),
    ),
    10_000,
    "My onboarding section not found in settings",
  );
  await driver.wait(
    async () => {
      const buttons = await section.findElements(By.xpath(`.//button[contains(@data-testid, "task-")]`));
      return buttons.length === count;
    },
    10_000,
    `own onboarding tasks never settled at ${count}`,
  );
});

When("I complete my onboarding task {string}", async function (task) {
  const driver = await this.getDriver();
  const section = await driver.wait(
    until.elementLocated(
      By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "My onboarding")]]`),
    ),
    10_000,
    "My onboarding section not found in settings",
  );
  const button = await driver.wait(
    until.elementLocated(By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "My onboarding")]]//button[@data-testid='task-${task}']`)),
    10_000,
    `onboarding task "${task}" button not found`,
  );
  await button.click();
  await driver.sleep(1_500);
});

Then("my onboarding checklist {string} should be complete", async function (title) {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      // After completion the checklist leaves the self-service list (no
      // remaining tasks) — verify via the empty/all-done state.
      const section = await driver.findElements(
        By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "My onboarding")]]`),
      );
      if (section.length === 0) return false;
      const text = await section[0].getText();
      return /All your onboarding tasks are done/.test(text) || !text.includes(title);
    },
    10_000,
    `checklist "${title}" never completed`,
  );
});
