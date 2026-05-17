import type { Database } from "bun:sqlite";
import { getInvoiceStatus } from "./invoice-payments";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { insertAuditLog } from "./actor";

const RULE_ID = "DK-INVOICE-BAD-DEBT-WRITEOFF-001";
const VAT_RULE_ID = "DK-VAT-BAD-DEBT-001";

export type WriteOffInvoiceBadDebtInput = {
  invoiceDocumentId: number;
  writeOffDate: string;
  grossAmount?: number;
  expenseAccountNo?: string;
  receivableAccountNo?: string;
  vatAccountNo?: string;
  note?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type WriteOffInvoiceBadDebtResult = JournalPostResult & {
  writeOffId?: number;
  invoiceNumber?: string;
  grossAmount?: number;
  netAmount?: number;
  vatAmount?: number;
  openBalance?: number;
  claimOpenBalance?: number;
};

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim());
}
function round2(value: number) { return Number(value.toFixed(2)); }

export function writeOffInvoiceBadDebt(db: Database, input: WriteOffInvoiceBadDebtInput): WriteOffInvoiceBadDebtResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) errors.push("invoiceDocumentId must be a positive integer");
  if (!looksLikeIsoDate(input.writeOffDate)) errors.push("writeOffDate must be YYYY-MM-DD");
  if (input.grossAmount !== undefined && (!Number.isFinite(input.grossAmount) || input.grossAmount <= 0)) errors.push("grossAmount must be a positive number when present");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors };

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
  if (!invoice) return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: [`invoice document ${input.invoiceDocumentId} does not exist`] };
  if (invoice.document_type !== "issued_invoice") return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: [`document ${input.invoiceDocumentId} is not an issued invoice`] };
  if ((invoice.currency ?? "DKK") !== "DKK") return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: ["only DKK standard-rated issued invoices are supported in the current bad-debt flow"] };

  const payload = invoice.payload_json ? JSON.parse(invoice.payload_json) : null;
  if (payload?.vatTreatment !== "standard") {
    return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: ["bad-debt VAT relief currently requires a standard-rated issued invoice"] };
  }

  const grossInvoiceAmount = round2(Number(invoice.amount_inc_vat ?? 0));
  const originalVatAmount = round2(Number(invoice.vat_amount ?? 0));
  if (!(grossInvoiceAmount > 0) || !(originalVatAmount > 0)) {
    return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: ["bad-debt VAT relief requires a positive gross invoice amount and VAT amount"] };
  }

  const status = getInvoiceStatus(db, input.invoiceDocumentId, input.writeOffDate);
  if (!status.ok) return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: status.errors };
  const openBalance = round2(Number(status.openBalance ?? 0));
  if (!(openBalance > 0)) return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: [`invoice ${invoice.invoice_no} has no open principal balance to write off`] };

  const grossAmount = round2(input.grossAmount ?? openBalance);
  if (grossAmount > openBalance) {
    return { ok: false, appliedRules: [RULE_ID, VAT_RULE_ID], errors: [`bad-debt write-off amount ${grossAmount} exceeds open principal balance ${openBalance}`] };
  }

  const vatRatio = originalVatAmount / grossInvoiceAmount;
  const vatAmount = round2(grossAmount * vatRatio);
  const netAmount = round2(grossAmount - vatAmount);

  try {
    const result = db.transaction(() => {
      const journal = postJournalEntry(db, {
        transactionDate: input.writeOffDate,
        text: `Bad debt write-off for invoice ${invoice.invoice_no}`,
        documentId: input.invoiceDocumentId,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        lines: [
          { accountNo: input.expenseAccountNo ?? "3080", debitAmount: netAmount, vatCode: "DK_BAD_DEBT_25", text: `Bad debt loss basis ${invoice.invoice_no}` },
          { accountNo: input.vatAccountNo ?? "1200", debitAmount: vatAmount, text: `Output VAT relief ${invoice.invoice_no}` },
          { accountNo: input.receivableAccountNo ?? "1100", creditAmount: grossAmount, text: `Write off receivable ${invoice.invoice_no}` },
        ],
      });
      if (!journal.ok) throw new Error(JSON.stringify({ appliedRules: journal.appliedRules, errors: journal.errors }));

      const writeOff = db.query(
        `INSERT INTO invoice_bad_debt_writeoffs (invoice_document_id, writeoff_date, gross_amount, net_amount, vat_amount, note, journal_entry_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      ).get(input.invoiceDocumentId, input.writeOffDate, grossAmount, netAmount, vatAmount, input.note ?? null, journal.entryId!) as { id: number };

      insertAuditLog(db, {
        eventType: "invoice_bad_debt_writeoff",
        entityType: "invoice_bad_debt_writeoff",
        entityId: writeOff.id,
        message: `Wrote off bad debt ${grossAmount} on invoice ${invoice.invoice_no}`,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
      });

      const after = getInvoiceStatus(db, input.invoiceDocumentId, input.writeOffDate);
      if (!after.ok) throw new Error(JSON.stringify({ errors: after.errors }));

      return {
        ...journal,
        writeOffId: writeOff.id,
        invoiceNumber: invoice.invoice_no,
        grossAmount,
        netAmount,
        vatAmount,
        openBalance: after.openBalance,
        claimOpenBalance: after.claimOpenBalance,
        appliedRules: [...new Set([RULE_ID, VAT_RULE_ID, ...(journal.appliedRules ?? [])])],
      };
    })();
    return result;
  } catch (error) {
    const parsed = typeof error === "object" && error && "message" in error ? (() => {
      try { return JSON.parse(String((error as any).message)); } catch { return null; }
    })() : null;
    return {
      ok: false,
      appliedRules: [...new Set([RULE_ID, VAT_RULE_ID, ...((parsed?.appliedRules as string[] | undefined) ?? [])])],
      errors: (parsed?.errors as string[] | undefined) ?? [String(error)],
    };
  }
}
