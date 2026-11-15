// Hygiene item 4 — check every demo-seed IRD number against the exact
// isValidIrdNumber algorithm from src/lib/tax-profile-preview.ts.
const isValidIrdNumber = (raw: string): boolean => {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return true;
  if (!/^\d{8,9}$/.test(digits)) return false;
  const n = digits.padStart(9, "0").split("").map(Number);
  const weightsA = [3, 2, 7, 6, 5, 4, 3, 2];
  const weightsB = [7, 4, 3, 2, 5, 2, 7, 6];
  const checkDigit = (weights: number[]): number => {
    const sum = weights.reduce((acc, w, i) => acc + w * n[i], 0);
    const rem = sum % 11;
    if (rem === 0) return 10;
    return rem === 1 ? 0 : 11 - rem;
  };
  let c = checkDigit(weightsA);
  if (c === 10) c = checkDigit(weightsB);
  return c === n[8];
};

const seedIreds: Array<[string, string]> = [
  ["manager@fernly.app", "583639136"],
  ["hana@fernly.app", "752783373"],
  ["yuki@fernly.app", "760841838"],
  ["soren@fernly.app", "915801951"],
  ["diego@fernly.app", "566400642"],
  ["kofi@fernly.app", "561381593"],
  // known-good / known-bad pairs from tax-admin.test.ts (sanity anchors)
  ["anchor-good", "583639136"],
  ["anchor-bad", "583639137"],
  // user-suggested example
  ["user-example", "123456785"],
];

for (const [who, ird] of seedIreds) {
  console.log(`${who.padEnd(22)} ${ird}  ${isValidIrdNumber(ird) ? "VALID" : "INVALID"}`);
}

// If any are invalid, compute the correct check digit for that base.
const fixCheckDigit = (base8: string): string => {
  const n = base8.padStart(9, "0").split("").map(Number);
  const weightsA = [3, 2, 7, 6, 5, 4, 3, 2];
  const weightsB = [7, 4, 3, 2, 5, 2, 7, 6];
  const cd = (weights: number[]): number => {
    const sum = weights.reduce((acc, w, i) => acc + w * n[i], 0);
    const rem = sum % 11;
    if (rem === 0) return 10;
    return rem === 1 ? 0 : 11 - rem;
  };
  let c = cd(weightsA);
  if (c === 10) c = cd(weightsB);
  return c.toString();
};
for (const [who, ird] of seedIreds) {
  if (!isValidIrdNumber(ird)) {
    const base = ird.slice(0, -1);
    console.log(`fix: ${who} ${ird} -> ${base}${fixCheckDigit(base)}`);
  }
}

// The UI placeholder IRD (employee-tax-profile-view.tsx).
console.log(`\nplaceholder 49091850 -> ${isValidIrdNumber("49091850") ? "VALID" : "INVALID"}`);
