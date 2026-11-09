// Steps for the hiring pipeline feature (Recruitment R1).
// docs/RECRUITMENT_MODULE_PLAN.md §7 — runs in CI e2e (local sandbox has no
// Chrome; see e2e/README.md).

const { Then, When } = require("@cucumber/cucumber");
const { By, until } = require("selenium-webdriver");
const assert = require("node:assert");

Then("the hiring board should show the stage column {string}", async function (key) {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css(`[data-testid="stage-column-${key}"]`)),
    15_000,
    `stage column "${key}" did not render`,
  );
});

When("I open the candidate card {string}", async function (name) {
  const driver = await this.getDriver();
  // CI-stabilization: dev-mode server actions can lag well past 15 s under
  // the 2-core CI runner's load — the board shell renders (heading) while
  // getHiringBoard's response is still in flight. 30 s absorbs it.
  const card = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="candidate-card"]//*[contains(text(), "${name}")]`),
    ),
    30_000,
    `candidate card "${name}" not found on the board`,
  );
  // Click the card itself so the click doesn't land on an inner element.
  await driver.executeScript(
    "arguments[0].closest('[data-testid=\"candidate-card\"]').click();",
    card,
  );
  await driver.wait(until.elementLocated(By.css('[data-testid="candidate-timeline"]')), 15_000);
});

When("I advance the current stage", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="advance-stage-btn"]')),
    10_000,
  );
  await btn.click();
  // The modal refreshes its data; give the toast + reload a beat.
  await driver.sleep(1_500);
});

Then("the candidate detail should show the stage {string} as passed", async function (key) {
  const driver = await this.getDriver();
  const stage = await driver.wait(
    until.elementLocated(By.css(`[data-testid="stage-${key}"]`)),
    10_000,
  );
  const text = await stage.getText();
  assert.ok(/PASSED/.test(text), `stage "${key}" should be PASSED, got: ${text}`);
});

When("I try to reject the candidate", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="reject-btn"]')),
    10_000,
  );
  await btn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="reject-reason"]')), 10_000);
});

Then("the rejection reason field should be required", async function () {
  const driver = await this.getDriver();
  const area = await driver.findElement(By.css('[data-testid="reject-reason"]'));
  // The form's own validation (submit with empty reason) must block — the
  // textarea exists and the confirm button stays present without advancing.
  const value = await area.getAttribute("value");
  assert.strictEqual(value, "", "rejection reason starts empty");
  const confirm = await driver.findElement(By.css('[data-testid="reject-confirm"]'));
  assert.ok(await confirm.isDisplayed(), "confirm button awaits a reason");
});

When("I open the schedule form for stage {string}", async function (key) {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css(`[data-testid="schedule-btn-${key}"]`)),
    10_000,
    `schedule button for stage "${key}" not found`,
  );
  await btn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="schedule-form"]')), 10_000);
});

Then("the schedule form should offer the interviewer dropdown", async function () {
  const driver = await this.getDriver();
  const select = await driver.wait(
    until.elementLocated(By.css('[data-testid="schedule-interviewer"]')),
    10_000,
  );
  const options = await select.findElements(By.css("option"));
  // "— Keep current owner —" + at least the seeded directory members.
  assert.ok(options.length >= 2, `expected interviewer options, got ${options.length}`);
});

// ---------------------------------------------------------------------------
// R3 — decisions & email outbox
// ---------------------------------------------------------------------------

When("I select the candidate", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="select-btn"]')),
    10_000,
  );
  await btn.click();
  await driver.sleep(1_500);
});

Then("the candidate detail should show the offer-prep banner", async function () {
  const driver = await this.getDriver();
  const banner = await driver.wait(
    until.elementLocated(By.xpath("//*[contains(text(), 'Offer preparation pending')]")),
    10_000,
    "offer-prep banner did not appear after selecting",
  );
  assert.ok(await banner.isDisplayed(), "offer-prep banner visible");
});

