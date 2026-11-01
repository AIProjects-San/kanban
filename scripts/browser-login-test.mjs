// Browser login reproduction — drives the REAL login form with headless Chrome.
// Prints: whether <main> (authenticated shell) appears, timing, page source on
// failure, and browser console logs (hydration/JS errors are visible there).
import { Builder, By, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.DEMO_EMAIL || "demo@fernly.app";
const PW = process.env.DEMO_PW || "";
const CHROME_BIN =
  process.env.CHROME_BIN ||
  "/tmp/browsers/chrome/linux-156.0.8078.80/chrome-linux64/chrome";

const options = new chrome.Options();
options.setBinaryPath(CHROME_BIN);
options.addArguments(
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1440,900",
);

const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();

async function dumpDiagnostics(tag) {
  try {
    const logs = await driver.manage().logs().get("browser");
    for (const l of logs) console.log(`[${tag}][console:${l.level.name}]`, l.message.slice(0, 400));
  } catch (e) {
    console.log(`[${tag}] console logs unavailable: ${e.message}`);
  }
  const url = await driver.getCurrentUrl();
  console.log(`[${tag}] url: ${url}`);
  const toasts = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
  for (const t of toasts) {
    try { console.log(`[${tag}][toast]`, (await t.getText()).slice(0, 200)); } catch {}
  }
  const src = await driver.getPageSource();
  console.log(`[${tag}][page-source:${src.length} bytes] head:`);
  console.log(src.slice(0, 1500).replace(/\s+/g, " "));
}

try {
  const t0 = Date.now();
  await driver.get(BASE);
  const email = await driver.wait(
    until.elementLocated(By.css('input[type="email"]')),
    30_000,
    "no email field — login screen never rendered",
  );
  console.log(`login screen after ${Date.now() - t0} ms`);
  await email.clear();
  await email.sendKeys(EMAIL);
  await driver.findElement(By.css('input[type="password"]')).sendKeys(PW);
  await driver.findElement(By.css('button[type="submit"]')).click();

  const t1 = Date.now();
  try {
    await driver.wait(until.elementLocated(By.css("main")), 30_000, "<main> never appeared");
    console.log(`LOGIN_OK — <main> appeared ${Date.now() - t1} ms after submit`);
    const h1 = await driver.findElements(By.css("main h1"));
    if (h1.length) console.log("main h1:", (await h1[0].getText()).slice(0, 80));
  } catch (e) {
    console.log("LOGIN_FAIL:", e.message);
    await dumpDiagnostics("fail");
    process.exitCode = 1;
  }
} catch (e) {
  console.log("SETUP_FAIL:", e.message);
  try { await dumpDiagnostics("setup"); } catch {}
  process.exitCode = 1;
} finally {
  await driver.quit();
}
