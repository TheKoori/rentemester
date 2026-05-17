import type { Database } from "bun:sqlite";
import { getInvoiceStatus } from "./invoice-payments";
import { postJournalEntry, type JournalPostResult } from "./ledger";

const RULE_ID = "DK-INVOICE-BAD-DEBT-RECOVERY-001";
const CORRECTION_BALANCE_RULE_ID = "DK-INVOICE-BAD-DEBT-RECOVERY-CORRECTED-BALANCE-001";
const VAT_RULE_ID = "DK-VAT-BAD-DEBT-RECOVERY-001";

export type RecoverInvoiceBadDebtFromBankInput = {
  invoiceDocumentId: number;
  bankTransactionId?: number;
  bankTransactionReference?: string;
  recoveryDate?: string;
  amount?: number;
  bankAccountNo?: string;
  badDebtExpenseAccountNo?: string;
  vatAccountNo?: string;
  note?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type RecoverInvoiceBadDebtFromBankResult = JournalPostResult & {
  recoveryId?: number;
  invoiceNumber?: string;
  bankTransactionId?: number;
  grossAmount?: number;
  netAmount?: number;
  vatAmount?: number;
  remainingBadDebtExposure?: number;
};

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());
}
function round2(value: number) { return Number(value.toFixed(2)); }

