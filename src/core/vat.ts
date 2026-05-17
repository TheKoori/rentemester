import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { postJournalEntry, type JournalPostResult } from "./ledger";

export type VatPeriodReport = {
  ok: boolean;
  appliedRules: string[];
  periodStart: string;
  periodEnd: string;
  outputVat: number;
  inputVat: number;
  netVatPayable: number;
  purchaseBase25: number;
  salesBase25: number;
  reverseChargePurchaseBase: number;
  representationPurchaseBase: number;
  badDebtReliefBase25: number;
  taxAgencyMapping: {
    rubrikA_outputVatDomestic: number;
    rubrikB_euGoodsPurchaseVat: number;
    rubrikC_euServicesPurchaseVat: number;
    rubrikD_inputVatDomestic: number;
    rubrikE_euGoodsSale: number;
    rubrikF_euServicesSale: number;
    rubrikG_exportOutsideEu: number;
    netToPayOrReceive: number;
  };
  formGuidance: {
    skatTastSelvUrl: string;
    periodLabel: string;
    companyCvr: string | null;
  };
  journalEntryCount: number;
  reversedJournalEntryCount: number;
  reversalJournalEntryCount: number;
  totalJournalEntryCount: number;
  linesConsidered: number;
  reversedLinesConsidered: number;
  reversalLinesConsidered: number;
  totalLinesConsidered: number;
  warnings: string[];
  errors: string[];
};

const RULE_ID = "DK-VAT-REPORT-001";
const VAT_SUBMISSION_RULE_ID = "DK-VAT-INDBERETNING-001";
const REVERSE_CHARGE_RULE_ID = "DK-VAT-REVERSE-CHARGE-001";
const REPRESENTATION_RULE_ID = "DK-VAT-REPRESENTATION-001";

const vatRulesPath = fileURLToPath(new URL("../../rules/dk/vat.yaml", import.meta.url));

type VatRateRule = { code: string; rate: number; validFrom: string; validTo: string | null };
type VatConfig = { rates: VatRateRule[]; representationDeductibleShare: number };

function parseVatConfig(): VatConfig {
  const text = readFileSync(vatRulesPath, "utf8");
  const rates: VatRateRule[] = [];
  const blocks = text.split(/^\s*-\s*code:\s*/m).slice(1);
  for (const block of blocks) {
    const codeMatch = block.match(/^(\S+)/m);
    const rateMatch = block.match(/^\s*rate:\s*([0-9.]+)$/m);
    const validFromMatch = block.match(/^\s*valid_from:\s*(\S+)$/m);
    const validToMatch = block.match(/^\s*valid_to:\s*(\S+)$/m);
    if (codeMatch && rateMatch && validFromMatch && validToMatch) {
      rates.push({
        code: codeMatch[1],
        rate: Number(rateMatch[1]),
        validFrom: validFromMatch[1],
        validTo: validToMatch[1] === "null" ? null : validToMatch[1],
      });
    }
  }
  const representationBlock = blocks.find((block) => block.startsWith("REPRESENTATION_SPECIAL"));
  const shareMatch = representationBlock?.match(/^\s*deductible_percentage:\s*([0-9.]+)$/m);
  const representationDeductibleShare = shareMatch ? Number(shareMatch[1]) : 0.25;
  return { rates, representationDeductibleShare };
}

const VAT_CONFIG = parseVatConfig();

function vatRateFor(code: string, onDate: string) {
  const match = VAT_CONFIG.rates.find((rate) => rate.code === code && rate.validFrom <= onDate && (!rate.validTo || rate.validTo >= onDate));
  return match?.rate;
}

