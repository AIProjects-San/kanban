// ---------------------------------------------------------------------------
// Phase 2 — the pay cycle code map (spec §3.4.1.2 field 9: WK, 4W, FT,
// MT, DA, AH, HM). Every Fernly cadence that files maps to a confirmed
// code; QUARTERLY/ANNUAL refuse (no confirmed code — never a guess).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { isFilingCadence, mapPayCycle, PAY_CYCLE_CODES } from "../pay-cycle";

describe("mapPayCycle", () => {
  it("WEEKLY → WK (the IRD worked example's code)", () => {
    expect(mapPayCycle("WEEKLY")).toBe("WK");
  });

  it("FORTNIGHTLY → FT (NOT the task brief's tentative FN — spec-confirmed)", () => {
    expect(mapPayCycle("FORTNIGHTLY")).toBe("FT");
  });

  it("MONTHLY → MT", () => {
    expect(mapPayCycle("MONTHLY")).toBe("MT");
  });

  it("BIMONTHLY → HM — Fernly's bimonthly is twice a month (1st–15th / 16th–end), the spec's 'Half monthly (HM) (twice a month)', NOT four-weekly", () => {
    expect(mapPayCycle("BIMONTHLY")).toBe("HM");
  });

  it("DAILY → DA", () => {
    expect(mapPayCycle("DAILY")).toBe("DA");
  });

  it("QUARTERLY refuses — no confirmed pay cycle code exists", () => {
    expect(() => mapPayCycle("QUARTERLY")).toThrow(/pay cycle code/i);
  });

  it("ANNUAL refuses — no confirmed pay cycle code exists", () => {
    expect(() => mapPayCycle("ANNUAL")).toThrow(/pay cycle code/i);
  });

  it("unknown cadences refuse", () => {
    expect(() => mapPayCycle("WHENEVER")).toThrow(/pay cycle code/i);
  });

  it("the closed code set matches the spec's list exactly", () => {
    expect([...PAY_CYCLE_CODES].sort()).toEqual(["4W", "AH", "DA", "FT", "HM", "MT", "WK"]);
  });

  it("isFilingCadence gates the UI", () => {
    for (const f of ["WEEKLY", "FORTNIGHTLY", "MONTHLY", "BIMONTHLY", "DAILY"]) {
      expect(isFilingCadence(f)).toBe(true);
    }
    expect(isFilingCadence("QUARTERLY")).toBe(false);
    expect(isFilingCadence("ANNUAL")).toBe(false);
  });
});
