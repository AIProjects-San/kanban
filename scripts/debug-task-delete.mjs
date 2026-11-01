// Debug: the task-delete flow — what opens when the card is clicked, which
// Delete button gets clicked, and what the server says.
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const EMAIL = "demo@fernly.app";
const PW = process.env.DEMO_PW || "";
const TITLE = process.env.DEBUG_TITLE || "E2E smoke task";
const CHROME_BIN = "/tmp/browsers/chrome/linux-156.0.8078.80/chrome-linux64/chrome";

const options = new chrome.Options();
options.setBinaryPath(CHROME_BIN);
options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900");
const logging = await import("selenium-webdriver/lib/logging.js");
const prefs = new logging.Preferences();
prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
options.setLoggingPrefs(prefs);

const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
const log = (...a) => console.log("[del-dbg]", ...a);

try {
  await driver.get(BASE);
  const email = await driver.wait(until.elementLocated(By.css('input[type="email"]')), 20000);
  await email.clear();
  await email.sendKeys(EMAIL);
  const pw = await driver.findElement(By.css('input[type="password"]'));
  await pw.clear();
  await pw.sendKeys(PW);
  await driver.findElement(By.css('button[type="submit"]')).click();
  await driver.wait(until.elementLocated(By.css("main")), 30000, "no main after login");
  const body = await driver.findElement(By.css("body"));
  await body.sendKeys("g", "t");
  await driver.wait(async () => {
    const h = await driver.findElements(By.css("main h1"));
    return h.length > 0 && (await h[0].getText()).includes("Tasks");
  }, 20000, "Tasks view never rendered");
  log("Tasks view open");

  const matches = await driver.findElements(By.xpath(`//*[contains(text(), "${TITLE}")]`));
  log(`elements containing the title: ${matches.length}`);
  for (const m of matches.slice(0, 4)) {
    log("  match:", await m.getTagName(), JSON.stringify((await m.getText()).slice(0, 60)),
      "displayed:", await m.isDisplayed());
  }

  await matches[0].click();
  await driver.sleep(1500);
  const dialogs = await driver.findElements(By.css("[role='dialog']"));
  log("dialog open after card click:", dialogs.length > 0);

  const delButtons = await driver.findElements(By.xpath("//button[contains(., 'Delete')]"));
  log(`Delete buttons on page: ${delButtons.length}`);
  for (const b of delButtons) {
    const inDialog = (await b.findElements(By.xpath("ancestor::div[@role='dialog']"))).length > 0;
    log(`  delete btn inDialog=${inDialog} displayed=${await b.isDisplayed()} text=${JSON.stringify(await b.getText())}`);
  }

  if (dialogs.length > 0) {
    const modalDel = await driver.findElement(By.xpath("//div[@role='dialog']//button[contains(., 'Delete')]"));
    await modalDel.click();
    await driver.sleep(2500);
    const toasts = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
    for (const t of toasts) { try { log("toast:", (await t.getText()).slice(0, 200)); } catch {} }
    const remaining = await driver.findElements(By.xpath(`//*[contains(text(), "${TITLE}")]`));
    log("elements with the title after modal-delete:", remaining.length);
    const dlg2 = await driver.findElements(By.css("[role='dialog']"));
    log("dialog still open:", dlg2.length > 0);
  }
  const logs = await driver.manage().logs().get("browser");
  for (const l of logs) if (l.level.name === "SEVERE") console.log("[del-dbg][console:SEVERE]", l.message.slice(0, 300));
} finally {
  await driver.quit();
}