When("I fill the rejection reason with {string}", async function (reason) {
  const driver = await this.getDriver();
  const area = await driver.findElement(By.css('[data-testid="reject-reason"]'));
  await area.sendKeys(reason);
});

When("I toggle the rejection email on", async function () {
  const driver = await this.getDriver();
  const toggle = await driver.findElement(By.css('[data-testid="reject-email-toggle"] input'));
  await toggle.click();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="reject-email-remarks"]')),
    10_000,
  );
});

When("I confirm the rejection", async function () {
  const driver = await this.getDriver();
  const btn = await driver.findElement(By.css('[data-testid="reject-confirm"]'));
  await btn.click();
  await driver.sleep(2_000);
});

Then("the email outbox should show a recorded email to {string}", async function (address) {
  const driver = await this.getDriver();
  // CI-stabilization round 3 — XPath fix: this step NEVER matched, in any
  // run, local or CI. `contains(text(), X)` evaluates only the FIRST text
  // node of the element, but the address span is JSX
  // `to {m.toAddress}{m.candidateName ? \u00b7 ${...} : ""}` — React emits
  // "to ", the address, and the name as SEPARATE adjacent text nodes, so
  // `text()` is the node-set ["to ", address, ...] and contains() only sees
  // "to ". The row renders, the wait times out anyway, the scenario fails
  // and its retry poisons the next attempt. `contains(., X)` compares the
  // element's FULL string value (all descendant text) — the standard XPath
  // pattern for JSX-fragmented text.
  // 30 s — the outbox panel is manage-gated data that lags the view shell
  // on a loaded dev server (same class as the card waits above).
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="outbox-row"]//*[contains(., "${address}")]`),
    ),
    30_000,
    `no outbox row for "${address}"`,
  );
  assert.ok(row, `outbox row for ${address} found`);
});

Then("the outbox entry should be recorded as skipped", async function () {
  const driver = await this.getDriver();
  // CI e2e runs without RESEND_API_KEY — the send is recorded SKIPPED.
  const chip = await driver.wait(
    until.elementLocated(
      By.xpath('//*[@data-testid="outbox-row"]/*[contains(text(), "SKIPPED")]'),
    ),
    10_000,
    "no SKIPPED outbox row",
  );
  assert.ok(chip, "outbox row recorded as SKIPPED");
});

Then("the email outbox panel should not be visible", async function () {
  const driver = await this.getDriver();
  // Wait for the board itself first so the assertion isn't just "page still
  // loading" — then the panel must be absent.
  await driver.wait(
    until.elementLocated(By.css('[data-testid="stage-column-screening"]')),
    15_000,
  );
  const panels = await driver.findElements(By.css('[data-testid="email-outbox"]'));
  assert.strictEqual(panels.length, 0, "email outbox panel must be hidden without hiring:manage");
});

Then("the selected filter chip should show a count of at least {int}", async function (min) {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.css('[data-testid="hiring-filter-selected"]')),
    15_000,
  );
  const text = await chip.getText();
  const match = text.match(/(\d+)/);
  assert.ok(match, `selected chip should carry a count, got: ${text}`);
  assert.ok(
    Number(match[1]) >= min,
    `selected count ${match[1]} should be >= ${min}`,
  );
});

// ---------------------------------------------------------------------------
// R4 — joining formalities (documents + background checks)
// ---------------------------------------------------------------------------

When("I open the {string} pool", async function (label) {
  const driver = await this.getDriver();
  const key = label.toUpperCase();
  const chip = await driver.wait(
    until.elementLocated(By.css(`[data-testid="hiring-filter-${key.toLowerCase()}"]`)),
    10_000,
    `filter chip "${label}" not found`,
  );
  await chip.click();
  await driver.sleep(400);
});

