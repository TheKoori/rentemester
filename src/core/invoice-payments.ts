import type { Database } from "bun:sqlite";
import { postJournalEntry } from "./ledger";
import { insertAuditLog } from "./actor";

export type ApplyInvoicePaymentInput = {
  invoiceDocumentId: number;
  paymentDate: string;
  amount: number;
  bankTransactionId?: number;
  journalEntryId?: number;
  bankAccountNo?: string;
  receivableAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
  note?: string;
};

export type ApplyInvoicePaymentResult = {
  ok: boolean;
  paymentId?: number;
  journalEntryId?: number;
  invoiceDocumentId?: number;
  invoiceNumber?: string;
  openBalance?: number;
  appliedRules: string[];
  errors: string[];
};

export type InvoiceStatusResult = {
  ok: boolean;
  invoiceDocumentId?: number;
  invoiceNumber?: string;
  grossAmount?: number;
  creditedAmount?: number;
  paidAmount?: number;
  openBalance?: number;
  claimOpenBalance?: number;
  dueDate?: string;
  effectiveDueDate?: string;
  isOverdue?: boolean;
  overdueDays?: number;
  status?: "open" | "paid" | "credited" | "refunded" | "overpaid" | "written_off";
  payments?: Array<{
    paymentId: number;
    paymentDate: string;
    amount: number;
    bankTransactionId: number | null;
    journalEntryId: number | null;
    note: string | null;
  }>;
  creditNotes?: Array<{
    documentId: number;
    creditNoteNumber: string;
    amount: number;
    issueDate: string | null;
  }>;
  refunds?: Array<{
    refundId: number;
    refundDate: string;
    amount: number;
    bankTransactionId: number | null;
    note: string | null;
  }>;
  claimPayments?: Array<{
    claimPaymentId: number;
    paymentDate: string;
    amount: number;
    bankTransactionId: number | null;
    note: string | null;
  }>;
  badDebtWriteOffs?: Array<{
    writeOffId: number;
    writeOffDate: string;
    grossAmount: number;
    netAmount: number;
    vatAmount: number;
    journalEntryId: number;
    note: string | null;
  }>;
  reminders?: Array<{
    reminderId: number;
    reminderDate: string;
    feeAmount: number;
    note: string | null;
    journalEntryId: number | null;
  }>;
  compensationClaims?: Array<{
    claimId: number;
    claimDate: string;
    amountDkk: number;
    note: string | null;
    journalEntryId: number | null;
  }>;
  interestClaims?: Array<{
    claimId: number;
    claimDate: string;
    amountDkk: number;
    referenceRatePercent: number;
    annualInterestRatePercent: number;
    overdueDays: number;
    note: string | null;
    journalEntryId: number | null;
  }>;
  totalReminderFees?: number;
  totalCompensationClaims?: number;
  totalInterestClaims?: number;
  totalClaimPayments?: number;
  totalBadDebtWrittenOff?: number;
  errors: string[];
};

const RULE_ID = "DK-INVOICE-PAYMENT-001";
const CORRECTION_BALANCE_RULE_ID = "DK-INVOICE-CORRECTION-BALANCE-001";
const DUE_DATE_RULE_ID = "DK-INVOICE-DUE-DATE-001";

function looksLikeIsoDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}
function round2(value: number) { return Number(value.toFixed(2)); }
function isoDate(value: Date) { return value.toISOString().slice(0, 10); }
function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}
function diffDays(fromDate: string, toDate: string) {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  return Math.floor((to - from) / 86400000);
}

function getIssuedInvoice(db: Database, documentId: number) {
  return db.query(
    `SELECT id, invoice_no, amount_inc_vat, currency, document_type, status, invoice_date, payload_json
     FROM documents WHERE id = ?`
  ).get(documentId) as { id: number; invoice_no: string; amount_inc_vat: number; currency: string; document_type: string; status: string; invoice_date: string | null; payload_json: string | null } | null;
}

