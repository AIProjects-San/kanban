// ---------------------------------------------------------------------------
// G5 — the biometric adapter seam. VENDOR-SPECIFIC adapters (ZKTeco
// ADMS, Suprema SDK, HikVision TCP …) are deliberately NOT written yet —
// they arrive as a follow-up once vendor information lands. What ships
// now is the device-independent contract every adapter must satisfy plus
// the registry they will plug into.
//
// Until a vendor adapter registers itself:
//   • PUSH devices (ADMS_PUSH & friends) already work through the HTTP
//     endpoint (/api/biometric/punch) — pushes don't need fetchPunches.
//   • CSV_IMPORT devices work through the CSV upload (server action
//     importPunchesCsv) — the trivial built-in adapter below covers the
//     protocol.
//   • TCP_POLL / SDK devices are the only ones that NEED a fetch
//     adapter; testConnection reports "not yet available" for them.
// ---------------------------------------------------------------------------

/** The device shape adapters see (structural — a Prisma
 * BiometricDevice row satisfies it; tests can pass a plain object). */
export interface AdapterDevice {
  id: string;
  name: string;
  vendor: string;
  protocol: string;
  serial: string | null;
  location: string | null;
  isActive: boolean;
  config: unknown;
}

/** A punch as a device reports it, pre-mapping (deviceUserId as
 * captured — may not map to an employee). */
export interface RawPunch {
  deviceUserId: string;
  punchedAt: Date;
  direction: "IN" | "OUT" | "UNKNOWN";
  verifyMethod?: string;
  rawPayload: Record<string, unknown>;
}

/**
 * The per-vendor integration contract:
 *
 *  - `fetchPunches` pulls punches since `since` (the TCP_POLL / SDK
 *    polling path). PUSH protocols return an empty array — their punches
 *    arrive via the HTTP endpoint instead.
 *  - `testConnection` validates reachability + configuration; it never
 *    writes punches and never throws ({ ok, error } is the contract).
 */
export interface BiometricAdapter {
  vendor: string;
  protocol: string;
  fetchPunches(device: AdapterDevice, since: Date): Promise<RawPunch[]>;
  testConnection(device: AdapterDevice): Promise<{ ok: boolean; error?: string }>;
}

// ---------------------------------------------------------------------------
// Registry — the follow-up vendor adapters register here (import side
// effect or explicit call from the server action that needs them).
// ---------------------------------------------------------------------------

const registry: BiometricAdapter[] = [];

/** Register a vendor adapter (idempotent per vendor+protocol pair — the
 * latest registration wins). */
export function registerBiometricAdapter(adapter: BiometricAdapter): void {
  const i = registry.findIndex(
    (a) => a.vendor === adapter.vendor && a.protocol === adapter.protocol,
  );
  if (i >= 0) registry[i] = adapter;
  else registry.push(adapter);
}

/** The adapter for a device, or null when no vendor integration has
 * landed yet (the CSV fallback + HTTP push still work without one). */
export function getBiometricAdapter(vendor: string, protocol: string): BiometricAdapter | null {
  for (const a of registry) {
    if (a.vendor === vendor && a.protocol === protocol) return a;
  }
  // The CSV fallback is protocol-level, not vendor-level.
  return protocol === "CSV_IMPORT" ? csvImportAdapter : null;
}

/** The registered (vendor, protocol) pairs — diagnostics/UI. */
export function registeredAdapters(): Array<{ vendor: string; protocol: string }> {
  return registry.map((a) => ({ vendor: a.vendor, protocol: a.protocol }));
}

// ---------------------------------------------------------------------------
// The CSV fallback adapter — protocol CSV_IMPORT for ANY vendor. Punches
// arrive by upload (importPunchesCsv), so there is nothing to fetch and
// no connection to test; it exists so the adapter contract has one
// device-independent implementation on day 1.
// ---------------------------------------------------------------------------

export const csvImportAdapter: BiometricAdapter = {
  vendor: "*",
  protocol: "CSV_IMPORT",
  async fetchPunches(): Promise<RawPunch[]> {
    // CSV punches arrive via upload, never via poll.
    return [];
  },
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  },
};
