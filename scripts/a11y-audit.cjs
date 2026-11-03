// One-off analysis tool (PR-39): dump ALL serious/critical axe violations
// with node samples for the authenticated pages. Runs the same dev server +
// Selenium + axe-core stack as the e2e suite. Not part of the gates.
const { Builder, By } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const fs = require("node:fs");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const DEMO_PASSWORD =
  process.env.NEXT_PUBLIC_DEMO_PASSWORD ||
  (fs
    .readFileSync("/home/z/my-project/.env", "utf8")
    .split("\n")
    .find((l) => l.startsWith("NEXT_PUBLIC_DEMO_PASSWORD=")) || "")
    .split("=")[1]
    .trim();

function newestChrome() {
  const dir = "/home/z/.agent-browser/browsers";
  const versions = fs
    .readdirSync(dir)
    .filter((d) => d.startsWith("chrome-"))
    .sort();
  return `${dir}/${versions[versions.length - 1]}/chrome`;
}

const axeSource = fs.readFileSync(
  require.resolve("axe-core/axe.min.js"),
  "utf8",
);

async function scan(driver, label) {
  await driver.sleep(500);
  await driver.executeScript(axeSource);
  const report = await driver.executeAsyncScript(function (tags, cb) {
    window.axe
      .run(document, {
        resultTypes: ["violations"],
        runOnly: { type: "tag", values: tags },
      })
      .then((r) =>
        cb(
          (r.violations || []).map((v) => ({
            id: v.id,
            impact: v.impact,
            nodeCount: v.nodes.length,
            nodes: v.nodes.map((n) => ({ html: n.html.slice(0, 200), target: n.target })),
          })),
        ),
      )
      .catch((e) => cb({ error: String(e) }));
  }, ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  console.log(`\n===== ${label} =====`);
  for (const v of report) {
    console.log(`--- ${v.id} (${v.impact}) × ${v.nodeCount}`);
    for (const n of v.nodes.slice(0, 12)) {
      console.log(`    ${n.html}`);
    }
    if (v.nodeCount > 12) console.log(`    … and ${v.nodeCount - 12} more`);
  }
}

(async () => {
  const options = new chrome.Options();
  options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");
  options.setBinaryPath(newestChrome());
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  try {
    // Login
    await driver.get(BASE);
    const email = await driver.findElement(By.css('input[type="email"]'));
    await email.sendKeys("demo@fernly.app");
    await driver.findElement(By.css('input[type="password"]')).sendKeys(DEMO_PASSWORD);
    await driver.findElement(By.css('button[type="submit"]')).click();
    await driver.sleep(4000);

    await scan(driver, "dashboard");
    for (const [label, key] of [["tasks", "t"], ["team", "m"], ["calendar", "c"]]) {
      const body = await driver.findElement(By.css("body"));
      await body.sendKeys("g", key);
      await driver.sleep(2500);
      await scan(driver, label);
    }
  } finally {
    await driver.quit();
  }
})();
