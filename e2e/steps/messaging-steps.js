// Steps for the messaging feature.

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

When("I send a message with subject {string} to {string}", async function (subject, recipientEmail) {
  const driver = await this.getDriver();
  // Member cards don't render the email — open each card's message modal
  // until its header shows the intended recipient, then fill and send.
  const messageButtons = await driver.wait(
    until.elementsLocated(
      By.xpath("//button[@aria-label[contains(.,'Message')]] | //button[contains(., 'Message')]"),
    ),
    10_000,
  );
  let sent = false;
  for (const btn of messageButtons) {
    await btn.click();
    const dialog = await driver.wait(
      until.elementLocated(By.css('[role="dialog"]')),
      10_000,
    );
    const recipient = await dialog
      .findElement(By.css("[data-testid='message-recipient']"))
      .getText();
    if (recipient.trim() !== recipientEmail) {
      await dialog.findElement(By.css("button[aria-label='Close']")).click();
      await driver.sleep(300); // let the modal unmount before the next card
      continue;
    }
    const subjectInput = await dialog.findElement(
      By.css('input[name="subject"], input[placeholder*="ubject" i]'),
    );
    await subjectInput.sendKeys(subject);
    const bodyArea = await dialog.findElement(By.css("textarea"));
    await bodyArea.sendKeys("Sent from the Selenium suite.");
    await dialog.findElement(By.xpath(".//button[contains(., 'Send')]")).click();
    sent = true;
    break;
  }
  assert.ok(sent, `no member card matched recipient "${recipientEmail}"`);
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
