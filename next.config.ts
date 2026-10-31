import type { NextConfig } from "next";

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
// When unset we keep the previous conservative default (localhost dev +
// preview product domains) so existing preview behaviour is unchanged.
// Origins are comma-separated; each entry may be a glob (leading `*.`).
const envOrigins = process.env.SERVER_ACTIONS_ALLOWED_ORIGINS;
const serverActionsAllowedOrigins = envOrigins
  ? envOrigins
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
  : [
      "*.space-z.ai",
      "*.fcapp.run",
      "localhost:3000",
      "localhost:81",
      "127.0.0.1:3000",
    ];

// Optional CSP violation reporting (audit §1.15 / launch gate 5: "CSP report
// clean for 24h on staging"). Set REPORT_URI to your collector endpoint
// (Sentry, report-uri.com, a self-hosted sink) and violations will be
// delivered there while the policy itself stays enforced.
const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
];
if (process.env.REPORT_URI) {
  cspDirectives.push(`report-uri ${process.env.REPORT_URI}`);
  // report-to is the modern successor; harmless alongside report-uri.
  cspDirectives.push("report-to csp-endpoint");
}

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  allowedDevOrigins: ["*.space-z.ai", "*.fcapp.run"],
  async headers() {
    const securityHeaders = [
      // HSTS: only meaningful over HTTPS; the preview/production proxy
      // terminates TLS in front of this app. One year, no subdomains —
      // tighten to includeSubDomains once the whole host is HTTPS-only.
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      { key: "X-DNS-Prefetch-Control", value: "on" },
      // NOTE: 'unsafe-inline'/'unsafe-eval' are required by Next.js's inline
      // bootstrap and (in dev) HMR. A nonce- or hash-based CSP is the next
      // hardening step — see docs/SECURITY.md.
      {
        key: "Content-Security-Policy",
        value: cspDirectives.join("; "),
      },
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
