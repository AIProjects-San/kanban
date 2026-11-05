// Cucumber World — owns one Selenium WebDriver instance per scenario.
//
// Browser selection:
//   SELENIUM_BROWSER  (chrome | edge | firefox)   default: chrome
//   SELENIUM_HEADLESS (1|0)                       default: 1
//   BASE_URL                                        default: http://localhost:3000

const { setWorldConstructor, Before, After } = require("@cucumber/cucumber");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const logging = require("selenium-webdriver/lib/logging");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const HEADLESS = process.env.SELENIUM_HEADLESS !== "0";

class CustomWorld {
  constructor({ attach, parameters }) {
    this.attach = attach;
    this.parameters = parameters;
    this.driver = null;
    this.baseUrl = BASE_URL;
  }

  async getDriver() {
    if (!this.driver) {
      const browser = process.env.SELENIUM_BROWSER || "chrome";
      const builder = new Builder().forBrowser(browser);
      if (process.env.SELENIUM_REMOTE_URL) {
        // Local/sandbox runs: point at a standalone chromedriver (e.g.
        // Chrome-for-Testing) when the machine has no system Chrome for
        // Selenium Manager to auto-resolve. CI's ubuntu runners and normal
        // dev setups are unaffected — Selenium Manager resolves both
        // binaries there. Mirrors the CHROME_BIN convention used by the
        // scripts/browser-*.mjs debug tools.
        builder.usingServer(process.env.SELENIUM_REMOTE_URL);
      }
      if (browser === "chrome") {
        const options = new chrome.Options();
        if (HEADLESS) options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");
        options.addArguments("--window-size=1440,900");
        if (process.env.CHROME_BIN) options.setBinaryPath(process.env.CHROME_BIN);
        // Capture the browser console (SEVERE errors, hydration warnings) so a
        // failed scenario can attach it — without this, client-side crashes
        // are invisible in CI logs.
        const prefs = new logging.Preferences();
        prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
        options.setLoggingPrefs(prefs);
        builder.setChromeOptions(options);
      }
      this.driver = await builder.build();
      // Fail fast instead of hanging when an element never appears.
      await this.driver.manage().setTimeouts({ implicit: 2_000, pageLoad: 20_000 });
    }
    return this.driver;
  }

  /** Sign in through the real login form (exercises the actual auth flow).
   *
   * expectSuccess (default true): the step expects these credentials to
   * WORK. When a login error toast appears instead of the app shell, the
   * helper FAILS the step immediately with the email + toast text — the
   * previous version accepted either outcome, so a rejected sign-in let
   * the scenario continue UNAUTHENTICATED and blow up much later at a
   * view/data step with misleading symptoms ("candidate card not found",
   * "funnel never appeared"). Negative-credential scenarios (login.feature,
   * lockout) pass { expectSuccess: false } and keep the tolerant behavior.
   */
  async login(email, password, { expectSuccess = true } = {}) {
    const driver = await this.getDriver();
    await driver.get(this.baseUrl);
    const emailInput = await driver.wait(
      until.elementLocated(By.css('input[type="email"]')),
      10_000,
      "login email field did not appear",
    );
    // CI-stabilization: the naive `element.clear()` is a plain value wipe —
    // on a React CONTROLLED input (SEED_DEMO pre-fills the demo password)
    // React can re-render the old state value back between clear() and
    // sendKeys, producing "password+password" submissions. Those 401s charge
    // the brute-force throttle budgets (5 per email / IP per 15 min), which
    // eventually 429-locks entire roles out mid-suite — the "bad window"
    // that reproducibly failed clusters of scenarios. Clear through the
    // native prototype setter + input event so React state empties too.
    // CI-stabilization round 3: the fill can ALSO race React HYDRATION. The
    // login screen is server-rendered with the demo prefill; when the clear
    // + sendKeys below lands before hydrateRoot() attaches its listeners,
    // hydration snaps the inputs back to the SSR values (demo@fernly.app /
    // the demo password) — the submit then authenticates as the WRONG
    // account or 401s with a doubled password (the prefill + the typed
    // value concatenated). Fill -> VERIFY -> retry defeats the snapback:
    // read the input values back and only submit once they match intent.
    const passwordInput = await driver.findElement(By.css('input[type="password"]'));
    let valuesOk = false;
    for (let attempt = 0; attempt < 4 && !valuesOk; attempt++) {
      await driver.executeScript(
        `const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         for (const el of [arguments[0], arguments[1]]) {
           setter.call(el, '');
           el.dispatchEvent(new Event('input', { bubbles: true }));
         }`,
        emailInput,
        passwordInput,
      );
      await emailInput.sendKeys(email);
      await passwordInput.sendKeys(password);
      valuesOk = await driver.executeScript(
        `return arguments[0].value === arguments[2] && arguments[1].value === arguments[3];`,
        emailInput,
        passwordInput,
        email,
        password,
      );
    }
    if (!valuesOk && email !== "" && password !== "") {
      // Persistent snapback (or a renderer glitch). Report it loudly instead
      // of submitting values we know are wrong — a 401 here charges the
      // brute-force throttle and poisons later scenarios.
      const got = await driver.executeScript(
        `return { email: arguments[0].value, password: arguments[1].value };`,
        emailInput,
        passwordInput,
      );
      throw new Error(
        `login form fill did not stick (hydration snapback?): ` +
          `intended email="${email}" password=<${password.length} chars>, ` +
          `got email="${got.email}" password=<${(got.password || "").length} chars>`,
      );
    }
    await driver.findElement(By.css('button[type="submit"]')).click();
    // Empty credentials never leave the page (native `required` validation
    // blocks the submit) — short-circuit; the caller's "still on the login
    // screen" assertion covers that outcome.
    if (email === "" || password === "") {
      await driver.sleep(500);
      return;
    }
    // Accept EITHER outcome so negative-credential scenarios don't time out
    // waiting for a nav that never appears: the SPA shell boots (successful
    // sign-in) or the login screen reports the rejection (error toast).
    const sawShell = await driver.wait(
      async () => {
        const shell = await driver.findElements(By.css("nav, [data-testid='sidebar']"));
        if (shell.length > 0) return "shell";
        const toast = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
        if (toast.length > 0) return "toast";
        return false;
      },
      15_000,
      "neither the app shell nor a login error appeared after sign-in",
    );
    if (expectSuccess && sawShell === "toast") {
      // Fail the step AT THE LOGIN with the actual reason — never let the
      // scenario wander on unauthenticated (see docblock).
      let toastText = "";
      try {
        const toasts = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
        if (toasts.length) toastText = (await toasts[0].getText()).slice(0, 120);
      } catch { /* best-effort */ }
      throw new Error(
        `sign-in as "${email}" was REJECTED (${toastText || "error toast"}). ` +
          `The form fill raced React hydration — a retry usually recovers; ` +
          `if it persists, check the seeded password.`,
      );
    }
    if (!expectSuccess && sawShell === "shell") {
      throw new Error(
        `sign-in as "${email}" UNEXPECTEDLY SUCCEEDED — negative-credential scenario is broken`,
      );
    }
  }

