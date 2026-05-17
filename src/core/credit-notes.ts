import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { promoteTempFile, removeIfExists, writeTempFileFor } from "./atomic-file";
import { insertAuditLog } from "./actor";

export type IssueCreditNoteInput = {
  originalInvoiceDocumentId: number;
  issueDate: string;
  reason: string;
  grossAmount?: number;
  creditNoteNumber?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type IssueCreditNoteResult = {
  ok: boolean;
  documentId?: number;
  creditNoteNumber?: string;
  originalInvoiceNumber?: string;
  storedPath?: string;
  sha256?: string;
  journalEntryId?: number;
  journalEntryNo?: string;
  appliedRules: string[];
  errors: string[];
};

const RULE_ID = "DK-CREDIT-NOTE-001";

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function nextCreditNoteNumber(db: Database) {
  const row = db.query("SELECT COUNT(*) AS n FROM documents WHERE document_type = 'credit_note'").get() as { n: number };
  return `CN-${new Date().getFullYear()}-${String(row.n + 1).padStart(4, "0")}`;
}

function round2(value: number) { return Number(value.toFixed(2)); }

export function issueCreditNote(db: Database, companyRoot: string, input: IssueCreditNoteInput): IssueCreditNoteResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.originalInvoiceDocumentId) || input.originalInvoiceDocumentId <= 0) errors.push("originalInvoiceDocumentId must be a positive integer");
  if (!looksLikeIsoDate(input.issueDate)) errors.push("issueDate must be YYYY-MM-DD");
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) errors.push("reason is required");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const original = db.query(
    `SELECT id, invoice_no, amount_inc_vat, currency, vat_amount, payload_json, document_type
     FROM documents WHERE id = ?`
  ).get(input.originalInvoiceDocumentId) as any | null;
  if (!original) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice document ${input.originalInvoiceDocumentId} does not exist`] };
  if (original.document_type !== "issued_invoice") return { ok: false, appliedRules: [RULE_ID], errors: [`document ${input.originalInvoiceDocumentId} is not an issued invoice`] };

  const payload = original.payload_json ? JSON.parse(original.payload_json) : null;
  const originalGrossAmount = round2(Number(original.amount_inc_vat ?? payload?.totals?.grossAmount ?? 0));
  const originalVatAmount = round2(Number(original.vat_amount ?? payload?.totals?.vatAmount ?? 0));
  const creditedSoFar = round2(Number((db.query("SELECT COALESCE(SUM(amount_inc_vat), 0) AS total FROM documents WHERE document_type = 'credit_note' AND payment_details = ?").get(original.invoice_no) as { total: number }).total ?? 0));
  const remainingGrossAmount = round2(originalGrossAmount - creditedSoFar);
  if (remainingGrossAmount <= 0) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice ${original.invoice_no} is already fully credited`] };

  const grossAmount = round2(input.grossAmount ?? remainingGrossAmount);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) return { ok: false, appliedRules: [RULE_ID], errors: ["grossAmount must be a positive number when present"] };
  if (grossAmount > remainingGrossAmount) return { ok: false, appliedRules: [RULE_ID], errors: [`credit amount ${grossAmount} exceeds remaining creditable amount ${remainingGrossAmount}`] };

  const vatRatio = originalGrossAmount > 0 ? originalVatAmount / originalGrossAmount : 0;
  const vatAmount = round2(grossAmount * vatRatio);
  const netAmount = round2(grossAmount - vatAmount);
  const creditNoteNumber = input.creditNoteNumber?.trim() || nextCreditNoteNumber(db);

  const creditPayload = {
    type: "credit_note",
    creditNoteNumber,
    originalInvoiceNumber: original.invoice_no,
    originalInvoiceDocumentId: original.id,
    issueDate: input.issueDate,
    reason: input.reason.trim(),
    grossAmount,
    vatAmount,
    netAmount,
    creditedSoFar,
    remainingAfterThisCredit: round2(remainingGrossAmount - grossAmount),
    issuedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(creditPayload, null, 2);
  const hash = sha256(serialized);
  const paths = companyPaths(companyRoot);
  mkdirSync(paths.invoicesIssued, { recursive: true });
  const storedPath = join(paths.invoicesIssued, `${creditNoteNumber}.json`);
  const tempPath = writeTempFileFor(storedPath, serialized);

  try {
    const result = db.transaction(() => {
      const doc = db.query(
        `INSERT INTO documents (
          document_no, source, original_filename, stored_path, mime_type, sha256_hash,
          supplier_name, invoice_no, invoice_date, amount_inc_vat, currency, status,
          document_type, delivery_description, sender_name, sender_address, sender_vat_cvr,
          recipient_name, recipient_address, recipient_vat_cvr, vat_amount, payment_details, exemption_code, payload_json
        ) VALUES (?, 'rentemester', ?, ?, 'application/json', ?, ?, ?, ?, ?, ?, 'issued', 'credit_note', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        RETURNING id`
      ).get(
        creditNoteNumber,
        `${creditNoteNumber}.json`,
        storedPath,
        hash,
        payload?.seller?.name ?? null,
        creditNoteNumber,
        input.issueDate,
        grossAmount,
        original.currency ?? 'DKK',
        `Credit note for ${original.invoice_no}: ${input.reason.trim()}`,
        payload?.seller?.name ?? null,
        payload?.seller?.address ?? null,
        payload?.seller?.vatOrCvr ?? null,
        payload?.buyer?.name ?? null,
        payload?.buyer?.address ?? null,
        payload?.buyer?.vatOrCvr ?? null,
        vatAmount,
        original.invoice_no,
        serialized,
      ) as { id: number };

      const journal = postJournalEntry(db, {
        transactionDate: input.issueDate,
        text: `Credit note ${creditNoteNumber} for invoice ${original.invoice_no}`,
        documentId: doc.id,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        lines: [
          { accountNo: "1000", debitAmount: netAmount, vatCode: "DK_SALE_25", text: `Revenue reversal ${creditNoteNumber}` },
          { accountNo: "1200", debitAmount: vatAmount, text: `VAT reversal ${creditNoteNumber}` },
          { accountNo: "1100", creditAmount: grossAmount, text: `Receivable reversal ${creditNoteNumber}` },
        ],
      });
      if (!journal.ok) throw new Error(JSON.stringify({ appliedRules: journal.appliedRules, errors: journal.errors }));

      insertAuditLog(db, {
        eventType: "credit_note_issue",
        entityType: "document",
        entityId: doc.id,
        message: `Issued credit note ${creditNoteNumber} for ${original.invoice_no}`,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
      });

      return { docId: doc.id, journal };
    })();

    promoteTempFile(tempPath, storedPath);
    return {
      ok: true,
      documentId: result.docId,
      creditNoteNumber,
      originalInvoiceNumber: original.invoice_no,
      storedPath,
      sha256: hash,
      journalEntryId: result.journal.entryId,
      journalEntryNo: result.journal.entryNo,
      appliedRules: [...new Set([RULE_ID, ...(result.journal.appliedRules ?? [])])],
      errors: [],
    };
  } catch (error) {
    removeIfExists(tempPath);
    const parsed = typeof error === "object" && error && "message" in error ? (() => {
      try { return JSON.parse(String((error as any).message)); } catch { return null; }
    })() : null;
    return {
      ok: false,
      appliedRules: [...new Set([RULE_ID, ...((parsed?.appliedRules as string[] | undefined) ?? [])])],
      errors: (parsed?.errors as string[] | undefined) ?? [String(error)],
    };
  }
}
