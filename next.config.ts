import type { NextConfig } from "next";

const serverActionsAllowedOrigins = [
  "*.space-z.ai",
  "*.fcapp.run",
  "localhost:3000",
  "localhost:81",
  "127.0.0.1:3000",
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  allowedDevOrigins: ["*.space-z.ai", "*.fcapp.run"],
  async headers() {
    const securityHeaders = [
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
        value: [
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
        ].join("; "),
      },
    ];
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
