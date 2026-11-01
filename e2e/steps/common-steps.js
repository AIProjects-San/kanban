// Step definitions shared by all features — navigation, login, and generic
// UI assertions. Selectors intentionally use accessible roles/text first so
// the suite survives styling changes.

const { Given, When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

// Secret hygiene (docs/SECURITY.md): the demo password's only home is .env
// (NEXT_PUBLIC_DEMO_PASSWORD). Cucumber does not load .env itself, so the
// helper below parses it. Feature files say "with the demo password" —
// they must never contain the literal credential.
const fs = require("node:fs");
const path = require("node:path");

function loadDemoPassword() {
  if (process.env.NEXT_PUBLIC_DEMO_PASSWORD) return process.env.NEXT_PUBLIC_DEMO_PASSWORD;
  const envPath = path.join(__dirname, "..", "..", ".env");
  try {
    const line = fs
      .readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("NEXT_PUBLIC_DEMO_PASSWORD="));
    const value = line ? line.slice("NEXT_PUBLIC_DEMO_PASSWORD=".length).trim() : "";
    if (value) return value;
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    "e2e: NEXT_PUBLIC_DEMO_PASSWORD is not set — add it to .env " +
      "(see .env.example) or export it before `bun run test:e2e`.",
  );
}

const DEMO_PASSWORD = loadDemoPassword();

const CREDENTIALS = {
  "demo@fernly.app": DEMO_PASSWORD,
  "manager@fernly.app": DEMO_PASSWORD,
  "member@fernly.app": DEMO_PASSWORD,
};

Given("the app is running", async function () {
  const driver = await this.getDriver();
  await driver.get(this.baseUrl);
  // Either the login screen or the dashboard renders — the app booted.
  // 30s: the first load in a dev server pays the on-demand compile cost.
  await driver.wait(
    until.elementLocated(By.css('input[type="email"], nav')),
    30_000,
    "app did not boot",
  );
});

When("I sign in as {string} with the demo password", async function (email) {
  this.lastEmail = email;
  await this.login(email, DEMO_PASSWORD);
});

When("I sign in as {string} with the correct password", async function (email) {
  this.lastEmail = email;
  await this.login(email, CREDENTIALS[email]);
});

// Explicit-password variant — used by the rejected-login scenarios (wrong
// password, unknown email, empty credentials) where the credential must NOT
// be the demo password.
When("I sign in as {string} with password {string}", async function (email, password) {
  this.lastEmail = email;
  await this.login(email, password);
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
  // Wait — the sidebar renders role-gated items only after the session
  // hydrates, so an immediate check races the first paint.
  await driver.wait(
    until.elementsLocated(By.xpath(`//nav//*[contains(text(), "${label}")]`)),
    10_000,
    `sidebar does not contain "${label}"`,
  );
});

Then("the sidebar should not contain {string}", async function (label) {
  const driver = await this.getDriver();
  // Wait for the sidebar's always-present items first — checking for an
  // absence while the nav is still mounting passes vacuously.
  await driver.wait(
    until.elementsLocated(By.xpath('//nav//*[contains(text(), "Dashboard")]')),
    10_000,
    "sidebar did not render its base navigation",
  );
  const items = await driver.findElements(By.xpath(`//nav//*[contains(text(), "${label}")]`));
  assert.strictEqual(items.length, 0, `sidebar unexpectedly contains "${label}"`);
});

Then("the project count should be lower than the admin count", async function () {
  // Admin sees every project; the member's count must be strictly smaller.
  // Counted in the Projects view — the dashboard caps its "Current
  // Projects" list at 5 for everyone, which makes dashboard counts useless
  // for scoping assertions. The seed allocates each user 2-5 of the 24
  // projects, so a member can never equal the admin's 24.
  const driver = await this.getDriver();
  const openProjectsView = async () => {
    const body = await driver.findElement(By.css("body"));
    await body.sendKeys("g", "p");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(await headingPresent(driver, "Projects"))) {
      await driver.sleep(1000);
      await body.sendKeys("g", "p");
    }
    // Navigation MUST have happened — otherwise we'd silently count the
    // dashboard's capped card list and "prove" scoping with equal counts.
    if (!(await headingPresent(driver, "Projects"))) {
      throw new Error("Projects view did not render — cannot count cards there");
    }
    await driver.wait(
      until.elementsLocated(By.css("[data-testid='project-card']")),
      10_000,
      "no project cards rendered",
    );
  };
  await openProjectsView();
  const memberCount = (await driver.findElements(By.css("[data-testid='project-card']"))).length;
  await this.logout();
  await this.login("demo@fernly.app", DEMO_PASSWORD);
  await openProjectsView();
  const adminCount = (await driver.findElements(By.css("[data-testid='project-card']"))).length;
  assert.ok(
    memberCount < adminCount,
    `member saw ${memberCount} projects, admin saw ${adminCount} — scoping may be broken`,
  );
});

// Shared with the project-count step above.
async function headingPresent(driver, expected) {
  const headings = await driver.findElements(By.css("main h1"));
  if (headings.length === 0) return false;
  const text = await headings[0].getText();
  return text.includes(expected);
}
