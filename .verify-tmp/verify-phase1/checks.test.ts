import { calculatePaye } from "@/lib/payroll/nz/paye";
import { calculateKiwiSaver, resolveKiwiSaverStatus } from "@/lib/payroll/nz/kiwisaver";
import { calculateStudentLoan } from "@/lib/payroll/nz/student-loan";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const t = (label: string, actual: any, expected: any) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else    { fail++; console.log(`FAIL  ${label}  expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`); }
};

async function main() {
  const year = await prisma.taxYear.findFirst({ where: { label: "2026-27" } });
  if (!year) { console.log("FAIL  TaxYear 2026-27 missing"); process.exit(1); }
  const slabs = await prisma.taxSlab.findMany({ where: { taxYearId: year.id } });
  const rules = await prisma.statutoryRule.findMany({ where: { taxYearId: year.id } });
  const accRate = Number((rules.find(r => r.category === "ACC" && r.key === "RATE")?.value as any)?.rate);
  const accCap = Number((rules.find(r => r.category === "ACC" && r.key === "EARNINGS_CAP")?.value as any)?.cap);
  const accMax = Number((rules.find(r => r.category === "ACC" && r.key === "MAX_LEVY")?.value as any)?.maxLevy);
  const accRule = { rate: accRate, cap: accCap, maxLevy: accMax };

  const mk = (o: any = {}) => ({
    taxCode: "M", studentLoan: false, kiwiSaverStatus: "NOT_ENROLLED",
    kiwiSaverEmployeeRate: 3.5, kiwiSaverEmployerRate: 3.5,
    esctRateOverride: null, taxCodeSpecialRate: null, stcAccTreatment: "INC",
    stcStudentLoanRate: null, employmentType: "PERMANENT",
    casualHolidayPayInWages: false, employmentStartDate: null, ...o,
  });

  const paye = (gross: number, freq: string, p: any = mk()) => {
    const r = calculatePaye({ gross, frequency: freq, taxProfile: p, slabs, accRule });
    return { tax: r2(r.tax), acc: r2(r.acc), total: r2(r.total) };
  };

  t("M weekly $1,000",       paye(1000, "WEEKLY"),      { tax: 154.00,  acc: 17.50,   total: 171.50 });
  t("M monthly $5,000",      paye(5000, "MONTHLY"),     { tax: 851.71,  acc: 87.50,   total: 939.21 });

  console.log(`\nCALC CHECKS: PASS=${pass} FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
