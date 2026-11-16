import type { NextConfig } from "next";

// ---------------------------------------------------------------------------
// R-P0-6 (REVIEW_TRIAGE §4.5-6) — demo-credential build gate.
//
// NEXT_PUBLIC_DEMO_PASSWORD is dev/demo-only by contract (docs/SECURITY.md:
// its single home is .env). Because NEXT_PUBLIC_* vars are inlined into the
// client bundle at build time, a PRODUCTION build that sets it ships the
// credential string to every browser — the exact L-P0-12 failure mode the
// literal purge fixed. Chosen behavior (documented): the build FAILS, loudly
// and by name, at config evaluation — the earliest moment the mistake is
// detectable, before a single chunk is emitted.
//
// The one legitimate production-mode build with demo credentials is the
// sandbox demo preview, which opts in EXPLICITLY with
// ALLOW_DEMO_CREDENTIALS_IN_BUILD=1 (healed into .env by
// scripts/restore-preview.sh, documented in .env.example). The hatch is the
// difference between "the demo preview builds demo credentials on purpose"
// and "someone's prod pipeline leaked a demo var" — the latter now fails.
// ---------------------------------------------------------------------------
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PUBLIC_DEMO_PASSWORD &&
  process.env.ALLOW_DEMO_CREDENTIALS_IN_BUILD !== "1"
) {
  throw new Error(
    "[build] FATAL: NEXT_PUBLIC_DEMO_PASSWORD is set in a production build — " +
      "demo credentials must never ship in the client bundle. " +
      "Unset it (demo credentials are a dev/.env-only concern), or, for the " +
      "sandbox demo preview ONLY, set ALLOW_DEMO_CREDENTIALS_IN_BUILD=1.",
  );
}

// ---------------------------------------------------------------------------
// Server Actions allowed origins — environment-driven split (audit §1.15).
//
// Preview deployments (*.space-z.ai, *.fcapp.run) and local development need
// their origins listed because the reverse proxy presents a different host
// than the Next.js server sees. A production deployment should NOT widen the
// list to include preview domains, so the list is now env-driven:
//
//   SERVER_ACTIONS_ALLOWED_ORIGINS="app.example.com,staging.example.com"
//
// R-P0-6 — the split is now mode-aware:
//   • development (and test) keep the conservative preview/dev default —
//     dev behavior is UNCHANGED.
//   • production with the env UNSET defaults to NO additional origins
//     (same-origin only — never a wildcard), and the startup hook logs a
//     warning telling the operator to set the env explicitly
//     (src/instrumentation-node.ts). The deployment's own origin is always
//     implicitly allowed; the list only adds proxy origins.
// Origins are comma-separated; each entry may be a glob (leading `*.`).
const envOrigins = process.env.SERVER_ACTIONS_ALLOWED_ORIGINS;
const isProdBuild = process.env.NODE_ENV === "production";
const serverActionsAllowedOrigins = envOrigins
  ? envOrigins
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
  : isProdBuild
    ? []
    : [
        "*.space-z.ai",
        "*.fcapp.run",
        "localhost:3000",
        "localhost:81",
        "127.0.0.1:3000",
      ];

// ---------------------------------------------------------------------------
// Static security headers. These apply to ALL routes as a base layer.
// CSP is included here as a fallback for routes the proxy middleware doesn't
// cover (API routes, static assets). The proxy (src/proxy.ts) OVERRIDES the
// CSP on app pages with a nonce-based policy that drops 'unsafe-inline'
// from script-src — see P1 production-readiness re-audit.
// ---------------------------------------------------------------------------

// Fallback CSP — restrictive. API routes don't serve HTML so script-src is
// irrelevant; this is just defense-in-depth for any route the proxy misses.
// PR-06 (production-readiness audit) — connect-src no longer contains the
// bare `https:` scheme-source (which allowed exfiltration to any HTTPS host).
const fallbackCspDirectives = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
];
if (process.env.REPORT_URI) {
  fallbackCspDirectives.push(`report-uri ${process.env.REPORT_URI}`);
  fallbackCspDirectives.push("report-to csp-endpoint");
}
const fallbackCsp = fallbackCspDirectives.join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // allowedDevOrigins — dev-server origin gate. Setting this key REPLACES the
  // implicit localhost/127.0.0.1 allowance, so the loopback hosts must be
  // listed explicitly or Next 16 dev origin-blocks its own HMR websocket
  // (ERR_INVALID_HTTP_RESPONSE) and dev resources from the browser, which
  // silently stalls client hydration — the page server-renders but never
  // becomes interactive (found via agent-browser while verifying the post
  // PR-49 SSR fix; bare hostnames cover any port).
  allowedDevOrigins: ["*.space-z.ai", "*.fcapp.run", "localhost", "127.0.0.1"],
  async headers() {
    // HSTS (PR-36, production-readiness round 2 — roadmap §6.4): one year.
    // `includeSubDomains` and `preload` are OPT-IN via env because they are
    // irreversible commitments: flipping them on before every subdomain of
    // the host serves HTTPS breaks those subdomains for visitors who
    // received the header (and preload removal takes months). Operators
    // confirm readiness by setting:
    //   HSTS_INCLUDE_SUBDOMAINS=1
    //   HSTS_PRELOAD=1        (implies includeSubDomains; also submit the
    //                           site to hstspreload.org afterwards)
    const hsts = ["max-age=31536000"];
    if (process.env.HSTS_INCLUDE_SUBDOMAINS === "1" || process.env.HSTS_PRELOAD === "1") {
      hsts.push("includeSubDomains");
    }
    if (process.env.HSTS_PRELOAD === "1") {
      hsts.push("preload");
    }
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: hsts.join("; ") },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      { key: "X-DNS-Prefetch-Control", value: "on" },
      // Fallback CSP — overridden by the proxy on app pages with nonce-based
      // policy. Kept here for API routes + static assets that the proxy
      // doesn't cover.
      { key: "Content-Security-Policy", value: fallbackCsp },
    ];
    // The Report-To group is only meaningful when a collector is configured.
    if (process.env.REPORT_URI) {
      securityHeaders.push({
        key: "Report-To",
        value: JSON.stringify({ group: "csp-endpoint", max_age: 86400, endpoints: [{ url: process.env.REPORT_URI }] }),
      });
    }
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  experimental: {
    serverActions: {
      // Next.js 16 blocks Server Actions when the `origin` header doesn't match
      // `x-forwarded-host`. In preview/reverse-proxy environments these differ
      // (user-facing host vs internal gateway host), so we allow both patterns.
      allowedOrigins: serverActionsAllowedOrigins,
    },
  },
};

export default nextConfig;
