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

// P35 (EM-12/EM-B06/EM-11) — template-depth steps: the derived status chip,
// the required-open counter, the role-scoped assignee label, the
// holiday-aware due dates, and the pinned start date.

Then("the onboarding checklist {string} should show the status {string}", async function (title, status) {
  const card = await checklistCard(this, title);
  const chip = await card.findElement(
    By.xpath(`.//*[contains(@class, "rounded")][contains(text(), ${JSON.stringify(status)})]`),
  );
  const text = await chip.getText();
  assert.ok(
    text.includes(status),
    `checklist "${title}" status chip does not contain "${status}" (got: ${text})`,
  );
});

Then("the onboarding checklist {string} should show {int} required task open", async function (title, count) {
  const card = await checklistCard(this, title);
  const text = await card.getText();
  const match = text.match(/(\d+) required open/);
  assert.ok(
    match && Number(match[1]) === count,
    `checklist "${title}" does not show ${count} required open (got: ${match ? match[1] : "none"})`,
  );
});

async function taskRow(world, title, cardTitle) {
  const driver = await world.getDriver();
  const card = await checklistCard(world, cardTitle);
  return driver.wait(
    until.elementLocated(
      By.xpath(`//div[@data-testid='checklist-${cardTitle}']//div[.//button[@data-testid='task-${title}']]`),
    ),
    10_000,
    `task "${title}" not found on checklist "${cardTitle}"`,
  ).then(() => card.findElement(By.xpath(`.//div[.//button[@data-testid='task-${title}']]`)));
}

Then("the onboarding task {string} should show {string} as its assignee", async function (title, assignee) {
  const row = await taskRow(this, title, "Nov 2026 onboarding — Diego");
  const text = await row.getText();
  assert.ok(text.includes(assignee), `task "${title}" does not show assignee "${assignee}" (got: ${text})`);
});

Then("the onboarding task {string} should be due on {string}", async function (title, due) {
  const row = await taskRow(this, title, "Nov 2026 onboarding — Diego");
  const text = await row.getText();
  assert.ok(text.includes(due), `task "${title}" is not due ${due} (got: ${text})`);
});

Then("the onboarding task {string} on {string} should be due on {string}", async function (title, cardTitle, due) {
  const row = await taskRow(this, title, cardTitle);
  const text = await row.getText();
  assert.ok(text.includes(due), `task "${title}" on "${cardTitle}" is not due ${due} (got: ${text})`);
});

Then("the template task {string} should show {string} in its chip", async function (title, chipText) {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.xpath(`//span[@data-testid='template-chip-${title}']`)),
    10_000,
    `template chip for "${title}" not found`,
  );
  const text = await chip.getText();
  assert.ok(
    text.includes(chipText),
    `template chip for "${title}" does not contain "${chipText}" (got: ${text})`,
  );
});

When("I start onboarding for {string} titled {string} starting {string}", async function (hire, title, startDate) {
  const driver = await this.getDriver();
  await driver.findElement(By.xpath(`//button[contains(., "New Checklist")]`)).click();
  const modal = await driver.wait(
    until.elementLocated(By.xpath(`//div[@role='dialog']`)),
    10_000,
    "create-checklist modal did not open",
  );
  const select = await modal.findElement(By.xpath(`.//select`));
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
  const titleInput = await modal.findElement(By.xpath(`.//input[@type='text' or not(@type)]`));
  await titleInput.clear();
  await titleInput.sendKeys(title);
  const dateInput = await modal.findElement(By.xpath(`.//input[@data-testid='checklist-start-date' or @type='date']`));
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    dateInput, startDate,
  );
  await driver.findElement(By.xpath(`//div[@role='dialog']//button[contains(., "Create checklist")]`)).click();
  await driver.sleep(1_500);
});