export function getInvoiceStatus(db: Database, invoiceDocumentId: number, asOfDate?: string): InvoiceStatusResult {
  const invoice = getIssuedInvoice(db, invoiceDocumentId);
  if (!invoice) return { ok: false, errors: [`invoice document ${invoiceDocumentId} does not exist`] };
  if (invoice.document_type !== "issued_invoice") return { ok: false, errors: [`document ${invoiceDocumentId} is not an issued invoice`] };

  const payload = invoice.payload_json ? JSON.parse(invoice.payload_json) : null;

  const payments = db.query(
    `SELECT p.id, p.payment_date, p.amount, p.bank_transaction_id, p.journal_entry_id, p.note
     FROM invoice_payments p
     JOIN journal_entries j ON j.id = p.journal_entry_id
     WHERE p.invoice_document_id = ?
     ORDER BY p.id ASC`
  ).all(invoiceDocumentId) as Array<{ id: number; payment_date: string; amount: number; bank_transaction_id: number | null; journal_entry_id: number | null; note: string | null }>;

  const creditNotes = db.query(
    `SELECT id, invoice_no, amount_inc_vat, invoice_date
     FROM documents
     WHERE document_type = 'credit_note' AND payment_details = ?
     ORDER BY id ASC`
  ).all(invoice.invoice_no) as Array<{ id: number; invoice_no: string; amount_inc_vat: number | null; invoice_date: string | null }>;

  const refunds = db.query(
    `SELECT id, refund_date, amount, bank_transaction_id, note
     FROM invoice_refunds WHERE invoice_document_id = ? ORDER BY id ASC`
  ).all(invoiceDocumentId) as Array<{ id: number; refund_date: string; amount: number; bank_transaction_id: number | null; note: string | null }>;

  const claimPayments = db.query(
    `SELECT id, payment_date, amount, bank_transaction_id, note
     FROM invoice_claim_payments WHERE invoice_document_id = ? ORDER BY id ASC`
  ).all(invoiceDocumentId) as Array<{ id: number; payment_date: string; amount: number; bank_transaction_id: number | null; note: string | null }>;

  const badDebtWriteOffs = db.query(
    `SELECT id, writeoff_date, gross_amount, net_amount, vat_amount, journal_entry_id, note
     FROM invoice_bad_debt_writeoffs WHERE invoice_document_id = ? ORDER BY id ASC`
  ).all(invoiceDocumentId) as Array<{ id: number; writeoff_date: string; gross_amount: number; net_amount: number; vat_amount: number; journal_entry_id: number; note: string | null }>;

  const reminders = db.query(
    `SELECT r.id, r.reminder_date, r.fee_amount, r.note, p.journal_entry_id
     FROM invoice_reminders r
     LEFT JOIN invoice_reminder_postings p ON p.reminder_id = r.id
     WHERE r.invoice_document_id = ? ORDER BY r.reminder_date ASC, r.id ASC`
  ).all(invoiceDocumentId) as Array<{ id: number; reminder_date: string; fee_amount: number; note: string | null; journal_entry_id: number | null }>;

  const compensationClaims = db.query(
    `SELECT c.id, c.claim_date, c.amount_dkk, c.note, p.journal_entry_id
     FROM invoice_compensation_claims c
     LEFT JOIN invoice_compensation_postings p ON p.compensation_claim_id = c.id
     WHERE c.invoice_document_id = ? ORDER BY c.claim_date ASC, c.id ASC`
  ).all(invoiceDocumentId) as Array<{ id: number; claim_date: string; amount_dkk: number; note: string | null; journal_entry_id: number | null }>;

  const interestClaims = db.query(
    `SELECT c.id, c.claim_date, c.amount_dkk, c.reference_rate_percent, c.annual_interest_rate_percent, c.overdue_days, c.note, p.journal_entry_id
     FROM invoice_interest_claims c
     LEFT JOIN invoice_interest_postings p ON p.interest_claim_id = c.id
     WHERE c.invoice_document_id = ? ORDER BY c.claim_date ASC, c.id ASC`
  ).all(invoiceDocumentId) as Array<{ id: number; claim_date: string; amount_dkk: number; reference_rate_percent: number; annual_interest_rate_percent: number; overdue_days: number; note: string | null; journal_entry_id: number | null }>;

  const grossAmount = round2(Number(invoice.amount_inc_vat ?? 0));
  const creditedAmount = round2(creditNotes.reduce((sum, c) => sum + Number(c.amount_inc_vat ?? 0), 0));
  const paidAmount = round2(payments.reduce((sum, p) => sum + Number(p.amount), 0));
  const refundedAmount = round2(refunds.reduce((sum, r) => sum + Number(r.amount), 0));
  const totalReminderFees = round2(reminders.reduce((sum, r) => sum + Number(r.fee_amount), 0));
  const totalCompensationClaims = round2(compensationClaims.reduce((sum, c) => sum + Number(c.amount_dkk), 0));
  const totalInterestClaims = round2(interestClaims.reduce((sum, c) => sum + Number(c.amount_dkk), 0));
  const totalClaimPayments = round2(claimPayments.reduce((sum, p) => sum + Number(p.amount), 0));
  const totalBadDebtWrittenOff = round2(badDebtWriteOffs.reduce((sum, w) => sum + Number(w.gross_amount), 0));
  const openBalance = round2(grossAmount - creditedAmount - paidAmount + refundedAmount - totalBadDebtWrittenOff);
  const claimOpenBalance = round2(openBalance + totalReminderFees + totalCompensationClaims + totalInterestClaims - totalClaimPayments);
  const dueDate = typeof payload?.dueDate === "string" ? payload.dueDate : undefined;
  const effectiveDueDate = dueDate ?? (invoice.invoice_date ? addDays(invoice.invoice_date, 30) : undefined);
  const comparisonDate = asOfDate ?? isoDate(new Date());
  const overdueDays = effectiveDueDate && openBalance > 0 ? Math.max(0, diffDays(effectiveDueDate, comparisonDate)) : 0;
  const isOverdue = overdueDays > 0;
  const status = openBalance > 0
    ? "open"
    : openBalance < 0
      ? "overpaid"
      : creditedAmount > 0 && refundedAmount > 0
        ? "refunded"
        : creditedAmount === grossAmount && paidAmount === 0
          ? "credited"
          : totalBadDebtWrittenOff > 0
            ? "written_off"
            : "paid";

  return {
    ok: true,
    invoiceDocumentId,
    invoiceNumber: invoice.invoice_no,
    grossAmount,
    creditedAmount,
    paidAmount,
    openBalance,
    claimOpenBalance,
    dueDate,
    effectiveDueDate,
    isOverdue,
    overdueDays,
    status,
    payments: payments.map((p) => ({ paymentId: p.id, paymentDate: p.payment_date, amount: round2(Number(p.amount)), bankTransactionId: p.bank_transaction_id, journalEntryId: p.journal_entry_id == null ? null : Number(p.journal_entry_id), note: p.note })),
    creditNotes: creditNotes.map((c) => ({ documentId: c.id, creditNoteNumber: c.invoice_no, amount: round2(Number(c.amount_inc_vat ?? 0)), issueDate: c.invoice_date })),
    refunds: refunds.map((r) => ({ refundId: r.id, refundDate: r.refund_date, amount: round2(Number(r.amount)), bankTransactionId: r.bank_transaction_id, note: r.note })),
    claimPayments: claimPayments.map((p) => ({ claimPaymentId: p.id, paymentDate: p.payment_date, amount: round2(Number(p.amount)), bankTransactionId: p.bank_transaction_id, note: p.note })),
    badDebtWriteOffs: badDebtWriteOffs.map((w) => ({ writeOffId: w.id, writeOffDate: w.writeoff_date, grossAmount: round2(Number(w.gross_amount)), netAmount: round2(Number(w.net_amount)), vatAmount: round2(Number(w.vat_amount)), journalEntryId: Number(w.journal_entry_id), note: w.note })),
    reminders: reminders.map((r) => ({ reminderId: r.id, reminderDate: r.reminder_date, feeAmount: round2(Number(r.fee_amount)), note: r.note, journalEntryId: r.journal_entry_id == null ? null : Number(r.journal_entry_id) })),
    compensationClaims: compensationClaims.map((c) => ({ claimId: c.id, claimDate: c.claim_date, amountDkk: round2(Number(c.amount_dkk)), note: c.note, journalEntryId: c.journal_entry_id == null ? null : Number(c.journal_entry_id) })),
    interestClaims: interestClaims.map((c) => ({ claimId: c.id, claimDate: c.claim_date, amountDkk: round2(Number(c.amount_dkk)), referenceRatePercent: round2(Number(c.reference_rate_percent)), annualInterestRatePercent: round2(Number(c.annual_interest_rate_percent)), overdueDays: Number(c.overdue_days), note: c.note, journalEntryId: c.journal_entry_id == null ? null : Number(c.journal_entry_id) })),
    totalReminderFees,
    totalCompensationClaims,
    totalInterestClaims,
    totalClaimPayments,
    totalBadDebtWrittenOff,
    errors: [],
  };
}