Then("the joining formalities panel should show the document checklist", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="joining-formalities"]')),
    10_000,
    "joining-formalities panel did not render",
  );
  await driver.wait(
    until.elementLocated(By.css('[data-testid="doc-checklist"]')),
    10_000,
    "document checklist did not render",
  );
});

Then("the document {string} should show status {string}", async function (docTypeKey, status) {
  const driver = await this.getDriver();
  const chip = await driver.wait(
    until.elementLocated(By.css(`[data-testid="doc-status-${docTypeKey}"]`)),
    10_000,
    `status chip for document "${docTypeKey}" not found`,
  );
  const text = await chip.getText();
  assert.strictEqual(text, status, `document "${docTypeKey}" should be ${status}, got: ${text}`);
});

Then("the background check section should list the vendor {string}", async function (vendor) {
  const driver = await this.getDriver();
  const row = await driver.wait(
    until.elementLocated(
      By.xpath(`//*[@data-testid="bg-check-list"]//*[contains(text(), "${vendor}")]`),
    ),
    10_000,
    `background check for vendor "${vendor}" not found`,
  );
  assert.ok(row, `background check row for ${vendor} found`);
});

When("I request the {string} document", async function (docTypeKey) {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css(`[data-testid="request-doc-${docTypeKey}"]`)),
    10_000,
    `request button for document "${docTypeKey}" not found`,
  );
  await btn.click();
  await driver.sleep(1_500);
});

When("I sign out and back in as {string}", async function (email) {
  await this.logout();
  const driver = await this.getDriver();
  // logout() clears httpOnly cookies — reload to bounce back to the login screen.
  await driver.navigate().refresh();
  await driver.wait(until.elementLocated(By.css('input[type="email"]')), 10_000);
  const emailInput = await driver.findElement(By.css('input[type="email"]'));
  const passInput = await driver.findElement(By.css('input[type="password"]'));
  // CI-stabilization round 3: two bugs fixed here —
  // 1) The password came from process.env.DEMO_PASSWORD (never set in CI,
  //    which only defines NEXT_PUBLIC_DEMO_PASSWORD), silently falling back
  //    to the literal "fernly123" while CI seeds a different value → a
  //    deterministic 401 on every re-login (the R4 config-gate scenario in
  //    both prior runs). Use the shared resolver, exactly like the primary
  //    sign-in step.
  // 2) element.clear() on a React CONTROLLED input (SEED_DEMO pre-fills the
  //    demo password) can have React re-render the stale state value back
  //    between clear() and sendKeys, producing "old+new" submissions — the
  //    same class of bug world.js's login() documents. Clear through the
  //    native prototype setter + input event so React state empties too.
  const { DEMO_PASSWORD } = require("../support/demo-password.js");
  await driver.executeScript(
    `const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     for (const el of arguments) {
       setter.call(el, '');
       el.dispatchEvent(new Event('input', { bubbles: true }));
     }`,
    emailInput,
    passInput,
  );
  await emailInput.sendKeys(email);
  await passInput.sendKeys(DEMO_PASSWORD);
  await driver.findElement(By.css('button[type="submit"]')).click();
  // These are always CORRECT credentials — a rejection here is a failure of
  // this step (env misconfiguration or a fill race), never an outcome to
  // tolerate: fail fast with the toast text instead of letting the scenario
  // continue unauthenticated (world.js login()'s expectSuccess contract).
  const sawShell = await driver.wait(
    async () => {
      const shell = await driver.findElements(By.css("nav, [data-testid='sidebar']"));
      if (shell.length > 0) return "shell";
      const toast = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
      if (toast.length > 0) return "toast";
      return false;
    },
    15_000,
    "neither the app shell nor a login error appeared after re-login",
  );
  if (sawShell === "toast") {
    let toastText = "";
    try {
      const toasts = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
      if (toasts.length) toastText = (await toasts[0].getText()).slice(0, 120);
    } catch { /* best-effort */ }
    throw new Error(`re-login as "${email}" was REJECTED (${toastText || "error toast"})`);
  }
  await driver.sleep(2_000);
});

