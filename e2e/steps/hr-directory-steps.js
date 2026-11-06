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
