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
  const seen = [];
  for (const btn of messageButtons) {
    await btn.click();
    // Wait for the recipient line — it only exists inside an open message
    // modal, so this can't match a stale/wrong dialog.
    const recipientEl = await driver.wait(
      until.elementLocated(By.css("[data-testid='message-recipient']")),
      10_000,
    );
    const recipient = (await recipientEl.getText()).trim();
    seen.push(recipient);
    if (recipient !== recipientEmail) {
      // Close and WAIT for the modal to fully unmount — clicking the next
      // card's button while the overlay is still tearing down swallows it.
      await driver.findElement(By.css("[role='dialog'] button[aria-label='Close']")).click();
      await driver.wait(
        async () =>
          (await driver.findElements(By.css("[data-testid='message-recipient']"))).length === 0,
        5_000,
      );
      continue;
    }
    const subjectInput = await driver.findElement(
      By.css('input[name="subject"], input[placeholder*="ubject" i]'),
    );
    await subjectInput.sendKeys(subject);
    const bodyArea = await driver.findElement(By.css("[role='dialog'] textarea"));
    await bodyArea.sendKeys("Sent from the Selenium suite.");
    await driver
      .findElement(By.xpath("//div[@role='dialog']//button[contains(., 'Send')]"))
      .click();
    sent = true;
    break;
  }
  assert.ok(
    sent,
    `no member card matched recipient "${recipientEmail}" — saw: ${seen.join(", ") || "(none)"}`,
  );
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