// ---------------------------------------------------------------------------
// R5 — offer builder
// ---------------------------------------------------------------------------

When("I open the offer builder", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="build-offer-btn"]')),
    10_000,
    "Build offer button not found (SELECTED candidates only)",
  );
  await btn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="offer-list"]')), 10_000);
});

Then("the offer builder should list a draft offer with the live CTC total", async function () {
  const driver = await this.getDriver();
  // CI-repair: F2.10 seeded an EXPIRED earlier attempt for the same
  // candidate, and the offer list sorts createdAt-desc — the FIRST row is
  // not necessarily the DRAFT. Scan every row for the draft-with-CTC shape
  // the scenario actually asserts ("a draft offer with the live CTC total").
  await driver.wait(
    until.elementLocated(By.css('[data-testid^="offer-row-"]')),
    10_000,
    "no offer row rendered",
  );
  const rows = await driver.findElements(By.css('[data-testid^="offer-row-"]'));
  const texts = [];
  for (const row of rows) texts.push(await row.getText());
  const draft = texts.find((t) => /DRAFT/.test(t) && /CTC \$[\d,]+/.test(t));
  assert.ok(
    draft,
    `no DRAFT offer row with a CTC total, got: ${texts.map((t) => t.slice(0, 90)).join(" || ")}`,
  );
});

Then("the offers panel should show {string} with a DRAFT chip", async function (name) {
  const driver = await this.getDriver();
  const panel = await driver.wait(
    until.elementLocated(By.css('[data-testid="offers-panel"]')),
    10_000,
    "offers panel not found",
  );
  const text = await panel.getText();
  assert.ok(text.includes(name), `offers panel should mention ${name}, got: ${text.slice(0, 200)}`);
  assert.ok(/DRAFT/.test(text), "offers panel should show a DRAFT chip");
});

Then("the offers panel should not be visible", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="stage-column-screening"]')),
    15_000,
  );
  const panels = await driver.findElements(By.css('[data-testid="offers-panel"]'));
  assert.strictEqual(panels.length, 0, "offers panel must be hidden without hiring:manage");
});

// ---------------------------------------------------------------------------
// R6 — e-sign: send the tokenized offer, sign on the PUBLIC /offer/[token]
// page, then mark the signed candidate joined (provisions the account).
// The send+sign scenario must run BEFORE "HR marks the signed candidate" —
// the signing link is minted in the browser and consumed by the candidate.
// ---------------------------------------------------------------------------

When("I send the offer draft", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid^="send-offer-"]')),
    10_000,
    "no Send button — is there a DRAFT offer for this candidate?",
  );
  await btn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="offer-link-box"]')), 15_000);
});

Then("the signing link should be displayed", async function () {
  const driver = await this.getDriver();
  const link = await driver.wait(
    until.elementLocated(By.css('[data-testid="offer-sign-link"]')),
    10_000,
    "the signing link box did not appear after sending",
  );
  const url = (await link.getText()).trim();
  assert.ok(/\/offer\/[A-Za-z0-9_-]{20,}/.test(url), `signing link should point at /offer/<token>, got: ${url}`);
  this.offerLink = url;
});

When("the candidate opens the signing link", async function () {
  const driver = await this.getDriver();
  assert.ok(this.offerLink, "no signing link captured — run the send step first");
  await driver.get(this.offerLink);
  await driver.wait(until.elementLocated(By.css('[data-testid="offer-sign-form"]')), 15_000);
});

When("the candidate signs with their full legal name", async function () {
  const driver = await this.getDriver();
  const input = await driver.wait(
    until.elementLocated(By.css('[data-testid="offer-sign-name"]')),
    10_000,
  );
  await input.sendKeys("Priyanka Menon");
  await driver.findElement(By.css('[data-testid="offer-sign-submit"]')).click();
  await driver.sleep(1_500);
});

