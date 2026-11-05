// Steps for the interviewer self-service feature (persona-audit P0-5 / D-04).
// The member side runs as member@fernly.app (Theo Vance) — the persona that
// was assignable as an interviewer but locked out of the Hiring module
// entirely before this fix. Retry-safety: scenario 1 is read-only; scenario 2
// resolves Tomas Eriksen's current pool at run time ("I open the pool
// containing" — the R3 select scenario moves him to Selected under the CI
// feature ordering, while an isolated run starts from the fresh seed), so a
// cucumber retry re-runs cleanly (scheduling again would hit the
// same-interviewer conflict guard, so the retry first closes any stale
// modal and re-opens the card).

const { When, Then } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

/** Native React-compatible value setter for inputs/selects. */
async function setNativeValue(driver, el, value) {
  await driver.executeScript(
    `const el = arguments[0], val = arguments[1];
     const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
     const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
     setter.call(el, val);
     el.dispatchEvent(new Event('input', { bubbles: true }));
     el.dispatchEvent(new Event('change', { bubbles: true }));`,
    el,
    value,
  );
}

/** Tomorrow at 10:00, formatted for a datetime-local input. */
function tomorrowTen() {
  const d = new Date(Date.now() + 24 * 60 * 60_000);
  d.setHours(10, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Shared with the hiring feature's candidate coverage — resolves which
// status pool a candidate currently lives in, so a scenario stays valid
// regardless of what EARLIER scenarios did to the candidate (CI ordering
// runs hiring.feature first; an isolated run starts from the fresh seed).
// ---------------------------------------------------------------------------
const POOL_KEYS = ["ACTIVE", "SELECTED", "REJECTED", "WITHDRAWN", "HIRED"];

When("I open the pool containing {string}", async function (name) {
  const driver = await this.getDriver();
  for (const key of POOL_KEYS) {
    const chips = await driver.findElements(
      By.css(`[data-testid="hiring-filter-${key.toLowerCase()}"]`),
    );
    if (chips.length === 0) continue;
    await chips[0].click();
    await driver.sleep(300);
    const cards = await driver.findElements(
      By.xpath(`//*[@data-testid="candidate-card"]//*[contains(text(), "${name}")]`),
    );
    if (cards.length > 0) return;
  }
  throw new Error(`candidate card "${name}" not found in any pool`);
});

Then("my interviews list should show the assignment empty state", async function () {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="my-interviews-view"]')), 15_000);
  // Wait for rows OR the empty state so the absence check can't pass
  // vacuously while the fetch is in flight.
  await driver.wait(
    until.elementLocated(
      By.css('[data-testid="my-interview-row"], [data-testid="my-interviews-empty"]'),
    ),
    15_000,
    "interviews list never rendered rows or the empty state",
  );
  const rows = await driver.findElements(By.css('[data-testid="my-interview-row"]'));
  assert.strictEqual(rows.length, 0, `expected no assigned interviews, got ${rows.length}`);
  const empty = await driver.findElement(By.css('[data-testid="my-interviews-empty"]'));
  const text = await empty.getText();
  assert.ok(/assigned/i.test(text), `empty state should explain the assignment rule, got: ${text.slice(0, 120)}`);
});

Then("my interviews list should include {string}", async function (name) {
  const driver = await this.getDriver();
  await driver.wait(until.elementLocated(By.css('[data-testid="my-interviews-view"]')), 15_000);
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="my-interview-row"][.//*[contains(text(), "${name}")]]`),
    ),
    15_000,
    `assigned interview for "${name}" not found in My Interviews`,
  );
  const text = await row.getText();
  assert.ok(text.includes(name), `row text should mention ${name}`);
});

When("I pick {string} as the interviewer in the schedule form", async function (name) {
  const driver = await this.getDriver();
  const select = await driver.wait(
    until.elementLocated(By.css('[data-testid="schedule-interviewer"]')),
    10_000,
  );
  const options = await select.findElements(By.css("option"));
  // Find the option whose visible text matches, then select by value.
  const texts = await Promise.all(options.map((o) => o.getText()));
  const idx = texts.findIndex((t) => t.includes(name));
  assert.ok(idx >= 0, `interviewer option "${name}" not found; options: ${texts.join(" | ")}`);
  const value = await options[idx].getAttribute("value");
  await setNativeValue(driver, select, value);
});

When("I confirm the interview schedule", async function () {
  const driver = await this.getDriver();
  const when = await driver.wait(
    until.elementLocated(By.css('[data-testid="schedule-when"]')),
    10_000,
  );
  await setNativeValue(driver, when, tomorrowTen());
  await driver.findElement(By.css('[data-testid="schedule-submit"]')).click();
  // The form closes on success; wait for it to disappear (and the busy
  // spinner, if any, to settle).
  await driver.wait(
    until.elementLocated(By.css('[data-testid="candidate-timeline"]')),
    15_000,
    "schedule form did not submit (candidate timeline not back)",
  );
  await driver.sleep(500);
});

When("I fill my scorecard for {string} with rating {int} and {string}", async function (name, rating, recommendation) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="my-interview-row"][.//*[contains(text(), "${name}")]]`),
    ),
    15_000,
    `assigned interview for "${name}" not found`,
  );
  const fillBtn = await row.findElement(
    By.xpath(`.//button[starts-with(@data-testid, "my-interview-fill-") or starts-with(@data-testid, "my-interview-edit-")]`),
  );
  await fillBtn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="my-interview-scorecard-form"]')), 10_000);
  await setNativeValue(driver, await driver.findElement(By.css('[data-testid="my-scorecard-rating"]')), String(rating));
  await setNativeValue(
    driver,
    await driver.findElement(By.css('[data-testid="my-scorecard-recommendation"]')),
    recommendation,
  );
  const strengths = await driver.findElement(By.css('[data-testid="my-scorecard-strengths"]'));
  await strengths.clear();
  await strengths.sendKeys("Great structured thinking; strong on trade-offs.");
  await driver.findElement(By.css('[data-testid="my-scorecard-submit"]')).click();
});

Then("my scorecard for {string} should show as saved", async function (name) {
  const driver = await this.getDriver();
  // After the save the list reloads; the row now carries the filled card.
  const card = await driver.wait(
    until.elementLocated(
      By.xpath(
        `//*[@data-testid="my-interview-row"][.//*[contains(text(), "${name}")]]` +
        `//*[starts-with(@data-testid, "my-interview-card-")]`,
      ),
    ),
    15_000,
    `saved scorecard card for "${name}" not rendered`,
  );
  const text = await card.getText();
  assert.ok(/5\/5/.test(text), `scorecard card should show the saved rating, got: ${text.slice(0, 120)}`);
  assert.ok(/strong hire/i.test(text), `scorecard card should show the saved recommendation, got: ${text.slice(0, 120)}`);
});