  /** Sign out by clearing cookies (session cookie is httpOnly). */
  async logout() {
    if (this.driver) {
      await this.driver.manage().deleteAllCookies();
    }
  }
}

setWorldConstructor(CustomWorld);

Before(async function () {
  // Nothing global yet — drivers are created lazily per scenario.
});

After(async function ({ result, pickle }) {
  if (this.driver) {
    if (result?.status === "FAILED") {
      // Attach to the cucumber report …
      const image = await this.driver.takeScreenshot();
      this.attach(image, "image/png");
      // … and write artifacts to disk so CI can upload them — a screenshot
      // plus the URL/h1/toast state answers "what page was the browser
      // actually on" without guessing from timeouts.
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const dir = path.join(process.cwd(), "e2e", "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const slug = (pickle?.name || "scenario")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 60);
        // Timestamp suffix: cucumber retries re-run the scenario and would
        // otherwise overwrite the earlier attempt's evidence.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19);
        const url = await this.driver.getCurrentUrl();
        const headings = await this.driver.findElements(By.css("main h1"));
        const h1 = headings.length ? await headings[0].getText() : "(no main h1)";
        const toasts = await this.driver.findElements(
          By.css("[data-sonner-toast], [role='alert']"),
        );
        const toastTexts = [];
        for (const t of toasts) toastTexts.push(await t.getText());
        // CI-stabilization: also capture the BROWSER console (SEVERE errors,
        // chunk-fetch failures, hydration crashes) — a blank main area with a
        // rendered shell is invisible without it.
        let consoleLines = [];
        try {
          const logs = await this.driver.manage().logs().get("browser");
          consoleLines = logs.map((l) => `${l.level.name} ${l.message.slice(0, 300)}`);
        } catch {
          // Not all drivers support log retrieval — never mask the failure.
        }
        // CI-stabilization round 3: a rendered board with a MISSING panel
        // (outbox/funnel) is a permission or user-identity symptom, not a
        // timing one — capture the signed-in user + a panel-presence map so
        // the dump answers "as WHOM was the browser logged in" directly.
        let identity = {};
        try {
          identity = await this.driver.executeScript(() => {
            const pick = (sel) => {
              const el = document.querySelector(sel);
              return el ? (el.textContent || "").trim().slice(0, 80) : null;
            };
            const topbarName = document.querySelector(
              "[data-testid='sidebar'] [class*='text'], nav [class*='text']",
            );
            return {
              loginEmailField: !!document.querySelector('input[type="email"]'),
              sidebarUser: topbarName ? (topbarName.textContent || "").slice(0, 60) : null,
              panels: {
                hiringBoard: !!document.querySelector('[data-testid="hiring-board"]'),
                funnel: !!document.querySelector('[data-testid="hiring-funnel"]'),
                outboxPanel: !!document.querySelector('[data-testid="email-outbox"]'),
                outboxRows: document.querySelectorAll('[data-testid="outbox-row"]').length,
                offersPanel: !!document.querySelector('[data-testid="offers-panel"]'),
                candidateCards: document.querySelectorAll('[data-testid="candidate-card"]').length,
                myInterviewsStrip: !!document.querySelector('[data-testid="my-interviews"]'),
                mailWarning: !!document.querySelector('[data-testid="mail-config-warning"]'),
                interviewerView: (document.querySelector('[data-testid="hiring-board"] p') || {}).textContent || null,
              },
            };
          });
        } catch {
          // The dump must never mask the original failure.
        }
        fs.writeFileSync(
          path.join(dir, `${slug}-${stamp}.png`),
          Buffer.from(image, "base64"),
        );
        fs.writeFileSync(
          path.join(dir, `${slug}-${stamp}.state.txt`),
          `url: ${url}\nh1: ${h1}\ntoasts: ${JSON.stringify(toastTexts)}\n` +
            `identity: ${JSON.stringify(identity)}\n` +
            `console (${consoleLines.length} entries):\n` +
            consoleLines.slice(0, 30).join("\n") + "\n",
        );
      } catch (e) {
        // Artifact capture must never mask the original failure.
        console.error("[e2e] artifact capture failed:", e.message);
      }
    }
    await this.driver.quit();
    this.driver = null;
  }
});

module.exports = { CustomWorld, BASE_URL };
