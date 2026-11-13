# IRD Sign-off — NZ Statutory Payroll Engine (Phases 0–4)

**Status: PENDING — BLOCKING GATE.** No production deployment (or merge of the
statutory engine into a release branch) may proceed until a named human
verifier has checked every rate and threshold below against the Inland
Revenue (IRD) website and signed this document. This is not a checklist item
to tick by proxy: the verifier must open each cited IRD page themselves,
compare the published figure against the "Seeded value" column, and record
the date they checked.

- **What is being signed off:** every statutory parameter the engine consumes,
  as seeded by `prisma/seed/nz-statutory.ts` for the tax year
  **1 April 2026 – 31 March 2027** and frozen per pay run via
  `PayrollRun.rateSetId` + `Payslip.statutory`.
- **Where the values live:** `prisma/seed/nz-statutory.ts` (seed),
  `prisma/schema.prisma` (StatutoryRateSet family), `src/lib/payroll/nz/`
  (engine), `src/lib/payroll/nz/__tests__/golden.test.ts` (acceptance).
- **Machine verification already done (2026-11-12, not a substitute for the
  human gate):** the official IRD booklets **IR341 Apr 2026** (four-weekly and
  monthly PAYE deduction tables) and **IR340 Apr 2026** (weekly and fortnightly)
  were downloaded from ird.govt.nz and their printed rows cross-checked against
  the engine — see "Machine-verification log" below. The booklets are the
  IRD's own arithmetic; the web pages cited per row are the canonical source a
  human verifier should open.

---

## 1. Rate inventory — verify each row against the cited IRD page

### 1.1 PAYE income tax slabs (primary codes M / ME)

Marginal rates on annualised income; income exactly at a boundary keeps the
lower rate on every dollar below it.

| # | Parameter | Seeded value | IRD source to open |
|---|---|---|---|
| 1 | Tier 1 rate / upper bound | **10.5%** up to **$15,600** | ird.govt.nz — "Tax rates for individuals" (income tax rates table) |
| 2 | Tier 2 rate / bounds | **17.5%** $15,600–$53,500 | same page |
| 3 | Tier 3 rate / bounds | **30%** $53,500–$78,100 | same page |
| 4 | Tier 4 rate / bounds | **33%** $78,100–$180,000 | same page |
| 5 | Tier 5 rate | **39%** above $180,000 | same page |

Cross-checks already run: IR341 monthly $15,000 M = $4,334.89 (slab tax
$4,106.46 + levy $228.43) reproduces tiers 1–4 exactly; the four-weekly
$14,700 row ($4,334.44) reproduces the 39% top tier.

### 1.2 Secondary tax code rates (flat, "before ACC levies" — the levy is added on top)

| # | Code | Seeded rate | IRD source to open |
|---|---|---|---|
| 6 | SB | **10.5%** | ird.govt.nz — "Tax codes and tax rates for individuals" (secondary employment rates) |
| 7 | S | **17.5%** | same page |
| 8 | SH | **30%** | same page |
| 9 | ST | **33%** | same page |
| 10 | SA | **39%** | same page |
| 11 | ND (no IR330 given) | **45% + ACC levy** | ird.govt.nz — "Deductions from salary or wages" ("45% plus ACC earners' levy") |

Cross-checks already run: IR340 weekly secondary $1,000 row prints
SB 122.50 / S 192.50 / SH 317.50 / ST 347.50 / SA 407.50 — each equals
(rate + 1.75%) × pay.

### 1.3 ACC earners' levy

| # | Parameter | Seeded value | IRD source to open |
|---|---|---|---|
| 12 | Levy rate | **1.75%** (1.75c per $1) | ird.govt.nz — "ACC earners' levy rates" (1 April 2026 – 31 March 2027 row) |
| 13 | Maximum liable earnings | **$156,641** / year | same page |
| 14 | Maximum levy | **$2,741.22** / year | same page |

Per-period capping rule (engine): levy = 1.75% × min(period earnings,
$156,641 ÷ pays-per-year). Cross-check already run: IR341 monthly $15,000
levy component = **$228.43** (= 1.75% × $13,053.42). Note for the verifier:
$2,741.22 ÷ 12 = $228.435 → $228.44 if the ANNUAL maximum is divided and
rounded; IRD's printed table uses the capped-earnings form ($228.43). The
engine matches the printed table — flag if you disagree with this choice.

### 1.4 Independent Earner Tax Credit (ME code only, never casual)

| # | Parameter | Seeded value | IRD source to open |
|---|---|---|---|
| 15 | Annual credit | **$520** | ird.govt.nz — "Independent Earner Tax Credit" |
| 16 | Lower income bound | **$24,000** (no credit below) | same page |
| 17 | Abatement threshold | **$66,000** | same page |
| 18 | Abatement rate / exhaustion | **13c per $1**, gone at **$70,000** | same page |

