// Steps for the RBAC feature.

const { Then } = require("@cucumber/cucumber");
const { By } = require("selenium-webdriver");
const assert = require("node:assert");

Then("the {string} button should be visible", async function (label) {
  const driver = await this.getDriver();
  const buttons = await driver.findElements(
    By.xpath(`//button[contains(., "${label}")]`),
  );
  const visible = [];
  for (const b of buttons) {
    if (await b.isDisplayed()) visible.push(b);
  }
  assert.ok(visible.length > 0, `button "${label}" should be visible but is not`);
});

Then("the {string} button should not be visible", async function (label) {
  const driver = await this.getDriver();
  const buttons = await driver.findElements(
    By.xpath(`//button[contains(., "${label}")]`),
  );
  for (const b of buttons) {
    const displayed = await b.isDisplayed();
    assert.ok(!displayed, `button "${label}" should be hidden but is visible`);
  }
});
