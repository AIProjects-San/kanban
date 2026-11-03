// PR-39 (production-readiness round 2, roadmap §6.11) — axe-core smoke scans.
//
// Injects the real axe-core engine into the page via Selenium's
// executeScript (CDP-injected scripts bypass page CSP in Chrome) and runs
// the WCAG 2.0/2.1 A+AA rule set. The gate is "zero serious or critical
// violations" — moderate/minor findings are tracked, not blocked, because
// several (contrast on decorative badges, best-practice tags) are
// cosmetic. axe-core ships as a transitive dependency of
// eslint-plugin-jsx-a11y, so no new dependency is added.

const { Then } = require("@cucumber/cucumber");
const fs = require("node:fs");
const assert = require("node:assert");

const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

Then("the page passes an axe accessibility scan", async function () {
  const driver = await this.getDriver();

  // Give lazy-rendered content (charts, async rosters) a beat to settle so
  // the scan sees the same DOM the user does.
  await driver.sleep(400);

  // Inject the engine (idempotent: re-defines window.axe per scenario since
  // every scenario gets a fresh driver).
  await driver.executeScript(axeSource);

  const report = await driver.executeAsyncScript(
    function (tags, blockingImpacts, cb) {
      window.axe
        .run(document, {
          resultTypes: ["violations"],
          runOnly: { type: "tag", values: tags },
        })
        .then(function (r) {
          var serious = (r.violations || []).filter(function (v) {
            return blockingImpacts.indexOf(v.impact) !== -1;
          });
          cb({
            url: location.href,
            serious: serious.map(function (v) {
              return {
                id: v.id,
                impact: v.impact,
                help: v.help,
                helpUrl: v.helpUrl,
                nodeCount: v.nodes.length,
                samples: v.nodes.slice(0, 3).map(function (n) {
                  return { html: n.html, target: n.target };
                }),
              };
            }),
            nonBlocking: (r.violations || [])
              .filter(function (v) {
                return blockingImpacts.indexOf(v.impact) === -1;
              })
              .map(function (v) {
                return v.id + "(" + v.impact + ")x" + v.nodes.length;
              }),
          });
        })
        .catch(function (e) {
          cb({ error: String(e) });
        });
    },
    A11Y_TAGS,
    [...BLOCKING_IMPACTS],
  );

  if (!report || report.error) {
    throw new Error(`axe.run failed: ${report ? report.error : "no report"}`);
  }

  // Always record the full picture on the scenario (passing runs too) so
  // moderate/minor debt stays visible in CI artifacts.
  this.attach(
    `axe @ ${report.url}\n` +
      `non-blocking findings: ${report.nonBlocking.length ? report.nonBlocking.join(", ") : "none"}`,
    "text/plain",
  );

  if (report.serious.length > 0) {
    const summary = report.serious
      .map((v) => `${v.id} (${v.impact}, ${v.help}) × ${v.nodeCount}`)
      .join("; ");
    this.attach(
      JSON.stringify(report.serious, null, 2),
      "text/plain",
    );
    assert.fail(
      `axe found ${report.serious.length} serious/critical WCAG violation(s): ${summary}`,
    );
  }
});
