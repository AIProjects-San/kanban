// One-shot: build the golden EI fixture from the IRD worked example's
// detail lines (spec §3.4.4) and print it, so the committed fixture is
// byte-exact builder output. Run: npx tsx scripts/make-ei-golden.ts
import { buildEiFile } from "../src/lib/ird/ei-file";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const built = buildEiFile({
  header: {
    employerIrd: "123123123",
    payDate: d("2019-05-22"),
    payeIntermediaryIrd: null,
    contactName: "Bill Smith",
    contactPhone: "041234567",
    contactEmail: "payroll@email.com",
    packageIdentifier: "vendor_package_v1.0",
    irFormVersion: "0001",
  },
  lines: [
    {
      employeeIrd: "111111111", employeeName: "Brown John", taxCode: "M",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 3050, grossCents: 56875, priorGrossAdjCents: 0, notLiableAccCents: 0,
      lumpSumIndicator: "0", payeCents: 34687, priorPayeAdjCents: 0, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 0, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 4550, kiwisaverEmployerNetCents: 3565, esctCents: 756,
      donationsCents: 0, familyTaxCreditCents: 0, shareSchemeCents: 0,
    },
    {
      employeeIrd: "074444444", employeeName: "Cork Chelsea", taxCode: "M",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 3750, grossCents: 65725, priorGrossAdjCents: 0, notLiableAccCents: 0,
      lumpSumIndicator: "0", payeCents: 45695, priorPayeAdjCents: 0, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 0, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 0, kiwisaverEmployerNetCents: 0, esctCents: 0,
      donationsCents: 100, familyTaxCreditCents: 0, shareSchemeCents: 0,
    },
    {
      employeeIrd: "075555555", employeeName: "French Carol", taxCode: "M SL",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 2500, grossCents: 45678, priorGrossAdjCents: 2567, notLiableAccCents: 0,
      lumpSumIndicator: "0", payeCents: 32785, priorPayeAdjCents: 1456, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 2687, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 0, kiwisaverEmployerNetCents: 0, esctCents: 0,
      donationsCents: 0, familyTaxCreditCents: 0, shareSchemeCents: 0,
    },
    {
      employeeIrd: "123123123", employeeName: "Jones Mark", taxCode: "M",
      employmentStart: null, employmentEnd: null,
      periodStart: d("2019-04-07"), periodEnd: d("2019-04-14"), frequency: "WEEKLY",
      hoursPaidCents: 3750, grossCents: 165879, priorGrossAdjCents: 0, notLiableAccCents: 22500,
      lumpSumIndicator: "0", payeCents: 78562, priorPayeAdjCents: 0, childSupportCents: 0,
      childSupportCode: null, studentLoanCents: 0, slcirCents: 0, slborCents: 0,
      kiwisaverEmployeeCents: 4587, kiwisaverEmployerNetCents: 2569, esctCents: 1545,
      donationsCents: 0, familyTaxCreditCents: 0, shareSchemeCents: 22500,
    },
  ],
});

process.stdout.write(built.content);
process.stderr.write(`\n--- totals: ${JSON.stringify(built.totals)}\n`);
