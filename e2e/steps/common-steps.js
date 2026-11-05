// Step definitions shared by all features — navigation, login, and generic
// UI assertions. Selectors intentionally use accessible roles/text first so
// the suite survives styling changes.

const { Given, When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

// Secret hygiene (docs/SECURITY.md): the demo password's only home is .env
// (NEXT_PUBLIC_DEMO_PASSWORD), resolved once in the shared support module
// so EVERY step that needs the credential uses the same source (CI sets
// NEXT_PUBLIC_DEMO_PASSWORD, never DEMO_PASSWORD — see
// e2e/support/demo-password.js for the regression this centralized).
const { DEMO_PASSWORD } = require("../support/demo-password.js");

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
// be the demo password. expectSuccess:false keeps the tolerant outcome for
// these (a toast IS the expected result), while every positive sign-in now
// fails fast when rejected (see world.js login()).
When("I sign in as {string} with password {string}", async function (email, password) {
  this.lastEmail = email;
  await this.login(email, password, { expectSuccess: false });
});

When("I fail to sign in as {string} {int} times", async function (email, times) {
  for (let i = 0; i < times; i++) {
    await this.login(email, "definitely-wrong", { expectSuccess: false });
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

// ---------------------------------------------------------------------------
// PR-48 — Better Auth stack (flag-on) steps. Only used by
// auth-better.feature (bun run test:e2e:better); they assert the stack-
// specific observable: the fernly.* session cookie and the UI sign-out.
// ---------------------------------------------------------------------------

Then("the fernly session cookie should be set", async function () {
  const driver = await this.getDriver();
  const cookies = await driver.manage().getCookies();
  const session = cookies.find(
    (c) => c.name === "fernly.session_token" || c.name === "__Secure-fernly.session_token",
  );
  assert.ok(session, `expected a fernly session cookie, got: ${cookies.map((c) => c.name).join(", ") || "(none)"}`);
  // httpOnly cookies are invisible to document.cookie but visible to the
  // driver's cookie manager — assert the flag while we're here.
  assert.strictEqual(session.httpOnly, true, "fernly session cookie must be httpOnly");
});

When("I sign out via the sidebar", async function () {
  const driver = await this.getDriver();
  // The sign-out button sits in the sidebar footer BELOW the <nav> block —
  // search the whole sidebar container, not just nav.
  const btn = await driver.wait(
    until.elementLocated(By.xpath('//button[.//text()[contains(., "Sign out")] or contains(., "Sign out")]')),
    10_000,
    "sign-out button did not appear",
  );
  await btn.click();
});

Then("I should see the login screen within {int} seconds", async function (seconds) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('input[type="email"]')),
    seconds * 1000,
    "login screen did not return after sign-out",
  );
});
