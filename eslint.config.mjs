import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// ---------------------------------------------------------------------------
// The Fernly local plugin — rules the upstream plugins do not ship.
// ---------------------------------------------------------------------------

// use-server-async-exports — "use server" files may only export async
// functions. Next.js enforces this in the SWC compiler at BUILD time (the
// LOAN_SETTLEMENT_ACTOR class: a const actor exported from loans.ts surfaced
// only when `next build` refused the file); neither eslint-plugin-next (44
// rules, all rendering/perf) nor eslint-plugin-react-hooks covers it, so the
// class is otherwise invisible until a failed build. This rule flags every
// non-async-function VALUE export from a file whose first statement is the
// "use server" directive. Type-only exports (interface / type alias /
// `export type`) are erased by the TS compiler and are legal — loans.ts's
// `export interface LoanSettlementReport` must stay unflagged.
const fernlyPlugin = {
  rules: {
    "use-server-async-exports": {
      meta: {
        type: "problem",
        docs: {
          description: "Only async functions may be exported from a 'use server' file",
        },
        schema: [],
        messages: {
          notAsync:
            "Only async functions are allowed to be exported in a \"use server\" file — Next's compiler rejects this at build time (the LOAN_SETTLEMENT_ACTOR failure class). Export an async function, or move the value to a non-server module.",
        },
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const program = sourceCode.ast;
        // The directive must be the file's first statement (Next's own rule;
        // comments may precede it, statements may not).
        const first = program.body[0];
        const isUseServer =
          first != null &&
          first.type === "ExpressionStatement" &&
          first.expression.type === "Literal" &&
          first.expression.value === "use server";
        if (!isUseServer) return {};

        // Local top-level names → async-ness, for `export { x }` specifier
        // lists and `export default x` identifier form.
        const asyncByName = new Map();
        for (const node of program.body) {
          if (node.type === "FunctionDeclaration" && node.id) {
            asyncByName.set(node.id.name, node.async === true);
          } else if (node.type === "VariableDeclaration") {
            for (const decl of node.declarations) {
              if (decl.id.type !== "Identifier" || !decl.init) continue;
              const init = decl.init;
              const isAsyncFn =
                init.async === true &&
                (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression");
              asyncByName.set(decl.id.name, isAsyncFn);
            }
          }
        }

        function checkDeclaration(decl) {
          if (!decl) return;
          switch (decl.type) {
            case "FunctionDeclaration":
              if (decl.async !== true) context.report({ node: decl, messageId: "notAsync" });
              return;
            case "TSDeclareFunction": // an overload signature — erased
              return;
            case "VariableDeclaration":
              for (const d of decl.declarations) {
                const init = d.init;
                const isAsyncFn =
                  init != null &&
                  init.async === true &&
                  (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression");
                if (!isAsyncFn) context.report({ node: d, messageId: "notAsync" });
              }
              return;
            case "ClassDeclaration":
            case "TSEnumDeclaration": // a runtime object, not an async function
              context.report({ node: decl, messageId: "notAsync" });
              return;
            case "TSModuleDeclaration":
              if (decl.declare !== true) context.report({ node: decl, messageId: "notAsync" });
              return;
            case "TSInterfaceDeclaration":
            case "TSTypeAliasDeclaration": // type-only — erased, legal
              return;
            default:
              return;
          }
        }

        return {
          ExportNamedDeclaration(node) {
            if (node.exportKind === "type") return; // `export type { X }`
            if (node.source) {
              // A re-export (`export { x } from "..."`) ships values that are
              // not async function declarations of this file.
              context.report({ node, messageId: "notAsync" });
              return;
            }
            if (node.declaration) {
              checkDeclaration(node.declaration);
              return;
            }
            for (const spec of node.specifiers) {
              if (spec.local.type !== "Identifier") continue;
              if (asyncByName.get(spec.local.name) !== true) {
                context.report({ node: spec, messageId: "notAsync" });
              }
            }
          },
          ExportDefaultDeclaration(node) {
            const d = node.declaration;
            if (d.type === "FunctionDeclaration" && d.async === true) return;
            if (d.type === "ArrowFunctionExpression" && d.async === true) return;
            if (d.type === "Identifier" && asyncByName.get(d.name) === true) return;
            context.report({ node, messageId: "notAsync" });
          },
          ExportAllDeclaration(node) {
            context.report({ node, messageId: "notAsync" });
          },
        };
      },
    },
  },
};

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
  plugins: { fernly: fernlyPlugin },
  rules: {
    // Fernly — the "use server" export guard (see the plugin above).
    "fernly/use-server-async-exports": "error",

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
