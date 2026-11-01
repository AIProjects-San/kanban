// Steps for the task board feature.

const { When, Then } = require("@cucumber/cucumber");
const { By, Key, until, Actions } = require("selenium-webdriver");
const assert = require("node:assert");

const VIEW_BUTTON = (label) =>
  By.xpath(`//nav//button[contains(., "${label}")] | //nav//a[contains(., "${label}")]`);

// View headings to anchor the "view has actually swapped" wait — the h1 of
// each view (see src/components/views/*.tsx). Dashboard's h1 is a greeting,
// so it only waits for any h1.
const VIEW_HEADINGS = {
  Tasks: "Tasks",
  Projects: "Projects",
  Team: "Team",
  Analytics: "Analytics",
  Calendar: "Calendar",
};

When("I open the {string} view", async function (label) {
  const driver = await this.getDriver();
  // Prefer the keyboard shortcut route (G D / G T / …) — stable across UI restyles.
  // Keys must mirror the app's shortcut map (src/hooks/use-keyboard-shortcuts.ts
  // + sidebar.tsx): d/t/p/c/a/m/b. Note Team is "m" (G M), not "e".
  const shortcuts = { Dashboard: "d", Tasks: "t", Projects: "p", Team: "m", Analytics: "a", Calendar: "c", Bugs: "b" };
  if (shortcuts[label]) {
    const body = await driver.findElement(By.css("body"));
    await body.sendKeys("g", shortcuts[label]);
  } else {
    await driver.findElement(VIEW_BUTTON(label)).click();
  }
  // Wait until the target view's heading is rendered — a blind sleep let
  // assertions run against the PREVIOUS view during slow dev-compile loads.
  const expected = VIEW_HEADINGS[label];
  await driver.wait(
    async () => {
      const headings = await driver.findElements(By.css("main h1"));
      if (headings.length === 0) return false;
      if (!expected) return true; // Dashboard — greeting text varies
      const text = await headings[0].getText();
      return text.includes(expected);
    },
    15_000,
    `view "${label}" did not render its heading`,
  );
  await driver.sleep(250); // let the SPA content below the heading settle
});

When("I create a task titled {string}", async function (title) {
  const driver = await this.getDriver();
  const newTaskButton = await driver.wait(
    until.elementLocated(By.xpath("//button[contains(., 'New Task') or contains(., 'Add Task')]")),
    10_000,
  );
  await newTaskButton.click();
  const titleInput = await driver.wait(
    until.elementLocated(By.css('input[placeholder*="itle" i], form input[type="text"]')),
    10_000,
  );
  await titleInput.sendKeys(title);
  // Submit the modal's primary action.
  await driver.findElement(By.xpath("//form//button[contains(., 'Create')]")).click();
  await driver.sleep(700);
});

Then("a task named {string} should appear on the board", async function (title) {
  const driver = await this.getDriver();
  const card = await driver.findElements(By.xpath(`//*[contains(text(), "${title}")]`));
  assert.ok(card.length > 0, `task "${title}" not found on the board`);
});

When("I move the task {string} to the {string} column", async function (title, column) {
  const driver = await this.getDriver();
  const card = await driver.wait(
    until.elementLocated(By.xpath(`//*[contains(text(), "${title}")]`)),
    10_000,
  );
  const target = await driver.findElement(
    By.xpath(`//*[contains(@class,'column') or contains(@data-testid,'column')][.//*[contains(text(), "${column}")]]`),
  );
  await new Actions(driver).dragAndDrop(card, target).perform();
  await driver.sleep(700);
});

Then("the task {string} should be in the {string} column", async function (title, column) {
  const driver = await this.getDriver();
  const columnEl = await driver.findElement(
    By.xpath(`//*[contains(@class,'column') or contains(@data-testid,'column')][.//*[contains(text(), "${column}")]]`),
  );
  const contains = await columnEl.findElements(By.xpath(`.//*[contains(text(), "${title}")]`));
  assert.ok(contains.length > 0, `task "${title}" is not in the "${column}" column`);
});

When("I delete the task {string}", async function (title) {
  const driver = await this.getDriver();
  const card = await driver.findElement(By.xpath(`//*[contains(text(), "${title}")]`));
  await card.click(); // opens the edit modal
  const deleteBtn = await driver.wait(
    until.elementLocated(By.xpath("//button[contains(., 'Delete')]")),
    10_000,
  );
  await deleteBtn.click();
  // Confirm if a confirmation dialog appears.
  const confirm = await driver.findElements(By.xpath("//button[contains(., 'Confirm') or contains(., 'Delete')]"));
  if (confirm.length > 0) await confirm[confirm.length - 1].click();
  await driver.sleep(700);
});

Then("no task named {string} should remain on the board", async function (title) {
  const driver = await this.getDriver();
  const remaining = await driver.findElements(By.xpath(`//*[contains(text(), "${title}")]`));
  assert.strictEqual(remaining.length, 0, `task "${title}" still exists`);
});
