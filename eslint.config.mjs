import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Fernly ESLint config.
//
// High-value rules are escalated to ERROR (not just warn) so CI blocks
// new violations. The audit (§9.5 L-P1-24) asked for these to be re-enabled
// with an allow-list of legacy suppressions:
//
//   • @typescript-eslint/no-unused-vars — dead code hides bugs.
//   • react-hooks/exhaustive-deps       — missing deps are the #1 source of
//     stale-closure bugs in React effects.
//   • no-debugger                       — stray debugger statements ship to
//     production and pause execution for anyone with devtools open.
//   • no-fallthrough                    — missing break is almost always a bug.
//   • no-unreachable                    — dead code hides logic errors.
//   • prefer-const                      — `let` that's never reassigned is
//     misleading; `const` communicates intent.

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",

    // React rules
    "react-hooks/exhaustive-deps": "error",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",

    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",

    // General JavaScript rules
    // L-P1-24 — re-enabled high-value rules (were off globally):
    "prefer-const": "error",
    "no-debugger": "error",
    "no-fallthrough": "error",
    "no-unreachable": "error",
    // Still off (need focused cleanup passes — see docs/PRODUCTION_READINESS.md):
    "no-unused-vars": "off", // handled by @typescript-eslint/no-unused-vars above
    "no-console": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off", // TypeScript handles this
    "no-useless-escape": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills/**", "mini-services/**", "tool-results/**", "e2e/**", "coverage/**", "scripts/**", ".analysis/**", ".chrome-e2e/**", ".verify-tmp/**"]
}];

export default eslintConfig;
