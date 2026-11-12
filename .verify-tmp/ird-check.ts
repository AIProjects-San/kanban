// Find a mod-11-valid IRD close to the spec's "123-456-789".
import { isValidIrdNumber } from "/home/z/my-project/src/lib/tax-profile-preview.ts";

console.log("spec IRD 123-456-789 valid:", isValidIrdNumber("123-456-789"));
for (let last = 0; last <= 9; last++) {
  const cand = `12345678${last}`;
  if (isValidIrdNumber(cand)) console.log("valid candidate:", cand);
}
for (const c of ["49091850", "583639136"]) console.log(c, "valid:", isValidIrdNumber(c));