Cross-checks already run: IR341/IR340 ME columns = M − $43.33 (monthly) /
M − $10.00 (weekly) = $520 ÷ periods.

### 1.5 KiwiSaver

| # | Parameter | Seeded value | IRD source to open |
|---|---|---|---|
| 19 | Default employee rate (auto-enrolment, no election) | **3.5%** | ird.govt.nz — "KiwiSaver rates" / IR341 Apr 2026 p.4: "If your employee has been automatically enrolled, the default KiwiSaver rate is 3.5%." Re-verified 2026-11-13 — see §2 log. |
| 20 | Allowed employee rates | **3 / 3.5 / 4 / 6 / 8 / 10%** | same page (IR341 prints deduction columns 3.5/4/6/8/10; 3% is the temporary rate-reduction rate, held via IRD certificate — IRD news "Changes to the KiwiSaver contribution rate", Jan 2026) |
| 21 | Compulsory employer contribution | **3.5%** minimum | ird.govt.nz — "KiwiSaver for employers" / IR341 p.4: "you must contribute a minimum of 3.5%". Re-verified 2026-11-13 — see §2 log. |

Auto-enrolment time rules (engine `kiwisaver.ts`):

| # | Rule | Seeded behaviour | IRD source to open |
|---|---|---|---|
| 22 | Temporary employment | auto-enrol from **day 29** (start + 28 days) | ird.govt.nz — "Opting in and enrolling temporary and casual employees" |
| 23 | Casual employment | exempt while **holiday pay is paid with wages**; may opt in | same page |
| 24 | Casual agricultural | exempt under **3 months**, enrolled beyond | same page |
| 25 | NSW (recognised seasonal worker) | **not eligible** (non-resident) | ird.govt.nz — tax code NSW |

### 1.6 ESCT (employer superannuation contribution tax)

Bands on annual salary + GROSS employer contributions (previous tax year, or
the estimate method). Upper bounds inclusive.

| # | Band | Seeded rate | IRD source to open |
|---|---|---|---|
| 26 | $0 – $18,720 | **10.5%** | ird.govt.nz — "ESCT rates" / IR341 Apr 2026 p.4 table |
| 27 | $18,721 – $64,200 | **17.5%** | same |
| 28 | $64,201 – $93,720 | **30%** | same |
| 29 | $93,721 – $216,000 | **33%** | same |
| 30 | $216,001 + | **39%** | same |

Cross-check already run: IR341 CEC band pairs at monthly $5,000 (175 →
30.62/144.38 printed = 17.5% band) and monthly $15,000 (525 → 173.25/351.75
= 33% band).

### 1.7 Student loan (SL suffix)

| # | Parameter | Seeded value | IRD source to open |
|---|---|---|---|
| 31 | Repayment rate | **12%** | ird.govt.nz — "Repaying my student loan" |
| 32 | Annual repayment threshold | **$24,128** | same page (2027 tax year threshold) |
| 33 | Secondary income | 12% of **every dollar** (no threshold) | IR341 p.4: "the repayment threshold does not apply to secondary income" |

Per-period threshold rule (engine): $24,128 ÷ pays-per-year, truncated to
cents — monthly **$2,010.66**, weekly **$464.00**, fortnightly $928.00,
four-weekly $1,856.00. Cross-checks already run: IR341 monthly $3,000 SL =
$118.72 and monthly $5,000 SL = $358.72; IR340 weekly $500 SL = $4.32.

### 1.8 Tax code vocabulary (IR330)

M, ME, SB, S, SH, ST, SA, ND, STC (IR23 tailored code), CAE (casual
agricultural), NSW (recognised seasonal worker), EDW (election day), each
optionally " SL"-suffixed. Source: ird.govt.nz — "Tax codes" (IR330).
STC handling: the IR23 certificate's tailored rate replaces PAYE (default
ACC treatment INC — certificate rate includes the levy; PLUS adds it);
`stcStudentLoanRate` (0–12c/$) replaces the standard SL rate. Source:
ird.govt.nz — "Tailored tax codes" (IR23).

---

## 2. Machine-verification log (2026-11-12 — supplementary, not the gate)

Downloaded from ird.govt.nz and cross-checked row-by-row against the engine:

