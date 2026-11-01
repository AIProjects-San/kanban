// Debug: drive the real task-creation flow and dump what actually happens —
// toasts, modal state, board content, browser console.
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const EMAIL = "demo@fernly.app";
const PW = process.env.DEMO_PW || "";
const CHROME_BIN = "/tmp/browsers/chrome/linux-156.0.8078.80/chrome-linux64/chrome";

const options = new chrome.Options();
options.setBinaryPath(CHROME_BIN);
options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900");
const logging = await import("selenium-webdriver/lib/logging.js");
const prefs = new logging.Preferences();
prefs.setLevel(logging.Type.BROWSER, logging.Level.ALL);
options.setLoggingPrefs(prefs);

const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
const log = (...a) => console.log("[dbg]", ...a);

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
  log("logged in, shell mounted");

  // G T to Tasks
  const body = await driver.findElement(By.css("body"));
  await body.sendKeys("g", "t");
  await driver.wait(async () => {
    const h = await driver.findElements(By.css("main h1"));
    if (!h.length) return false;
    return (await h[0].getText()).includes("Tasks");
  }, 20000, "Tasks view never rendered");
  log("Tasks view open");

  // New Task
  const btn = await driver.wait(
    until.elementLocated(By.xpath("//button[contains(., 'New Task') or contains(., 'Add Task')]")),
    10000,
  );
  await btn.click();
  const dialog = await driver.wait(until.elementLocated(By.css("[role='dialog']")), 10000, "no modal");
  log("modal open");
  const modalHtml = await dialog.getAttribute("innerHTML");
  console.log("[dbg][modal-html]", modalHtml.slice(0, 2500).replace(/\s+/g, " "));

  const title = await driver.wait(
    until.elementLocated(By.css('input[placeholder*="itle" i], form input[type="text"], [role="dialog"] input[type="text"]')),
    10000,
  );
  await title.clear();
  await title.sendKeys("E2E debug task");

  const createBtn = await driver.wait(
    until.elementLocated(By.xpath("//form//button[contains(., 'Create')] | //div[@role='dialog']//button[contains(., 'Create')]")),
    10000,
    "no Create button found",
  );
  log("create button text:", JSON.stringify(await createBtn.getText()));
  await createBtn.click();
  await driver.sleep(4000);

  const toasts = await driver.findElements(By.css("[data-sonner-toast], [role='alert'], [role='status']"));
  for (const t of toasts) {
    try { log("toast:", (await t.getText()).slice(0, 300)); } catch {}
  }
  const modalGone = (await driver.findElements(By.css("[role='dialog']"))).length === 0;
  log("modal closed after create:", modalGone);
  const card = await driver.findElements(By.xpath('//*[contains(text(), "E2E debug task")]'));
  log("task card found:", card.length);
  if (!card.length) {
    const main = await driver.findElement(By.css("main"));
    const txt = await main.getText();
    console.log("[dbg][main-text]", txt.slice(0, 1200).replace(/\s+/g, " | "));
  }
  const logs = await driver.manage().logs().get("browser");
  for (const l of logs) console.log("[dbg][console:" + l.level.name + "]", l.message.slice(0, 300));
} finally {
  await driver.quit();
}
