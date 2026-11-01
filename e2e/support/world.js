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

  /** Sign in through the real login form (exercises the actual auth flow). */
  async login(email, password) {
    const driver = await this.getDriver();
    await driver.get(this.baseUrl);
    const emailInput = await driver.wait(
      until.elementLocated(By.css('input[type="email"]')),
      10_000,
      "login email field did not appear",
    );
    await emailInput.clear();
    await emailInput.sendKeys(email);
    // Clear the password field too — in SEED_DEMO mode the login form is
    // PRE-FILLED with the demo password, and sendKeys APPENDS. Without the
    // clear, every e2e sign-in submitted password+password and got a 401
    // ("Invalid credentials") that looked like an auth bug.
    const passwordInput = await driver.findElement(By.css('input[type="password"]'));
    await passwordInput.clear();
    await passwordInput.sendKeys(password);
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
    await driver.wait(
      async () => {
        const shell = await driver.findElements(By.css("nav, [data-testid='sidebar']"));
        if (shell.length > 0) return true;
        const toast = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
        return toast.length > 0;
      },
      15_000,
      "neither the app shell nor a login error appeared after sign-in",
    );
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
        fs.writeFileSync(
          path.join(dir, `${slug}-${stamp}.png`),
          Buffer.from(image, "base64"),
        );
        fs.writeFileSync(
          path.join(dir, `${slug}-${stamp}.state.txt`),
          `url: ${url}\nh1: ${h1}\ntoasts: ${JSON.stringify(toastTexts)}\n`,
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
