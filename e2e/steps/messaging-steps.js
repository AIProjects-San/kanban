// Steps for the messaging feature.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

When("I send a message with subject {string} to {string}", async function (subject, recipientEmail) {
  const driver = await this.getDriver();
  // Open the first team member row's message action.
  const messageButton = await driver.wait(
    until.elementLocated(
      By.xpath("//button[@aria-label[contains(.,'Message')]] | //button[contains(., 'Message')]"),
    ),
    10_000,
  );
  await messageButton.click();
  const subjectInput = await driver.wait(
    until.elementLocated(By.css('input[placeholder*="ubject" i], input[name="subject"]')),
    10_000,
  );
  await subjectInput.sendKeys(subject);
  const bodyArea = await driver.findElement(By.css("textarea"));
  await bodyArea.sendKeys("Sent from the Selenium suite.");
  await driver.findElement(By.xpath("//button[contains(., 'Send')]")).click();
  await driver.sleep(800);
});

Then("I should see a confirmation that the message was sent", async function () {
  const driver = await this.getDriver();
  const toast = await driver.findElements(
    By.xpath("//*[contains(., 'sent') or contains(., 'Sent')]"),
  );
  assert.ok(toast.length > 0, "no sent confirmation was shown");
});

When("I open my inbox", async function () {
  const driver = await this.getDriver();
  const inboxButton = await driver.wait(
    until.elementLocated(
      By.xpath("//button[@aria-label[contains(.,'Inbox')]] | //button[contains(., 'Inbox')]"),
    ),
    10_000,
  );
  await inboxButton.click();
  await driver.sleep(500);
});

Then("my inbox should contain a message with subject {string}", async function (subject) {
  const driver = await this.getDriver();
  const found = await driver.findElements(By.xpath(`//*[contains(text(), "${subject}")]`));
  assert.ok(found.length > 0, `inbox does not contain "${subject}"`);
});

Then("my inbox should not contain a message with subject {string}", async function (subject) {
  const driver = await this.getDriver();
  const found = await driver.findElements(By.xpath(`//*[contains(text(), "${subject}")]`));
  assert.strictEqual(found.length, 0, `inbox unexpectedly contains "${subject}"`);
});
