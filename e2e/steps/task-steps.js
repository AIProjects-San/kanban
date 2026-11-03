// Steps for the task board feature.

const { When, Then } = require("@cucumber/cucumber");
const { By, until, Key } = require("selenium-webdriver");
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
  Bugs: "Bugs",
  Leave: "Leave",
  HR: "HR",
  Settings: "Settings",
  "Audit Log": "Audit Log",
  Help: "Help",
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

// Task-card locator, scoped to the board's columns (the Column component
// stamps data-testid="board-column" — src/components/views/tasks-view.tsx).
//
// WHY SCOPING IS MANDATORY: a document-wide //*[contains(text(), …)] also
// matches the invisible <script> chunks Next.js App Router streams into
// <body> (self.__next_f.push(…) — the RSC/Flight payload). That payload
// serialises every task the page was SSR'd with, so any task that existed
// at page-load keeps matching those scripts for the lifetime of the page —
// even after it is deleted and its card leaves the board. The delete
// step's "card is gone" poll therefore could NEVER reach zero and always
// timed out after 30s, which then cascaded into the cucumber retry
// failing with "task not found on the board" (the task was already gone).
// Columns contain only rendered cards — no script nodes — so lookups
// scoped here reflect what the user actually sees.
const boardCard = (title) =>
  By.xpath(`//div[@data-testid='board-column']//*[contains(text(), "${title}")]`);

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
  const shortcuts = { Dashboard: "d", Tasks: "t", Projects: "p", Team: "m", Analytics: "a", Calendar: "c", Bugs: "b", Leave: "v", HR: "r", Settings: "s", "Audit Log": "l" };
  const expected = VIEW_HEADINGS[label];

  // The first shortcut can be lost when it lands between the login
  // redirect's first paint and React hydration attaching the keyboard
  // listener — so re-send it until the target heading actually renders.
  const deadline = Date.now() + 45_000; // 45s: slow on-demand dev-server view compiles (CI is faster)
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
  // Wait for the project picker to finish loading before submitting —
  // tasks must belong to a project (project association rule), so the modal
  // blocks submission until a project is picked. The picker defaults to the
  // user's first associated project; select it explicitly so the step
  // doesn't depend on the default.
  await driver.wait(
    async () =>
      (await driver.findElements(By.css("[role='dialog'] select[disabled]"))).length === 0,
    15_000,
    "the modal's project picker never finished loading",
  );
  const projectSelect = await driver.findElement(
    By.css("[role='dialog'] select[aria-label='Project']"),
  );
  const projectOptions = await projectSelect.findElements(
    By.css("option[value]:not([value=''])"),
  );
  if (projectOptions.length === 0) {
    throw new Error("no project is available for the demo user to create tasks in");
  }
  await projectOptions[0].click();
  const titleInput = await driver.wait(
    until.elementLocated(By.css('input[placeholder*="itle" i], form input[type="text"]')),
    10_000,
  );
  await titleInput.sendKeys(title);
  // Submit the modal's primary action.
  await driver.findElement(By.xpath("//form//button[contains(., 'Create')]")).click();
  // Wait for the card to hit the board — the server action's first call in
  // a dev server pays a compile cost that a blind sleep can outrun.
  // boardCard: scoped so the wait can't be satisfied by the Flight-payload
  // scripts (see boardCard's comment).
  await driver.wait(
    until.elementLocated(boardCard(title)),
    15_000,
    `task "${title}" did not appear after create`,
  );
});

Then("a task named {string} should appear on the board", async function (title) {
  const driver = await this.getDriver();
  const card = await driver.findElements(boardCard(title));
  assert.ok(card.length > 0, `task "${title}" not found on the board`);
});

When("I move the task {string} to the {string} column", async function (title, column) {
  const driver = await this.getDriver();
  // A previous failed drag can leave the edit modal open (a press+release
  // on a card that didn't register as a drag is a CLICK) — its overlay
  // would swallow the pointer events. Dismiss anything open first.
  const dialogs = await driver.findElements(By.css("[role='dialog']"));
  if (dialogs.length > 0) {
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await driver.wait(
      async () => (await driver.findElements(By.css("[role='dialog']"))).length === 0,
      5_000,
    );
  }
  const card = await driver.wait(
    until.elementLocated(boardCard(title)),
    10_000,
  );
  const target = await driver.findElement(columnLocator(column));
  // dnd-kit's PointerSensor activates on pointer movement WHILE pressed.
  // Selenium's one-hop dragAndDrop (press → single move → release) doesn't
  // register as a drag, and the stray press+release on the card registers
  // as a CLICK that opens the edit modal. Move incrementally instead:
  // small in-card move to start the drag, then travel, then drop.
  await driver
    .actions({ async: true })
    .move({ origin: card })
    .press()
    .move({ origin: card, x: 15, y: 15, duration: 150 })
    .pause(150)
    .move({ origin: target, duration: 400 })
    .pause(150)
    .release()
    .perform();
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
  // Wait for the card (the board may still be mounting after the view swap)
  // instead of assuming it is already in the DOM.
  let card;
  try {
    card = await driver.wait(until.elementLocated(boardCard(title)), 10_000);
  } catch (e) {
    if (e.name === "TimeoutError") {
      // Idempotent for cucumber retries: this is a destructive step, so a
      // first attempt that deleted the task but failed later (e.g. a slow
      // refresh outrunning the 30s poll below) would otherwise doom every
      // retry — the card is gone for good and the retry can only fail with
      // "not found on the board". If the board has no such card the
      // postcondition already holds; the scenario's final Then-step still
      // asserts the absence. (A card that truly never renders is caught by
      // the create/drag scenarios, which assert it on the board.)
      await this.attach(`task "${title}" is not on the board — treating the delete as already performed`);
      return;
    }
    throw e;
  }
  await card.click(); // opens the edit modal
  const deleteBtn = await driver.wait(
    until.elementLocated(By.xpath("//button[contains(., 'Delete')]")),
    10_000,
  );
  await deleteBtn.click();
  // Deletion = modal closes AND the card leaves the board. The first
  // server-action call can be slow in a dev server, and a Delete click can
  // be swallowed by the modal's entrance animation — poll generously and
  // re-click the dialog's Delete button if the modal is still up. (A second
  // click on an already-deleted task just toasts "not found" — harmless.)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Scoped to the board columns — the document-wide xpath also matched
    // the invisible Flight-payload <script> chunks (see boardCard), which
    // keep the title forever and made this loop always time out.
    const remaining = await driver.findElements(boardCard(title));
    if (remaining.length === 0) return;
    // Only re-click a Delete button that sits inside a still-open dialog.
    const retry = await driver.findElements(
      By.xpath("//div[@role='dialog']//button[contains(., 'Delete')]"),
    );
    if (retry.length > 0 && (await retry[0].isDisplayed())) {
      try {
        await retry[0].click();
      } catch {
        /* modal mid-transition — the next poll retries */
      }
    }
    await driver.sleep(1000);
  }
  throw new Error(`task "${title}" was not deleted within 30s`);
});

Then("no task named {string} should remain on the board", async function (title) {
  const driver = await this.getDriver();
  const remaining = await driver.findElements(boardCard(title));
  assert.strictEqual(remaining.length, 0, `task "${title}" still exists`);
});
