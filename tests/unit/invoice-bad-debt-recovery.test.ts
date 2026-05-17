import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { issueCreditNote } from "../../src/core/credit-notes";
import { writeOffInvoiceBadDebt } from "../../src/core/invoice-bad-debt";
import { recoverInvoiceBadDebtFromBank } from "../../src/core/invoice-bad-debt-recovery";
import { getInvoiceStatus } from "../../src/core/invoice-payments";
import { buildVatReport } from "../../src/core/vat";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";

describe("invoice bad debt recovery", () => {
  test("recovers part of a written-off invoice from bank and restores output VAT deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-recovery-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-1200",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);
    expect(writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
    }).ok).toBe(true);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, transaction_hash)
       VALUES ('2026-07-15', '2026-07-15', 'Late customer recovery', 500, 'DKK', 'INV-REC-1', 'bank-hash-recovery-1')`
    );

    const recovery = recoverInvoiceBadDebtFromBank(db, {
      invoiceDocumentId: issued.documentId!,
      bankTransactionReference: "INV-REC-1",
    });
    expect(recovery.ok).toBe(true);
    expect(recovery.appliedRules).toContain("DK-INVOICE-BAD-DEBT-RECOVERY-001");
    expect(recovery.appliedRules).toContain("DK-VAT-BAD-DEBT-RECOVERY-001");
    expect(recovery.grossAmount).toBe(500);
    expect(recovery.netAmount).toBe(400);
    expect(recovery.vatAmount).toBe(100);
    expect(recovery.remainingBadDebtExposure).toBe(750);

    const status = getInvoiceStatus(db, issued.documentId!, "2026-07-15");
    expect(status.ok).toBe(true);
    expect(status.status).toBe("written_off");
    expect(status.totalBadDebtWrittenOff).toBe(1250);
    expect(status.totalBadDebtRecovered).toBe(500);
    expect(status.remainingBadDebtExposure).toBe(750);
    expect(status.badDebtRecoveries).toHaveLength(1);

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(recovery.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "2000", debit_amount: 500, credit_amount: 0, vat_code: null },
      { account_no: "3080", debit_amount: 0, credit_amount: 400, vat_code: "DK_BAD_DEBT_RECOVERY_25" },
      { account_no: "1200", debit_amount: 0, credit_amount: 100, vat_code: null },
    ]);

    const vat = buildVatReport(db, "2026-05-01", "2026-07-31");
    expect(vat.ok).toBe(true);
    expect(vat.outputVat).toBe(100);
    expect(vat.badDebtReliefBase25).toBe(1000);
    expect(vat.badDebtRecoveryBase25).toBe(400);

    expect(verifyAuditChain(db).ok).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("recovers only the corrected written-off balance after a prior credit note", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-recovery-credit-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-1200C",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);
    expect(issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-06-20",
      reason: "Partial correction",
      grossAmount: 625,
    }).ok).toBe(true);
    expect(writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
    }).ok).toBe(true);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, transaction_hash)
       VALUES ('2026-07-15', '2026-07-15', 'Late corrected recovery', 300, 'DKK', 'INV-REC-CREDIT-1', 'bank-hash-recovery-credit-1')`
    );

    const recovery = recoverInvoiceBadDebtFromBank(db, {
      invoiceDocumentId: issued.documentId!,
      bankTransactionReference: "INV-REC-CREDIT-1",
    });
    expect(recovery.ok).toBe(true);
    expect(recovery.appliedRules).toContain("DK-INVOICE-BAD-DEBT-RECOVERY-CORRECTED-BALANCE-001");
    expect(recovery.grossAmount).toBe(300);
    expect(recovery.netAmount).toBe(240);
    expect(recovery.vatAmount).toBe(60);
    expect(recovery.remainingBadDebtExposure).toBe(325);

    const status = getInvoiceStatus(db, issued.documentId!, "2026-07-15");
    expect(status.ok).toBe(true);
    expect(status.creditedAmount).toBe(625);
    expect(status.totalBadDebtWrittenOff).toBe(625);
    expect(status.totalBadDebtRecovered).toBe(300);
    expect(status.remainingBadDebtExposure).toBe(325);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("blocks recovery above unrecovered written-off balance", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-recovery-over-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-1201",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);
    expect(writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
    }).ok).toBe(true);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, transaction_hash)
       VALUES ('2026-07-15', '2026-07-15', 'Late customer recovery too large', 1300, 'DKK', 'INV-REC-2', 'bank-hash-recovery-2')`
    );

    const recovery = recoverInvoiceBadDebtFromBank(db, {
      invoiceDocumentId: issued.documentId!,
      bankTransactionReference: "INV-REC-2",
    });
    expect(recovery.ok).toBe(false);
    expect(recovery.appliedRules).toContain("DK-INVOICE-BAD-DEBT-RECOVERY-CORRECTED-BALANCE-001");
    expect(recovery.errors[0]).toContain("exceeds unrecovered corrected written-off balance");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
