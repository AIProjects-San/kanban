// ---------------------------------------------------------------------------
// Runtime input validation for server actions — barrel.
//
// The schemas live in per-domain files beside this index (common / workspace
// / hr / leave / hiring / payroll / statutory / accounting), split from the
// former 1,580-line lib/validation.ts god-file. "@/lib/validation" keeps
// resolving here, so existing importers are unchanged; new schemas go in
// their domain file.
// ---------------------------------------------------------------------------

export * from "./common";
export * from "./workspace";
export * from "./hr";
export * from "./leave";
export * from "./hiring";
export * from "./payroll";
export * from "./statutory";
export * from "./accounting";
