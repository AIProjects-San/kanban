import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Fernly ESLint config.
//
// Two high-value rules are escalated to ERROR (not just warn) so CI blocks
// new violations. Both were previously disabled globally; this pass cleaned
// up the 36 existing violations and now blocks regressions:
//
//   • @typescript-eslint/no-unused-vars — dead imports/vars/args hide bugs
//     and bloat the bundle. Underscore-prefixed names (_x) are allowed.
//   • react-hooks/exhaustive-deps       — missing deps are the #1 source of
//     stale-closure bugs in React effects.
//
// Other rules remain off — they are tracked as future work in
// docs/CODE_REVIEW.md §6 (item 5: "Re-enable incrementally with an
// allow-list of legacy suppressions; do not bulk-flip without a dedicated
// pass"). Each of those needs its own focused cleanup pass before it can
// be turned on without breaking CI.

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
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills/**", "mini-services/**", "tool-results/**", "e2e/**", "coverage/**", "scripts/**"]
}];

export default eslintConfig;
