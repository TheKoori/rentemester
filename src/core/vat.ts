import type { Database } from "bun:sqlite";
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
  badDebtRecoveryBase25: number;
  journalEntryCount: number;
  linesConsidered: number;
  errors: string[];
};

const RULE_ID = "DK-VAT-REPORT-001";
const REVERSE_CHARGE_RULE_ID = "DK-VAT-REVERSE-CHARGE-001";
const REPRESENTATION_RULE_ID = "DK-VAT-REPRESENTATION-001";

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

export function postEuServiceReverseChargePurchase(db: Database, input: ReverseChargePurchaseInput): JournalPostResult {
  const errors: string[] = [];
  if (!looksLikeIsoDate(input.transactionDate)) errors.push("transactionDate must be YYYY-MM-DD");
  if (typeof input.text !== "string" || input.text.trim().length === 0) errors.push("text is required");
  if (!Number.isInteger(input.documentId) || input.documentId <= 0) errors.push("documentId must be a positive integer");
  if (!Number.isFinite(input.netAmount) || input.netAmount <= 0) errors.push("netAmount must be a positive number");
  if (typeof input.expenseAccountNo !== "string" || input.expenseAccountNo.trim().length === 0) errors.push("expenseAccountNo is required");
  if (errors.length > 0) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors };

  const vatAmount = round2(input.netAmount * 0.25);
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

  const fullVatAmount = round2(input.netAmount * 0.25);
  const deductibleVatAmount = round2(fullVatAmount * 0.25);
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
      badDebtRecoveryBase25: 0,
      journalEntryCount: 0,
      linesConsidered: 0,
      errors,
    };
  }

  const rows = db.query(
    `SELECT je.id as entry_id, a.account_no, a.type as account_type, jl.debit_amount, jl.credit_amount, jl.vat_code
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.transaction_date >= ? AND je.transaction_date <= ?
     ORDER BY je.id ASC, jl.id ASC`
  ).all(periodStart, periodEnd) as Array<{
    entry_id: number;
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
  let badDebtRecoveryBase25 = 0;
  const entryIds = new Set<number>();

  for (const row of rows) {
    entryIds.add(row.entry_id);
    const debit = round2(Number(row.debit_amount ?? 0));
    const credit = round2(Number(row.credit_amount ?? 0));

    if (row.account_no === "1200") outputVat += credit - debit;
    if (row.account_no === "4000") inputVat += debit - credit;

    if (row.vat_code === "DK_PURCHASE_25") purchaseBase25 += debit - credit;
    if (row.vat_code === "DK_SALE_25") salesBase25 += credit - debit;
    if (row.vat_code === "EU_SERVICE_REVERSE_CHARGE") reverseChargePurchaseBase += debit - credit;
    if (row.vat_code === "REPRESENTATION_SPECIAL") representationPurchaseBase += debit - credit;
    if (row.vat_code === "DK_BAD_DEBT_25") badDebtReliefBase25 += debit - credit;
    if (row.vat_code === "DK_BAD_DEBT_RECOVERY_25") badDebtRecoveryBase25 += credit - debit;
  }

  outputVat = round2(outputVat);
  inputVat = round2(inputVat);
  purchaseBase25 = round2(purchaseBase25);
  salesBase25 = round2(salesBase25);
  reverseChargePurchaseBase = round2(reverseChargePurchaseBase);
  representationPurchaseBase = round2(representationPurchaseBase);
  badDebtReliefBase25 = round2(badDebtReliefBase25);
  badDebtRecoveryBase25 = round2(badDebtRecoveryBase25);

  return {
    ok: true,
    appliedRules: [RULE_ID],
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
    badDebtRecoveryBase25,
    journalEntryCount: entryIds.size,
    linesConsidered: rows.length,
    errors: [],
  };
}
