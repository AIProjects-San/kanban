// Steps for the task board feature.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
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

// Kanban column labels -> the data-status the app stamps on each column
// (src/lib/config.ts TASK_STATUSES). Text-based column matching can pick
// the wrong column when a card's text contains the label.
const COLUMN_STATUS = {
  "To do": "TODO",
  "In progress": "IN_PROGRESS",
  "In review": "IN_REVIEW",
  Done: "DONE",
};

const columnLocator = (label) =>
  COLUMN_STATUS[label]
    ? By.css(`[data-status='${COLUMN_STATUS[label]}']`)
    : By.xpath(
        `//*[contains(@class,'column') or contains(@data-testid,'column')][.//*[contains(text(), "${label}")]]`,
      );

async function headingPresent(driver, expected) {
  const headings = await driver.findElements(By.css("main h1"));
  if (headings.length === 0) return false;
  if (!expected) return true; // Dashboard — greeting text varies
  const text = await headings[0].getText();
  return text.includes(expected);
}

When("I open the {string} view", async function (label) {
  const driver = await this.getDriver();
  // Prefer the keyboard shortcut route (G D / G T / …) — stable across UI
  // restyles. Keys must mirror the app's shortcut map
  // (src/hooks/use-keyboard-shortcuts.ts + sidebar.tsx): d/t/p/c/a/m/b.
  // Note Team is "m" (G M), not "e".
  const shortcuts = { Dashboard: "d", Tasks: "t", Projects: "p", Team: "m", Analytics: "a", Calendar: "c", Bugs: "b" };
  const expected = VIEW_HEADINGS[label];

  // The first shortcut can be lost when it lands between the login
  // redirect's first paint and React hydration attaching the keyboard
  // listener — so re-send it until the target heading actually renders.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await headingPresent(driver, expected)) {
      await driver.sleep(250); // let the content below the heading settle
      return;
    }
    if (shortcuts[label]) {
      const body = await driver.findElement(By.css("body"));
      await body.sendKeys("g", shortcuts[label]);
    } else {
      const buttons = await driver.findElements(VIEW_BUTTON(label));
      if (buttons.length > 0) await buttons[0].click();
    }
    await driver.sleep(1000);
  }
  throw new Error(`view "${label}" did not render its heading`);
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
  // Wait for the card to hit the board — the server action's first call in
  // a dev server pays a compile cost that a blind sleep can outrun.
  await driver.wait(
    until.elementLocated(By.xpath(`//*[contains(text(), "${title}")]`)),
    15_000,
    `task "${title}" did not appear after create`,
  );
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
  const target = await driver.findElement(columnLocator(column));
  // selenium-webdriver 4.x: the action builder comes from driver.actions()
  // — there is no exported Actions constructor anymore.
  await driver.actions({ async: true }).dragAndDrop(card, target).perform();
  await driver.sleep(700);
});

Then("the task {string} should be in the {string} column", async function (title, column) {
  const driver = await this.getDriver();
  const columnEl = await driver.findElement(columnLocator(column));
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
  // Wait for the deletion to actually re-render the board (the modal closes
  // and the card disappears) instead of a blind sleep — dev-server server
  // actions can be slow on first call.
  await driver.wait(
    async () =>
      (await driver.findElements(By.xpath(`//*[contains(text(), "${title}")]`))).length === 0,
    15_000,
    `task "${title}" was not deleted`,
  );
});

Then("no task named {string} should remain on the board", async function (title) {
  const driver = await this.getDriver();
  const remaining = await driver.findElements(By.xpath(`//*[contains(text(), "${title}")]`));
  assert.strictEqual(remaining.length, 0, `task "${title}" still exists`);
});
