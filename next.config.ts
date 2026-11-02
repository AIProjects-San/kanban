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

// ---------------------------------------------------------------------------
// Static security headers. These apply to ALL routes as a base layer.
// CSP is included here as a fallback for routes the proxy middleware doesn't
// cover (API routes, static assets). The proxy (src/proxy.ts) OVERRIDES the
// CSP on app pages with a nonce-based policy that drops 'unsafe-inline'
// from script-src — see P1 production-readiness re-audit.
// ---------------------------------------------------------------------------

// Fallback CSP — restrictive. API routes don't serve HTML so script-src is
// irrelevant; this is just defense-in-depth for any route the proxy misses.
const fallbackCspDirectives = [
  "default-src 'self'",
  "script-src 'self'",
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
  fallbackCspDirectives.push(`report-uri ${process.env.REPORT_URI}`);
  fallbackCspDirectives.push("report-to csp-endpoint");
}
const fallbackCsp = fallbackCspDirectives.join("; ");

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
