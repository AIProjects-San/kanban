// Steps for the RBAC feature.

const { Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

Then("the {string} button should be visible", async function (label) {
  const driver = await this.getDriver();
  // Poll until a displayed match exists — the button may mount a beat after
  // the view heading (data fetch, permission hydration).
  await driver.wait(
    async () => {
      const buttons = await driver.findElements(By.xpath(`//button[contains(., "${label}")]`));
      for (const b of buttons) {
        if (await b.isDisplayed()) return true;
      }
      return false;
    },
    10_000,
    `button "${label}" should be visible but is not`,
  );
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
