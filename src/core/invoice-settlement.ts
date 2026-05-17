import type { Database } from "bun:sqlite";
import { applyInvoicePayment, getInvoiceStatus } from "./invoice-payments";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { insertAuditLog } from "./actor";

const RULE_ID = "DK-INVOICE-SETTLEMENT-001";
const COMBINED_RULE_ID = "DK-INVOICE-COMBINED-SETTLEMENT-001";

export type SettleInvoiceFromBankInput = {
  invoiceDocumentId: number;
  bankTransactionId?: number;
  bankTransactionReference?: string;
  paymentDate?: string;
  amount?: number;
  bankAccountNo?: string;
  receivableAccountNo?: string;
  createdBy?: string;
  createdByProgram?: string;
};

export type SettleInvoiceFromBankResult = JournalPostResult & {
  paymentId?: number;
  claimPaymentId?: number;
  principalAmount?: number;
  claimAmount?: number;
  invoiceNumber?: string;
  openBalance?: number;
  claimOpenBalance?: number;
};

function round2(value: number) {
  return Number(value.toFixed(2));
}

export function settleInvoiceFromBank(db: Database, input: SettleInvoiceFromBankInput): SettleInvoiceFromBankResult {
  if (!Number.isInteger(input.invoiceDocumentId) || input.invoiceDocumentId <= 0) {
    return { ok: false, appliedRules: [RULE_ID], errors: ["invoiceDocumentId must be a positive integer"] };
  }
  if (input.bankTransactionId !== undefined && (!Number.isInteger(input.bankTransactionId) || input.bankTransactionId <= 0)) {
    return { ok: false, appliedRules: [RULE_ID], errors: ["bankTransactionId must be a positive integer when present"] };
  }

  const bank = (input.bankTransactionId !== undefined
    ? db.query(`SELECT id, transaction_date, amount, text, reference FROM bank_transactions WHERE id = ?`).get(input.bankTransactionId)
    : input.bankTransactionReference
      ? db.query(`SELECT id, transaction_date, amount, text, reference FROM bank_transactions WHERE reference = ? ORDER BY id DESC LIMIT 1`).get(input.bankTransactionReference)
      : db.query(`SELECT id, transaction_date, amount, text, reference FROM bank_transactions WHERE amount > 0 ORDER BY id DESC LIMIT 1`).get()) as { id: number; transaction_date: string; amount: number; text: string; reference: string | null } | null;
  if (!bank) return { ok: false, appliedRules: [RULE_ID], errors: [input.bankTransactionId !== undefined ? `bank transaction ${input.bankTransactionId} does not exist` : input.bankTransactionReference ? `no bank transaction found with reference ${input.bankTransactionReference}` : "no incoming bank transaction available for settlement"] };
  if (Number(bank.amount) <= 0) return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${input.bankTransactionId} is not an incoming customer receipt`] };

  const invoice = db.query(
    `SELECT id, invoice_no FROM documents WHERE id = ? AND document_type = 'issued_invoice'`
  ).get(input.invoiceDocumentId) as { id: number; invoice_no: string } | null;
  if (!invoice) return { ok: false, appliedRules: [RULE_ID], errors: [`invoice document ${input.invoiceDocumentId} is not an issued invoice`] };

  const existingJournal = db.query(
    `SELECT id FROM journal_entries WHERE source_bank_transaction_id = ? LIMIT 1`
  ).get(bank.id) as { id: number } | null;
  if (existingJournal) return { ok: false, appliedRules: [RULE_ID], errors: [`bank transaction ${bank.id} is already linked to journal entry ${existingJournal.id}`] };

  const amount = round2(input.amount ?? Number(bank.amount));
  const paymentDate = input.paymentDate ?? bank.transaction_date;
  const before = getInvoiceStatus(db, input.invoiceDocumentId);
  if (!before.ok) return { ok: false, appliedRules: [RULE_ID], errors: before.errors };
  const principalOpenBalance = round2(Number(before.openBalance ?? 0));
  const claimOpenBalance = round2(Number(before.claimOpenBalance ?? 0));

  try {
    const result = db.transaction(() => {
      const isCombined = amount > principalOpenBalance && principalOpenBalance > 0;
      if (amount > claimOpenBalance) {
        throw new Error(JSON.stringify({ appliedRules: [isCombined ? COMBINED_RULE_ID : RULE_ID], errors: [`settlement amount ${amount} exceeds invoice claim open balance ${claimOpenBalance}`] }));
      }

      let paymentId: number | undefined;
      let claimPaymentId: number | undefined;
      let principalAmount = amount;
      let claimAmount = 0;
      const appliedRules = new Set<string>([RULE_ID]);

      if (isCombined) {
        principalAmount = principalOpenBalance;
        claimAmount = round2(amount - principalAmount);
        if (claimAmount <= 0) {
          throw new Error(JSON.stringify({ appliedRules: [COMBINED_RULE_ID], errors: ["combined settlement produced no claim component"] }));
        }
        appliedRules.add(COMBINED_RULE_ID);
      }

      let journalEntryId: number | undefined;

      if (claimAmount > 0) {
        const journal = postJournalEntry(db, {
          transactionDate: paymentDate,
          text: `Customer payment incl. claims for invoice ${invoice.invoice_no}`,
          sourceBankTransactionId: bank.id,
          documentId: input.invoiceDocumentId,
          createdBy: input.createdBy,
          createdByProgram: input.createdByProgram,
          lines: [
            { accountNo: input.bankAccountNo ?? "2000", debitAmount: amount, text: `Bank receipt ${invoice.invoice_no}` },
            { accountNo: input.receivableAccountNo ?? "1100", creditAmount: amount, text: `Principal and claim settlement ${invoice.invoice_no}` },
          ],
        });
        if (!journal.ok || journal.entryId == null) throw new Error(JSON.stringify({ appliedRules: journal.appliedRules, errors: journal.errors }));
        journalEntryId = journal.entryId;
        for (const rule of journal.appliedRules ?? []) appliedRules.add(rule);
      }

      const payment = applyInvoicePayment(db, {
        invoiceDocumentId: input.invoiceDocumentId,
        bankTransactionId: bank.id,
        journalEntryId,
        paymentDate,
        amount: principalAmount,
        bankAccountNo: input.bankAccountNo,
        receivableAccountNo: input.receivableAccountNo,
        createdBy: input.createdBy,
        createdByProgram: input.createdByProgram,
        note: `Bank settlement from transaction ${bank.id}`,
      });
      if (!payment.ok) throw new Error(JSON.stringify({ appliedRules: payment.appliedRules, errors: payment.errors }));
      paymentId = payment.paymentId;
      journalEntryId = payment.journalEntryId;
      for (const rule of payment.appliedRules ?? []) appliedRules.add(rule);

      if (claimAmount > 0) {
        const claimPayment = db.query(
          `INSERT INTO invoice_claim_payments (invoice_document_id, bank_transaction_id, payment_date, amount, currency, note)
           VALUES (?, ?, ?, ?, 'DKK', ?)
           RETURNING id`
        ).get(input.invoiceDocumentId, bank.id, paymentDate, claimAmount, `Combined settlement claim component from transaction ${bank.id}`) as { id: number };
        claimPaymentId = claimPayment.id;
        insertAuditLog(db, {
          eventType: "invoice_claim_payment_apply",
          entityType: "invoice_claim_payment",
          entityId: claimPayment.id,
          message: `Applied claim receipt ${claimAmount} to invoice ${invoice.invoice_no} via combined settlement`,
          createdBy: input.createdBy,
          createdByProgram: input.createdByProgram,
        });
      }

      const after = getInvoiceStatus(db, input.invoiceDocumentId);
      if (!after.ok) throw new Error(JSON.stringify({ errors: after.errors }));

      return {
        ok: true,
        entryId: journalEntryId,
        paymentId,
        claimPaymentId,
        principalAmount,
        claimAmount,
        invoiceNumber: invoice.invoice_no,
        openBalance: after.openBalance,
        claimOpenBalance: after.claimOpenBalance,
        appliedRules: [...appliedRules],
        errors: [],
      };
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