export function applyInvoicePayment(db: Database, input: ApplyInvoicePaymentInput): ApplyInvoicePaymentResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) errors.push("invoiceDocumentId must be a positive integer");
  if (!looksLikeIsoDate(input.paymentDate)) errors.push("paymentDate must be YYYY-MM-DD");
  if (!Number.isFinite(input.amount) || input.amount <= 0) errors.push("amount must be a positive number");
  if (input.bankTransactionId !== undefined && (!Number.isInteger(input.bankTransactionId) || input.bankTransactionId <= 0)) errors.push("bankTransactionId must be a positive integer when present");
  if (input.journalEntryId !== undefined && (!Number.isInteger(input.journalEntryId) || input.journalEntryId <= 0)) errors.push("journalEntryId must be a positive integer when present");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const invoice = getIssuedInvoice(db, input.invoiceDocumentId);
  if (!invoice) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice document ${input.invoiceDocumentId} does not exist`] };
  if (invoice.document_type !== "issued_invoice") return { ok: false, appliedRules: [RULE_ID], errors: [`document ${input.invoiceDocumentId} is not an issued invoice`] };
  if ((invoice.currency ?? "DKK") !== "DKK") return { ok: false, appliedRules: [RULE_ID], errors: ["only DKK issued invoices are supported in the current payment application flow"] };

  if (input.bankTransactionId !== undefined) {
    const bank = db.query("SELECT id FROM bank_transactions WHERE id = ?").get(input.bankTransactionId) as { id: number } | null;
    if (!bank) return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${input.bankTransactionId} does not exist`] };
    const alreadyLinked = db.query("SELECT id FROM invoice_payments WHERE bank_transaction_id = ? LIMIT 1").get(input.bankTransactionId) as { id: number } | null;
    if (alreadyLinked) return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${input.bankTransactionId} is already applied to an invoice payment`] };
  }

  const status = getInvoiceStatus(db, input.invoiceDocumentId);
  if (!status.ok) return { ok: false, appliedRules: [RULE_ID], errors: status.errors };
  const openBalance = round2(status.openBalance!);
  const amount = round2(input.amount);
  if (amount > openBalance) {
    return { ok: false, appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID], errors: [`payment amount ${amount} exceeds open invoice balance ${openBalance}`] };
  }

  try {
    const result = db.transaction(() => {
      let journalEntryId = input.journalEntryId;

      if (journalEntryId === undefined) {
        const journal = postJournalEntry(db, {
          transactionDate: input.paymentDate,
          text: input.bankTransactionId !== undefined ? `Customer payment for invoice ${invoice.invoice_no}` : `Manual invoice payment for invoice ${invoice.invoice_no}`,
          sourceBankTransactionId: input.bankTransactionId,
          documentId: input.invoiceDocumentId,
          createdBy: input.createdBy,
          createdByProgram: input.createdByProgram,
          lines: [
            { accountNo: input.bankAccountNo ?? "2000", debitAmount: amount, text: `Payment receipt ${invoice.invoice_no}` },
            { accountNo: input.receivableAccountNo ?? "1100", creditAmount: amount, text: `Receivable settlement ${invoice.invoice_no}` },
          ],
        });
        if (!journal.ok || journal.entryId == null) throw new Error(JSON.stringify({ appliedRules: journal.appliedRules, errors: journal.errors }));
        journalEntryId = journal.entryId;
      } else {
        const journal = db.query(
          `SELECT id, document_id, source_bank_transaction_id FROM journal_entries WHERE id = ?`
        ).get(journalEntryId) as { id: number; document_id: number | null; source_bank_transaction_id: number | null } | null;
        if (!journal) {
          throw new Error(JSON.stringify({ appliedRules: [RULE_ID], errors: [`journal entry ${journalEntryId} does not exist`] }));
        }
        if (journal.document_id !== input.invoiceDocumentId) {
          throw new Error(JSON.stringify({ appliedRules: [RULE_ID], errors: [`journal entry ${journalEntryId} is not linked to invoice document ${input.invoiceDocumentId}`] }));
        }
        if ((input.bankTransactionId ?? null) !== (journal.source_bank_transaction_id ?? null)) {
          throw new Error(JSON.stringify({ appliedRules: [RULE_ID], errors: [`journal entry ${journalEntryId} bank link does not match invoice payment bank transaction`] }));
        }
      }

      const paymentId = db.query(
        `INSERT INTO invoice_payments (invoice_document_id, bank_transaction_id, journal_entry_id, payment_date, amount, currency, note)
         VALUES (?, ?, ?, ?, ?, 'DKK', ?)
         RETURNING id`
      ).get(input.invoiceDocumentId, input.bankTransactionId ?? null, journalEntryId, input.paymentDate, amount, input.note ?? null) as { id: number };

      insertAuditLog(db, {
        eventType: "invoice_payment_apply",
        entityType: "invoice_payment",
        entityId: paymentId.id,
        message: `Applied payment ${amount} to invoice ${invoice.invoice_no}`,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
      });

      const after = getInvoiceStatus(db, input.invoiceDocumentId);
      if (!after.ok) throw new Error(JSON.stringify({ appliedRules: [RULE_ID], errors: after.errors }));

      return {
        ok: true,
        paymentId: paymentId.id,
        journalEntryId,
        invoiceDocumentId: input.invoiceDocumentId,
        invoiceNumber: invoice.invoice_no,
        openBalance: after.openBalance,
        appliedRules: [RULE_ID, CORRECTION_BALANCE_RULE_ID],
        errors: [],
      } satisfies ApplyInvoicePaymentResult;
    })();
    return result;
  } catch (error) {
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