Then("the public offer page should show the signed confirmation", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="offer-signed-state"]')),
    15_000,
    "signed confirmation did not render after signing",
  );
});

When("I mark the candidate as joined", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="mark-joined-btn"]')),
    10_000,
    "Mark joined button not found (needs SELECTED candidate + SIGNED offer)",
  );
  // The button is disabled until a SIGNED offer exists for this candidate.
  await driver.wait(until.elementIsEnabled(btn), 10_000, "Mark joined stayed disabled");
  await btn.click();
  await driver.sleep(2_000);
});

Then("the candidate detail should show the hired summary", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="hired-details"]')),
    15_000,
    "hired summary did not render after marking joined",
  );
});

// ---------------------------------------------------------------------------
// R8 — funnel analytics panel
// ---------------------------------------------------------------------------

Then("the funnel panel should show stage metrics", async function () {
  const driver = await this.getDriver();
  // CI-stabilization round 3: poll by RE-LOCATING the panel on every
  // iteration. The previous version resolved the panel WebElement once and
  // then polled getText() on that handle — but the app-shell remounts the
  // active view subtree (key={`${view}-${refreshTick}`}) on any refresh
  // tick, which DETACHES the old panel node. getText() on the detached
  // handle then throws StaleElementReferenceException on every poll and
  // driver.wait swallows it until the timeout — the failure screenshot
  // showed a fully-rendered funnel ("Stages — in progress / passed / avg
  // days" plainly visible) while the step still reported "stage metrics
  // header never appeared". findElements + a fresh getText each iteration
  // is immune: the re-query always targets the CURRENT DOM node.
  await driver.wait(
    async () => {
      const panels = await driver.findElements(By.css('[data-testid="hiring-funnel"]'));
      if (panels.length === 0) return false;
      try {
        // CI-stabilization round 3 — case-insensitive: the header renders
        // with CSS `uppercase`, so getText() (innerText) yields
        // "STAGES — IN PROGRESS / PASSED / AVG DAYS" — the previous
        // case-sensitive includes("avg days") could never match. The step
        // failed in EVERY run, local and CI, while the screenshot showed a
        // fully rendered funnel.
        return (await panels[0].getText()).toLowerCase().includes("avg days");
      } catch {
        // Stale between locate and read — the next poll re-locates.
        return false;
      }
    },
    30_000,
    "stage metrics header never appeared",
  );
  const text = await driver
    .wait(until.elementLocated(By.css('[data-testid="hiring-funnel"]')), 15_000)
    .getText();
  assert.ok(/\d+\s*\/\s*\d+/.test(text), `stage metrics should carry counts: ${text.slice(0, 200)}`);
});

Then("the funnel panel should show the offer accept rate", async function () {
  const driver = await this.getDriver();
  const rate = await driver.wait(
    until.elementLocated(By.css('[data-testid="funnel-accept-rate"]')),
    10_000,
    "accept-rate element did not render",
  );
  const text = await rate.getText();
  assert.ok(
    /^\d+%$|^—$/.test(text.trim()),
    `accept rate should render as a percentage or the em-dash, got: "${text}"`,
  );
});

// ---------------------------------------------------------------------------
// P0-6 (D-05/D-18, persona-audit) — mail delivery truth + first-run guidance.
// ---------------------------------------------------------------------------

// Local copy of the hr-steps toast helper (sonner toasts render with
// [data-sonner-toast]); keyword match is case-insensitive.
async function waitForHiringToast(driver, keyword, timeout = 10_000) {
  const target = keyword.toLowerCase();
  await driver.wait(
    async () => {
      const toasts = await driver.findElements(By.css("[data-sonner-toast]"));
      for (const t of toasts) {
        const text = (await t.getText()).toLowerCase();
        if (text.includes(target)) return true;
      }
      return false;
    },
    timeout,
    `no toast mentioning "${keyword}" appeared`,
  );
}