export type ReverseChargePurchaseInput = {
  transactionDate: string;
  text: string;
  documentId: number;
  netAmount: number;
  expenseAccountNo: string;
  paymentAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type RepresentationPurchaseInput = {
  transactionDate: string;
  text: string;
  documentId: number;
  netAmount: number;
  expenseAccountNo?: string;
  paymentAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
};

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function companyCvr(db: Database) {
  const row = db.query(
    `SELECT recipient_vat_cvr as cvr
     FROM documents
     WHERE recipient_vat_cvr IS NOT NULL AND recipient_vat_cvr != ''
     ORDER BY id DESC
     LIMIT 1`
  ).get() as { cvr?: string | null } | null;
  return row?.cvr ?? null;
}

export function postEuServiceReverseChargePurchase(db: Database, input: ReverseChargePurchaseInput): JournalPostResult {
  const errors: string[] = [];
  if (!looksLikeIsoDate(input.transactionDate)) errors.push("transactionDate must be YYYY-MM-DD");
  if (typeof input.text !== "string" || input.text.trim().length === 0) errors.push("text is required");
  if (!Number.isInteger(input.documentId) || input.documentId <= 0) errors.push("documentId must be a positive integer");
  if (!Number.isFinite(input.netAmount) || input.netAmount <= 0) errors.push("netAmount must be a positive number");
  if (typeof input.expenseAccountNo !== "string" || input.expenseAccountNo.trim().length === 0) errors.push("expenseAccountNo is required");
  if (errors.length > 0) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors };

  const vatRate = vatRateFor("EU_SERVICE_REVERSE_CHARGE", input.transactionDate);
  if (vatRate === undefined) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: [`no VAT rate defined for EU_SERVICE_REVERSE_CHARGE on ${input.transactionDate}`] };

  const vatAmount = round2(input.netAmount * vatRate);
  const result = postJournalEntry(db, {
    transactionDate: input.transactionDate,
    text: input.text.trim(),
    documentId: input.documentId,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: [
      { accountNo: input.expenseAccountNo, debitAmount: round2(input.netAmount), vatCode: "EU_SERVICE_REVERSE_CHARGE", text: "EU service purchase base" },
      { accountNo: "4000", debitAmount: vatAmount, text: "Deductible reverse-charge input VAT" },
      { accountNo: input.paymentAccountNo ?? "2000", creditAmount: round2(input.netAmount), text: "Payment / liability" },
      { accountNo: "1200", creditAmount: vatAmount, text: "Reverse-charge output VAT" },
    ],
  });

  return {
    ...result,
    appliedRules: result.ok ? [...new Set([...(result.appliedRules ?? []), REVERSE_CHARGE_RULE_ID])] : [...new Set([REVERSE_CHARGE_RULE_ID, ...(result.appliedRules ?? [])])],
  };
}

export function postRepresentationPurchase(db: Database, input: RepresentationPurchaseInput): JournalPostResult {
  const errors: string[] = [];
  if (!looksLikeIsoDate(input.transactionDate)) errors.push("transactionDate must be YYYY-MM-DD");
  if (typeof input.text !== "string" || input.text.trim().length === 0) errors.push("text is required");
  if (!Number.isInteger(input.documentId) || input.documentId <= 0) errors.push("documentId must be a positive integer");
  if (!Number.isFinite(input.netAmount) || input.netAmount <= 0) errors.push("netAmount must be a positive number");
  if (errors.length > 0) return { ok: false, appliedRules: [REPRESENTATION_RULE_ID], errors };

  const vatRate = vatRateFor("REPRESENTATION_SPECIAL", input.transactionDate);
  if (vatRate === undefined) return { ok: false, appliedRules: [REPRESENTATION_RULE_ID], errors: [`no VAT rate defined for REPRESENTATION_SPECIAL on ${input.transactionDate}`] };

  const fullVatAmount = round2(input.netAmount * vatRate);
  const deductibleVatAmount = round2(fullVatAmount * VAT_CONFIG.representationDeductibleShare);
  const nonDeductibleVatAmount = round2(fullVatAmount - deductibleVatAmount);
  const grossAmount = round2(input.netAmount + fullVatAmount);

  const result = postJournalEntry(db, {
    transactionDate: input.transactionDate,
    text: input.text.trim(),
    documentId: input.documentId,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: [
      {
        accountNo: input.expenseAccountNo ?? "3070",
        debitAmount: round2(input.netAmount),
        vatCode: "REPRESENTATION_SPECIAL",
        text: "Representation purchase base"
      },
      {
        accountNo: input.expenseAccountNo ?? "3070",
        debitAmount: nonDeductibleVatAmount,
        text: "Non-deductible representation VAT (75%)"
      },
      { accountNo: "4000", debitAmount: deductibleVatAmount, text: "Deductible representation VAT (25%)" },
      { accountNo: input.paymentAccountNo ?? "2000", creditAmount: grossAmount, text: "Payment / liability" },
    ],
  });

  return {
    ...result,
    appliedRules: result.ok ? [...new Set([...(result.appliedRules ?? []), REPRESENTATION_RULE_ID])] : [...new Set([REPRESENTATION_RULE_ID, ...(result.appliedRules ?? [])])],
  };
}