| Booklet | Rows checked | Result |
|---|---|---|
| **IR341 Apr 2026** (four-weekly & monthly tables, 2027 tax year) | monthly $15,000 M (4,334.89 = 4,106.46 + 228.43); monthly $5,000 M/ME/SL/KS/CEC (939.20 printed — see §3); monthly $3,000 SL (118.72); monthly $2,000 ME; four-weekly $14,700 M (4,334.44); secondary monthly $5,000 (SB…SA); ESCT band table p.4; KS default/CEC minimum notes p.4; SL threshold notes p.4 | all match the seeded rates |
| **IR340 Apr 2026** (weekly & fortnightly tables, 2027 tax year) | weekly $1,000 M (171.50) + secondary row (122.50/192.50/317.50/347.50/407.50); weekly $500 M (75.25) + SL (4.32) | all match |

**KiwiSaver rate re-verification (2026-11-13, P0 pre-filing — machine
check, not the human gate).** Opened and checked against rows 19–21:
ird.govt.nz "KiwiSaver changes", "Employee contributions" ("The default
rate is 3.5% if you do not choose a higher rate"), "Employer contributions
to KiwiSaver and complying funds" (Jul 2026: "either 3.5%, 4%, 6%, 8% or
10%"), the IRD news item "Changes to the KiwiSaver contribution rate"
(Jan 2026 — temporary rate reductions to hold a sub-3.5% rate via
certificate), plus two downloaded PDFs: the **Payroll Calculations &
Business Rules Specification 2026** ("3% to 3.5% with effect for payday's
on or after 1 April 2026"; employer "must contribute 3.5%"; members "can
contribute 3.5%, 4%, 6%, 8% or 10%") and the **Payday Filing File Upload
Specification 2026-27** (July 2026) — whose DEI field-22 note ("Must be
one of 0, 3%, 4%, 6%, 8% or 10%") predates the rate change (spec
finalized 23/03/2026; V1.1 change log shows the Jul 2026 update touched
§2.4.1/2.5/3.2.2/3.3.1 only). Conclusion: rows 19–21 stand as seeded —
3.5% default + 3.5% employer; 0% (savings suspension) and 3% (rate
reduction) remain the only sub-3.5% filed rates. Full reasoning in
ADR-018's P0 verification addendum (docs/DECISIONS.md).

---

## 3. Known, deliberate divergences from IRD's PRINTED tables (decision records)

The engine's rounding reference is the **IRD online PAYE calculator**
(exact cents; each statutory line rounded independently, decimal half-up,
2dp — Phase 0 decision in `src/lib/payroll/nz/types.ts`). IRD's printed
booklets truncate combined totals instead, so a small class of rows differs
by one cent. These are documented, not bugs:

1. **M, monthly $5,000:** engine tax+levy = **939.21** (851.71 + 87.50);
   IR341 prints **939.20** (truncates the exact 939.2083).
2. **ESCT at exactly x.xx5:** engine rounds half-up (175 × 17.5% = 30.625 →
   **30.63**); IR341's CEC column truncates (**30.62**).
3. **ACC monthly cap:** engine **228.43** (1.75% × capped earnings — matches
   the printed IR341 row); the alternative 2,741.22 ÷ 12 form gives 228.44.
   The Phase 4 golden table originally expected 228.44; the deviation is
   documented in `golden.test.ts`.
4. **STC:** the original Phase 1 plan said "not supported in Phase 1"; the
   revised spec (implemented) supports STC with an IR23 certificate rate and
   throws only when the rate is missing. Documented in `golden.test.ts`.

---

## 4. Sign-off (the blocking gate)

I have personally opened each IRD page cited in §1, compared every published
figure against the seeded value, and checked the divergence decisions in §3.

| Section | Rates | Verified ✓ | IRD page opened (date) |
|---|---|---|---|
| 1.1 PAYE slabs | #1–5 | ☐ | |
| 1.2 Secondary rates | #6–11 | ☐ | |
| 1.3 ACC levy | #12–14 | ☐ | |
| 1.4 IETC | #15–18 | ☐ | |
| 1.5 KiwiSaver + auto-enrolment | #19–25 | ☐ | |
| 1.6 ESCT | #26–30 | ☐ | |
| 1.7 Student loan | #31–33 | ☐ | |
| 1.8 Tax code vocabulary + STC | §1.8 | ☐ | |
| §3 divergence decisions accepted | — | ☐ | |

**Verifier name:** ______________________  **Role:** ______________________

**Signature:** ______________________  **Date:** ____________

**Result:** ☐ ALL rates verified — the engine may ship
            ☐ Discrepancies found — list them below and BLOCK the merge

Notes / discrepancies:

> ______________________________________________________________________
>
> ______________________________________________________________________

---

*Until this block is signed with result "ALL rates verified", the statutory
engine stays behind the gate: no production deploy, no release-branch merge.
The golden suite (`golden.test.ts`) and the Phase 4 data verification
(`bun run verify:phase4 post`) must also be green at the moment of sign-off.*
