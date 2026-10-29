// Cucumber World — owns one Selenium WebDriver instance per scenario.
//
// Browser selection:
//   SELENIUM_BROWSER  (chrome | edge | firefox)   default: chrome
//   SELENIUM_HEADLESS (1|0)                       default: 1
//   BASE_URL                                        default: http://localhost:3000

const { setWorldConstructor, Before, After } = require("@cucumber/cucumber");
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

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
      if (browser === "chrome") {
        const options = new chrome.Options();
        if (HEADLESS) options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");
        options.addArguments("--window-size=1440,900");
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
    await driver.findElement(By.css('input[type="password"]')).sendKeys(password);
    await driver.findElement(By.css('button[type="submit"]')).click();
    // The dashboard greeting appears once the SPA shell has booted.
    await driver.wait(until.elementLocated(By.css("nav, [data-testid='sidebar']")), 15_000);
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

After(async function ({ result }) {
  if (this.driver) {
    if (result?.status === "FAILED") {
      const image = await this.driver.takeScreenshot();
      this.attach(image, "image/png");
    }
    await this.driver.quit();
    this.driver = null;
  }
});

module.exports = { CustomWorld, BASE_URL };
