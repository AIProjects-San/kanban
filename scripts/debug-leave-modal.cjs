// Debug — after submitting a leave request, dump every element matching the
// QA step's "dialog or backdrop" xpath so we can see what lingers.
const { Builder, By, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const BASE = "http://localhost:3000";
const PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD || "fernly123";

function iso(d) { return d.toISOString().slice(0, 10); }
function todayUTC() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; }
function mondayAtLeast(daysOut) {
  const d = todayUTC();
  d.setUTCDate(d.getUTCDate() + daysOut);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

(async () => {
  const options = new chrome.Options();
  options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900");
  if (process.env.CHROME_BIN) options.setBinaryPath(process.env.CHROME_BIN);
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  await driver.manage().setTimeouts({ implicit: 2_000, pageLoad: 20_000 });

  try {
    // login
    await driver.get(BASE);
    const email = await driver.wait(until.elementLocated(By.css('input[type="email"]')), 10_000);
    await email.clear();
    await email.sendKeys("member@fernly.app");
    const pw = await driver.findElement(By.css('input[type="password"]'));
    await pw.clear();
    await pw.sendKeys(PASSWORD);
    await driver.findElement(By.css('button[type="submit"]')).click();
    await driver.wait(until.elementsLocated(By.css("nav, [data-testid='sidebar']")), 15_000);
    console.log("logged in");

    // open Leave view via sidebar
    const leaveNav = await driver.wait(until.elementLocated(By.xpath(`//nav//button[contains(., "Leave")] | //nav//a[contains(., "Leave")]`)), 10_000);
    await leaveNav.click();
    await driver.wait(until.elementLocated(By.xpath("//h1[contains(., 'Leave')]")), 10_000);
    console.log("leave view open");

    // open the request form
    await driver.findElement(By.xpath(`//button[contains(., "Request Leave")]`)).click();
    const typeSel = await driver.wait(until.elementLocated(By.css("#leave-type")), 10_000);
    await driver.executeScript(
      `const el = arguments[0];
       const val = Array.from(el.options).find(o => o.textContent.includes("Annual Leave"))?.value ?? "";
       const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
       setter.call(el, val);
       el.dispatchEvent(new Event('change', { bubbles: true }));`,
      typeSel,
    );
    const monday = mondayAtLeast(42);
    for (const [sel, date] of [["#leave-start", monday], ["#leave-end", new Date(monday.getTime() + 16 * 86400000)]]) {
      const el = await driver.findElement(By.css(sel));
      await driver.executeScript(
        `const el = arguments[0], val = arguments[1];
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(el, val);
         el.dispatchEvent(new Event('input', { bubbles: true }));
         el.dispatchEvent(new Event('change', { bubbles: true }));`,
        el, iso(date),
      );
    }
    const reason = await driver.findElement(By.css("#leave-reason"));
    await reason.clear();
    await reason.sendKeys("QA debug request");
    const submit = await driver.findElement(By.xpath(`//button[contains(., "Submit request")]`));
    console.log("submit enabled:", await submit.isEnabled());
    await submit.click();
    console.log("submitted, waiting for modal to close...");

    try {
      await driver.wait(async () => (await driver.findElements(By.css("#leave-type"))).length === 0, 8_000);
      console.log("modal closed (submit success)");
    } catch {
      console.log("modal STILL OPEN (submit rejected)");
      const toasts = await driver.findElements(By.css("[data-sonner-toast], [role='alert']"));
      for (const t of toasts) console.log("TOAST:", await t.getText());
    }

    // now dump everything matching the QA xpath
    const matches = await driver.findElements(By.xpath(`//div[contains(@class, "backdrop-blur-sm") or @role='dialog']`));
    console.log("xpath matches after submit:", matches.length);
    for (const m of matches) {
      const cls = await m.getAttribute("class");
      const role = await m.getAttribute("role");
      const text = (await m.getText()).slice(0, 80).replace(/\n/g, " | ");
      console.log(`  MATCH class="${cls}" role="${role}" text="${text}"`);
    }
  } finally {
    await driver.quit();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