export function recoverInvoiceBadDebtFromBank(db: Database, input: RecoverInvoiceBadDebtFromBankInput): RecoverInvoiceBadDebtFromBankResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) errors.push("invoiceDocumentId must be a positive integer");
  if (input.bankTransactionId !== undefined && (!Number.isInteger(input.bankTransactionId) || input.bankTransactionId <= 0)) errors.push("bankTransactionId must be a positive integer when present");
  if (input.recoveryDate !== undefined && !looksLikeIsoDate(input.recoveryDate)) errors.push("recoveryDate must be YYYY-MM-DD when present");
  if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount <= 0)) errors.push("amount must be a positive number when present");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors };

  const bank = (input.bankTransactionId !== undefined
    ? db.query(`SELECT id, transaction_date, amount, currency, text, reference FROM bank_transactions WHERE id = ?`).get(input.bankTransactionId)
    : input.bankTransactionReference
      ? db.query(`SELECT id, transaction_date, amount, currency, text, reference FROM bank_transactions WHERE reference = ? ORDER BY id DESC LIMIT 1`).get(input.bankTransactionReference)
      : db.query(`SELECT id, transaction_date, amount, currency, text, reference FROM bank_transactions WHERE amount > 0 ORDER BY id DESC LIMIT 1`).get()) as {
        id: number;
        transaction_date: string;
        amount: number;
        currency: string;
        text: string;
        reference: string | null;
      } | null;
  if (!bank) return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: [input.bankTransactionId !== undefined ? `bank transaction ${input.bankTransactionId} does not exist` : input.bankTransactionReference ? `no bank transaction found with reference ${input.bankTransactionReference}` : "no incoming bank transaction available for bad-debt recovery"] };
  if (Number(bank.amount) <= 0) return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: [`bank transaction ${bank.id} is not an incoming customer receipt`] };
  if ((bank.currency ?? "DKK") !== "DKK") return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: ["only DKK bank receipts are supported in the current bad-debt recovery flow"] };

  const invoice = db.query(
    `SELECT id, invoice_no, amount_inc_vat, vat_amount, currency, payload_json, document_type
     FROM documents WHERE id = ?`
  ).get(input.invoiceDocumentId) as {
    id: number;
    invoice_no: string;
    amount_inc_vat: number | null;
    vat_amount: number | null;
    currency: string;
    payload_json: string | null;
    document_type: string;
  } | null;
  if (!invoice) return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: [`invoice document ${input.invoiceDocumentId} does not exist`] };
  if (invoice.document_type !== "issued_invoice") return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: [`document ${input.invoiceDocumentId} is not an issued invoice`] };
  if ((invoice.currency ?? "DKK") !== "DKK") return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: ["only DKK standard-rated issued invoices are supported in the current bad-debt recovery flow"] };

  const payload = invoice.payload_json ? JSON.parse(invoice.payload_json) : null;
  if (payload?.vatTreatment !== "standard") {
    return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: ["bad-debt recovery VAT handling currently requires a standard-rated issued invoice"] };
  }

  const grossInvoiceAmount = round2(Number(invoice.amount_inc_vat ?? 0));
  const originalVatAmount = round2(Number(invoice.vat_amount ?? 0));
  if (!(grossInvoiceAmount > 0) || !(originalVatAmount > 0)) {
    return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: ["bad-debt recovery requires a positive gross invoice amount and VAT amount"] };
  }

  const existingJournal = db.query(`SELECT id FROM journal_entries WHERE source_bank_transaction_id = ? LIMIT 1`).get(bank.id) as { id: number } | null;
  if (existingJournal) return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: [`bank transaction ${bank.id} is already linked to journal entry ${existingJournal.id}`] };

  const status = getInvoiceStatus(db, input.invoiceDocumentId, input.recoveryDate ?? bank.transaction_date);
  if (!status.ok) return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: status.errors };
  const remainingBadDebtExposure = round2(Number(status.remainingBadDebtExposure ?? 0));
  if (!(remainingBadDebtExposure > 0)) {
    return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: [`invoice ${invoice.invoice_no} has no unrecovered corrected written-off balance`] };
  }

  const grossAmount = round2(input.amount ?? Number(bank.amount));
  if (grossAmount > remainingBadDebtExposure) {
    return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID], errors: [`bad-debt recovery amount ${grossAmount} exceeds unrecovered corrected written-off balance ${remainingBadDebtExposure}`] };
  }

  const vatRatio = originalVatAmount / grossInvoiceAmount;
  const vatAmount = round2(grossAmount * vatRatio);
  const netAmount = round2(grossAmount - vatAmount);
  const recoveryDate = input.recoveryDate ?? bank.transaction_date;

  try {
    const result = db.transaction(() => {
      const journal = postJournalEntry(db, {
        transactionDate: recoveryDate,
        text: `Bad debt recovery for invoice ${invoice.invoice_no}`,
        sourceBankTransactionId: bank.id,
        documentId: input.invoiceDocumentId,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        lines: [
          { accountNo: input.bankAccountNo ?? "2000", debitAmount: grossAmount, text: `Recovered bank receipt ${invoice.invoice_no}` },
          { accountNo: input.badDebtExpenseAccountNo ?? "3080", creditAmount: netAmount, vatCode: "DK_BAD_DEBT_RECOVERY_25", text: `Reverse bad debt loss basis ${invoice.invoice_no}` },
          { accountNo: input.vatAccountNo ?? "1200", creditAmount: vatAmount, text: `Restore output VAT ${invoice.invoice_no}` },
        ],
      });
      if (!journal.ok) throw new Error(JSON.stringify({ appliedRules: journal.appliedRules, errors: journal.errors }));

      const recovery = db.query(
        `INSERT INTO invoice_bad_debt_recoveries (invoice_document_id, bank_transaction_id, recovery_date, gross_amount, net_amount, vat_amount, note, journal_entry_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      ).get(input.invoiceDocumentId, bank.id, recoveryDate, grossAmount, netAmount, vatAmount, input.note ?? null, journal.entryId!) as { id: number };

      db.run(
        "INSERT INTO audit_log (event_type, entity_type, entity_id, message) VALUES ('invoice_bad_debt_recovery', 'invoice_bad_debt_recovery', ?, ?)",
        String(recovery.id),
        `Recovered bad debt ${grossAmount} on invoice ${invoice.invoice_no} from bank transaction ${bank.id}`
      );

      const after = getInvoiceStatus(db, input.invoiceDocumentId, recoveryDate);
      if (!after.ok) throw new Error(JSON.stringify({ errors: after.errors }));

      return {
        ...journal,
        recoveryId: recovery.id,
        invoiceNumber: invoice.invoice_no,
        bankTransactionId: bank.id,
        grossAmount,
        netAmount,
        vatAmount,
        remainingBadDebtExposure: after.remainingBadDebtExposure,
        appliedRules: [...new Set([RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID, ...(journal.appliedRules ?? [])])],
      };
    })();
    return result;
  } catch (error) {
    const parsed = typeof error === "object" && error && "message" in error ? (() => {
      try { return JSON.parse(String((error as any).message)); } catch { return null; }
    })() : null;
    return {
      ok: false,
      appliedRules: [...new Set([RULE_ID, CORRECTION_BALANCE_RULE_ID, VAT_RULE_ID, ...((parsed?.appliedRules as string[] | undefined) ?? [])])],
      errors: (parsed?.errors as string[] | undefined) ?? [String(error)],
    };
  }
}