export function buildVatReport(db: Database, periodStart: string, periodEnd: string): VatPeriodReport {
  const errors: string[] = [];
  if (!looksLikeIsoDate(periodStart)) errors.push("periodStart must be YYYY-MM-DD");
  if (!looksLikeIsoDate(periodEnd)) errors.push("periodEnd must be YYYY-MM-DD");
  if (errors.length === 0 && periodStart > periodEnd) errors.push("periodStart must be before or equal to periodEnd");
  if (errors.length > 0) {
    return {
      ok: false,
      appliedRules: [RULE_ID],
      periodStart,
      periodEnd,
      outputVat: 0,
      inputVat: 0,
      netVatPayable: 0,
      purchaseBase25: 0,
      salesBase25: 0,
      reverseChargePurchaseBase: 0,
      representationPurchaseBase: 0,
      badDebtReliefBase25: 0,
      journalEntryCount: 0,
      reversedJournalEntryCount: 0,
      reversalJournalEntryCount: 0,
      totalJournalEntryCount: 0,
      linesConsidered: 0,
      reversedLinesConsidered: 0,
      reversalLinesConsidered: 0,
      totalLinesConsidered: 0,
      taxAgencyMapping: {
        rubrikA_outputVatDomestic: 0,
        rubrikB_euGoodsPurchaseVat: 0,
        rubrikC_euServicesPurchaseVat: 0,
        rubrikD_inputVatDomestic: 0,
        rubrikE_euGoodsSale: 0,
        rubrikF_euServicesSale: 0,
        rubrikG_exportOutsideEu: 0,
        netToPayOrReceive: 0,
      },
      formGuidance: {
        skatTastSelvUrl: "https://www.skat.dk/tastselv/erhverv",
        periodLabel: `${periodStart}..${periodEnd}`,
        companyCvr: null,
      },
      warnings: [],
      errors,
    };
  }

  const rows = db.query(
    `SELECT je.id as entry_id, je.status, je.reversal_of_entry_id, a.account_no, a.type as account_type, jl.debit_amount, jl.credit_amount, jl.vat_code
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.transaction_date >= ? AND je.transaction_date <= ?
     ORDER BY je.id ASC, jl.id ASC`
  ).all(periodStart, periodEnd) as Array<{
    entry_id: number;
    status: string;
    reversal_of_entry_id: number | null;
    account_no: string;
    account_type: string;
    debit_amount: number;
    credit_amount: number;
    vat_code: string | null;
  }>;

  let outputVat = 0;
  let inputVat = 0;
  let purchaseBase25 = 0;
  let salesBase25 = 0;
  let reverseChargePurchaseBase = 0;
  let representationPurchaseBase = 0;
  let badDebtReliefBase25 = 0;
  const activeEntryIds = new Set<number>();
  const reversedEntryIds = new Set<number>();
  const reversalEntryIds = new Set<number>();
  let activeLinesConsidered = 0;
  let reversedLinesConsidered = 0;
  let reversalLinesConsidered = 0;
  const reversedByInPeriodReversal = new Set(rows.filter((row) => row.reversal_of_entry_id != null).map((row) => row.reversal_of_entry_id as number));

  for (const row of rows) {
    const isReversalEntry = row.reversal_of_entry_id != null;
    const isReversedEntry = !isReversalEntry && reversedByInPeriodReversal.has(row.entry_id);

    if (isReversalEntry) {
      reversalEntryIds.add(row.entry_id);
      reversalLinesConsidered += 1;
    } else if (isReversedEntry) {
      reversedEntryIds.add(row.entry_id);
      reversedLinesConsidered += 1;
    } else {
      activeEntryIds.add(row.entry_id);
      activeLinesConsidered += 1;
    }

    const debit = round2(Number(row.debit_amount ?? 0));
    const credit = round2(Number(row.credit_amount ?? 0));

    if (row.account_no === "1200") outputVat += credit - debit;
    if (row.account_no === "4000") inputVat += debit - credit;

    if (row.vat_code === "DK_PURCHASE_25") purchaseBase25 += debit - credit;
    if (row.vat_code === "DK_SALE_25") salesBase25 += credit - debit;
    if (row.vat_code === "EU_SERVICE_REVERSE_CHARGE") reverseChargePurchaseBase += debit - credit;
    if (row.vat_code === "REPRESENTATION_SPECIAL") representationPurchaseBase += debit - credit;
    if (row.vat_code === "DK_BAD_DEBT_25") badDebtReliefBase25 += debit - credit;
  }

  outputVat = round2(outputVat);
  inputVat = round2(inputVat);
  purchaseBase25 = round2(purchaseBase25);
  salesBase25 = round2(salesBase25);
  reverseChargePurchaseBase = round2(reverseChargePurchaseBase);
  representationPurchaseBase = round2(representationPurchaseBase);
  badDebtReliefBase25 = round2(badDebtReliefBase25);

  const saleVatRate = vatRateFor("DK_SALE_25", periodEnd) ?? 0.25;
  const purchaseVatRate = vatRateFor("DK_PURCHASE_25", periodEnd) ?? 0.25;
  const reverseChargeVatRate = vatRateFor("EU_SERVICE_REVERSE_CHARGE", periodEnd) ?? 0.25;
  const representationVatRate = vatRateFor("REPRESENTATION_SPECIAL", periodEnd) ?? 0.25;
  const expectedOutputVat = round2(salesBase25 * saleVatRate + reverseChargePurchaseBase * reverseChargeVatRate - badDebtReliefBase25 * saleVatRate);
  const expectedInputVat = round2(purchaseBase25 * purchaseVatRate + reverseChargePurchaseBase * reverseChargeVatRate + representationPurchaseBase * representationVatRate * VAT_CONFIG.representationDeductibleShare);
  const warnings: string[] = [];
  if (Math.abs(outputVat - expectedOutputVat) > 0.5) {
    warnings.push(`output VAT mismatch: booked ${outputVat}, expected from base × rate ${expectedOutputVat}`);
  }
  if (Math.abs(inputVat - expectedInputVat) > 0.5) {
    warnings.push(`input VAT mismatch: booked ${inputVat}, expected from base × rate ${expectedInputVat}`);
  }

  const rubrikC_euServicesPurchaseVat = round2(reverseChargePurchaseBase * reverseChargeVatRate);
  const rubrikA_outputVatDomestic = round2(outputVat - rubrikC_euServicesPurchaseVat);
  const rubrikD_inputVatDomestic = round2(inputVat - rubrikC_euServicesPurchaseVat);
  const netToPayOrReceive = round2(rubrikA_outputVatDomestic + rubrikC_euServicesPurchaseVat - rubrikD_inputVatDomestic);

  return {
    ok: true,
    appliedRules: [RULE_ID, VAT_SUBMISSION_RULE_ID],
    periodStart,
    periodEnd,
    outputVat,
    inputVat,
    netVatPayable: round2(outputVat - inputVat),
    purchaseBase25,
    salesBase25,
    reverseChargePurchaseBase,
    representationPurchaseBase,
    badDebtReliefBase25,
    taxAgencyMapping: {
      rubrikA_outputVatDomestic,
      rubrikB_euGoodsPurchaseVat: 0,
      rubrikC_euServicesPurchaseVat,
      rubrikD_inputVatDomestic,
      rubrikE_euGoodsSale: 0,
      rubrikF_euServicesSale: 0,
      rubrikG_exportOutsideEu: 0,
      netToPayOrReceive,
    },
    formGuidance: {
      skatTastSelvUrl: "https://www.skat.dk/tastselv/erhverv",
      periodLabel: `${periodStart}..${periodEnd}`,
      companyCvr: companyCvr(db),
    },
    journalEntryCount: activeEntryIds.size,
    reversedJournalEntryCount: reversedEntryIds.size,
    reversalJournalEntryCount: reversalEntryIds.size,
    totalJournalEntryCount: activeEntryIds.size + reversedEntryIds.size + reversalEntryIds.size,
    linesConsidered: activeLinesConsidered,
    reversedLinesConsidered,
    reversalLinesConsidered,
    totalLinesConsidered: rows.length,
    warnings,
    errors: [],
  };
}