Then("a toast should mention {string}", async function (keyword) {
  const driver = await this.getDriver();
  await waitForHiringToast(driver, keyword);
});

When("I reactivate the candidate", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid="reactivate-btn"]')),
    10_000,
    "reactivate button did not render (candidate not in a reactivatable pool?)",
  );
  await btn.click();
  // The board reloads via onChanged; give the ACTIVE re-render a beat so the
  // subsequent reject flow finds its button.
  await driver.sleep(800);
});

Then("the mail config warning should be visible", async function () {
  const driver = await this.getDriver();
  const banner = await driver.wait(
    until.elementLocated(By.css('[data-testid="mail-config-warning"]')),
    10_000,
    "mail-config warning banner did not render (provider configured?)",
  );
  const text = await banner.getText();
  assert.ok(
    text.includes("Email delivery is off"),
    `banner should explain the off state, got: "${text.slice(0, 120)}"`,
  );
});

When("I close the candidate detail modal", async function () {
  const driver = await this.getDriver();
  await driver
    .findElement(By.xpath(`//div[@role='dialog']//button[@aria-label='Close dialog']`))
    .click();
  // Wait for the dialog (and its backdrop) to unmount so later clicks on
  // board controls are never intercepted.
  await driver.wait(
    async () => (await driver.findElements(By.css("div[role='dialog']"))).length === 0,
    10_000,
    "the candidate detail modal did not close after clicking X",
  );
});

// ---------------------------------------------------------------------------
// F2.10 — joining hardening: the manager approval step (R11/D-20), the
// printable appointment letter (R12), the joining gate (F-R9/E5), and the
// interview-invite email (F-R10).
// ---------------------------------------------------------------------------

Then("the offer approvals panel should be visible", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="offer-approvals-panel"]')),
    10_000,
    "offer approvals panel did not render (manager holds hiring:approve?)",
  );
});

Then("the offer approvals panel should show no drafts awaiting approval", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    until.elementLocated(By.css('[data-testid="offer-approvals-panel"]')),
    10_000,
  );
  // The approved row leaves the queue; the empty state takes over.
  await driver.wait(
    async () => {
      const rows = await driver.findElements(By.css('[data-testid="offer-approval-row"]'));
      return rows.length === 0;
    },
    10_000,
    "the approved draft is still listed in the approvals queue",
  );
});

When("I approve the draft offer", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid^="approve-offer-"]')),
    10_000,
    "no Approve button — is there a DRAFT offer awaiting approval?",
  );
  await btn.click();
  // The approvals panel reloads; wait for the row to clear.
  await driver.wait(
    async () => {
      const rows = await driver.findElements(By.css('[data-testid="offer-approval-row"]'));
      return rows.length === 0;
    },
    15_000,
    "the approved draft never left the approvals queue",
  );
});

When("I send the approved offer", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid^="send-offer-"]')),
    10_000,
    "no Send button — is the offer APPROVED (manager four-eyes step)?",
  );
  await btn.click();
  await driver.wait(until.elementLocated(By.css('[data-testid="offer-link-box"]')), 15_000);
});

Then("the signed page should offer the printable appointment letter \\(F2.10\\)", async function () {
  const driver = await this.getDriver();
  const letter = await driver.wait(
    until.elementLocated(By.css('[data-testid="appointment-letter"]')),
    10_000,
    "the appointment letter did not render on the signed state",
  );
  const text = await letter.getText();
  // CI-repair: the signature block renders with Tailwind `uppercase`, and
  // Selenium's getText() returns the CSS-TRANSFORMED text ("ACCEPTED
  // ELECTRONICALLY"), so the assertion must be case-insensitive — the unit
  // suite never caught this because it asserts textContent (untransformed).
  assert.ok(/letter of appointment/i.test(text), `letter heading missing, got: ${text.slice(0, 120)}`);
  assert.ok(/accepted electronically/i.test(text), "the signature block is missing");
  const printBtn = await driver.wait(
    until.elementLocated(By.css('[data-testid="appointment-letter-print"]')),
    10_000,
    "the print affordance did not render",
  );
  assert.ok(await printBtn.isDisplayed(), "the print button must be visible");
});

