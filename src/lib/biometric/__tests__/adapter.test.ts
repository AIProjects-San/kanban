import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// G5 — the adapter seam: the interface contract (a mock adapter satisfies
// it), the registry, and the CSV fallback adapter. NO vendor-specific
// adapter is registered — that is the pinned follow-up constraint.
// ---------------------------------------------------------------------------

import {
  csvImportAdapter,
  getBiometricAdapter,
  registerBiometricAdapter,
  registeredAdapters,
  type BiometricAdapter,
  type AdapterDevice,
  type RawPunch,
} from "../adapter";

const device: AdapterDevice = {
  id: "dev1",
  name: "Front door scanner",
  vendor: "ZKTECO",
  protocol: "ADMS_PUSH",
  serial: "SN-1",
  location: "Auckland",
  isActive: true,
  config: null,
};

/** A device-independent mock — proves the contract is implementable
 * without any vendor knowledge (the interface test the spec asks for). */
const mockAdapter: BiometricAdapter = {
  vendor: "MOCKVENDOR",
  protocol: "TCP_POLL",
  async fetchPunches(d: AdapterDevice, since: Date): Promise<RawPunch[]> {
    return [
      {
        deviceUserId: "1001",
        punchedAt: since,
        direction: "IN",
        verifyMethod: "FINGERPRINT",
        rawPayload: { device: d.id, source: "mock" },
      },
    ];
  },
  async testConnection(d: AdapterDevice) {
    return d.isActive ? { ok: true } : { ok: false, error: "inactive" };
  },
};

describe("the BiometricAdapter contract", () => {
  it("a mock adapter satisfies the interface and behaves", async () => {
    const punches = await mockAdapter.fetchPunches(device, new Date("2026-11-09T20:00:00Z"));
    expect(punches).toHaveLength(1);
    expect(punches[0].deviceUserId).toBe("1001");
    expect(punches[0].direction).toBe("IN");
    await expect(mockAdapter.testConnection(device)).resolves.toEqual({ ok: true });
    await expect(mockAdapter.testConnection({ ...device, isActive: false })).resolves.toEqual({
      ok: false,
      error: "inactive",
    });
  });
});

describe("the registry", () => {
  it("returns null for vendors without an adapter (the pinned follow-up state)", () => {
    expect(getBiometricAdapter("ZKTECO", "ADMS_PUSH")).toBeNull();
    expect(getBiometricAdapter("SUPREMA", "SDK")).toBeNull();
    expect(getBiometricAdapter("HIKVISION", "TCP_POLL")).toBeNull();
  });

  it("falls back to the CSV adapter for ANY vendor on the CSV_IMPORT protocol", () => {
    expect(getBiometricAdapter("ZKTECO", "CSV_IMPORT")).toBe(csvImportAdapter);
    expect(getBiometricAdapter("OTHER", "CSV_IMPORT")).toBe(csvImportAdapter);
  });

  it("registers + resolves vendor adapters, replacing on re-registration", () => {
    registerBiometricAdapter(mockAdapter);
    expect(getBiometricAdapter("MOCKVENDOR", "TCP_POLL")).toBe(mockAdapter);
    expect(registeredAdapters()).toContainEqual({ vendor: "MOCKVENDOR", protocol: "TCP_POLL" });

    const replacement: BiometricAdapter = { ...mockAdapter, vendor: "MOCKVENDOR" };
    registerBiometricAdapter(replacement);
    expect(getBiometricAdapter("MOCKVENDOR", "TCP_POLL")).toBe(replacement);
    expect(registeredAdapters().filter((a) => a.vendor === "MOCKVENDOR")).toHaveLength(1);
  });
});

describe("the CSV fallback adapter", () => {
  it("fetches nothing (CSV arrives by upload) and always tests OK", async () => {
    await expect(csvImportAdapter.fetchPunches(device, new Date())).resolves.toEqual([]);
    await expect(csvImportAdapter.testConnection(device)).resolves.toEqual({ ok: true });
  });
});
