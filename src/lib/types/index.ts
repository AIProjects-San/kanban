// Shared Fernly types — mirror Prisma models but client-safe.
//
// Barrel only: the definitions live in per-domain files beside this index
// (workspace / hr / leave / hiring / payroll / statutory), split from the
// former 1,448-line god-file. "@/lib/types" keeps resolving here, so
// existing importers are unchanged; new types go in their domain file.

export * from "./workspace";
export * from "./hr";
export * from "./leave";
export * from "./hiring";
export * from "./payroll";
export * from "./statutory";