Then("the joining gate status should list the outstanding blockers", async function () {
  const driver = await this.getDriver();
  const gate = await driver.wait(
    until.elementLocated(By.css('[data-testid="joining-gate-status"]')),
    10_000,
    "the joining-gate status block did not render",
  );
  const text = await gate.getText();
  assert.ok(text.includes("Joining gate"), `gate summary missing, got: "${text.slice(0, 160)}"`);
  assert.ok(
    text.includes("Bank Details") && text.includes("Right to Work"),
    "the gate should list the un-verified mandatory documents",
  );
  assert.ok(text.includes("Background check"), "the gate should list the pending background check");
});

Then("the joining gate status should show the gate satisfied", async function () {
  const driver = await this.getDriver();
  await driver.wait(
    async () => {
      const gate = await driver.findElement(By.css('[data-testid="joining-gate-status"]'));
      const text = await gate.getText();
      return text.includes("Joining gate") && !text.includes("not requested") && !text.includes("not yet verified") && !text.includes("in review");
    },
    15_000,
    "the gate still lists outstanding blockers",
  );
});

When("I verify the {string} document", async function (docKey) {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css(`[data-testid="verify-doc-${docKey}"]`)),
    10_000,
    `Verify button for ${docKey} did not render (document RECEIVED?)`,
  );
  await btn.click();
  // The formalities bundle reloads in place; wait for the chip to flip.
  await driver.wait(
    until.elementLocated(By.css(`[data-testid="doc-status-${docKey}"]`)),
    10_000,
  );
  await driver.sleep(600);
});

When("I receive the {string} document", async function (docKey) {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css(`[data-testid="receive-doc-${docKey}"]`)),
    10_000,
    `Mark-received button for ${docKey} did not render (document REQUESTED?)`,
  );
  await btn.click();
  const submit = await driver.wait(
    until.elementLocated(By.css(`[data-testid="doc-action-submit-${docKey}"]`)),
    10_000,
  );
  await submit.click();
  await driver.sleep(600);
});

When("I clear the background check", async function () {
  const driver = await this.getDriver();
  const btn = await driver.wait(
    until.elementLocated(By.css('[data-testid^="bg-clear-"]')),
    10_000,
    "no Clear button — is there a non-terminal background check?",
  );
  await btn.click();
  await driver.sleep(600);
});

Then("the hired summary should confirm the salary structure was copied \\(F2.10\\)", async function () {
  const driver = await this.getDriver();
  const line = await driver.wait(
    until.elementLocated(By.css('[data-testid="payroll-ready-line"]')),
    15_000,
    "the payroll-ready line did not render in the hired summary",
  );
  const text = await line.getText();
  assert.ok(
    text.includes("payroll-ready"),
    `the payroll-ready verdict should confirm the structure copy, got: "${text}"`,
  );
});

When("I submit the interview schedule form", async function () {
  const driver = await this.getDriver();
  // The form is already open (the previous step opened it); pick the first
  // free slot tomorrow at 10:00 local time and submit.
  const when = await driver.wait(
    until.elementLocated(By.css('[data-testid="schedule-when"]')),
    10_000,
  );
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const value = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T10:00`;
  await driver.executeScript(
    "arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('input', { bubbles: true })); arguments[0].dispatchEvent(new Event('change', { bubbles: true }));",
    when,
    value,
  );
  const submit = await driver.wait(
    until.elementLocated(By.css('[data-testid="schedule-submit"]')),
    10_000,
  );
  await submit.click();
  await driver.sleep(1_500);
});
