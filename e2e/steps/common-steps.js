// Step definitions shared by all features — navigation, login, and generic
// UI assertions. Selectors intentionally use accessible roles/text first so
// the suite survives styling changes.

const { Given, When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

const CREDENTIALS = {
  "demo@fernly.app": "fernly123",
  "manager@fernly.app": "fernly123",
  "member@fernly.app": "fernly123",
};

Given("the app is running", async function () {
  const driver = await this.getDriver();
  await driver.get(this.baseUrl);
  // Either the login screen or the dashboard renders — the app booted.
  await driver.wait(
    until.elementLocated(By.css('input[type="email"], nav')),
    20_000,
    "app did not boot",
  );
});

When("I sign in as {string} with password {string}", async function (email, password) {
  this.lastEmail = email;
  await this.login(email, password);
});

When("I sign in as {string} with the correct password", async function (email) {
  this.lastEmail = email;
  await this.login(email, CREDENTIALS[email]);
});

When("I fail to sign in as {string} {int} times", async function (email, times) {
  for (let i = 0; i < times; i++) {
    await this.login(email, "definitely-wrong");
    await this.logout();
  }
});

Then("I should see the dashboard within {int} seconds", async function (seconds) {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css("main, [data-testid='app-shell']")), seconds * 1000);
});

Then("I should still be on the login screen", async function () {
  const driver = await this.getDriver();
  const emailField = await driver.findElements(By.css('input[type="email"]'));
  assert.ok(emailField.length > 0, "expected the login screen to still be visible");
});

Then("I should not see the dashboard", async function () {
  const driver = await this.getDriver();
  const nav = await driver.findElements(By.css("nav"));
  assert.strictEqual(nav.length, 0, "did not expect the app shell to be mounted");
});

Then("the sidebar should contain {string}", async function (label) {
  const driver = await this.getDriver();
  const items = await driver.findElements(By.xpath(`//nav//*[contains(text(), "${label}")]`));
  assert.ok(items.length > 0, `sidebar does not contain "${label}"`);
});

Then("the sidebar should not contain {string}", async function (label) {
  const driver = await this.getDriver();
  const items = await driver.findElements(By.xpath(`//nav//*[contains(text(), "${label}")]`));
  assert.strictEqual(items.length, 0, `sidebar unexpectedly contains "${label}"`);
});

Then("the dashboard project count should be lower than the admin count", async function () {
  // Admin sees every project; the member's count must be strictly smaller.
  const driver = await this.getDriver();
  await driver.wait(until.elementsLocated(By.css("[data-testid='project-card'], article")), 10_000);
  const memberCount = (await driver.findElements(By.css("[data-testid='project-card'], article"))).length;
  await this.logout();
  await this.login("demo@fernly.app", "fernly123");
  const adminCount = (await driver.findElements(By.css("[data-testid='project-card'], article"))).length;
  assert.ok(
    memberCount < adminCount,
    `member saw ${memberCount} projects, admin saw ${adminCount} — scoping may be broken`,
  );
});
