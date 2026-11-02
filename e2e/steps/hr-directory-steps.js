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
  throw new Error(`unknown tab: ${label}`);
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

When("I set my employee profile job title to {string}", async function (title) {
  const driver = await this.getDriver();
  // The Settings view's employee-profile card: its first text input after
  // the "Employee profile" heading is the job title.
  const section = await driver.wait(
    until.elementLocated(
      By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "Employee profile")]]`),
    ),
    10_000,
    "employee profile section not found in settings",
  );
  const jobInput = await section.findElement(By.xpath(`.//input[1]`));
  await jobInput.clear();
  await jobInput.sendKeys(title);
  const save = await section.findElement(By.xpath(`.//button[contains(., "Save employee profile")]`));
  await save.click();
  await driver.sleep(1_200);
});

Then("my employee profile should show job title {string}", async function (title) {
  const driver = await this.getDriver();
  const section = await driver.findElement(
    By.xpath(`//div[contains(@class, "f-card")][.//h2[contains(text(), "Employee profile")]]`),
  );
  const jobInput = await section.findElement(By.xpath(`.//input[1]`));
  assert.strictEqual(await jobInput.getAttribute("value"), title, "self-service job title did not persist");
});
