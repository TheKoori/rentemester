import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { issueInvoice } from "../../src/core/issued-invoices";
import { applyInvoicePayment, getInvoiceStatus } from "../../src/core/invoice-payments";
import { issueCreditNote } from "../../src/core/credit-notes";

describe("invoice payments", () => {
  test("applies payment to issued invoice and tracks open balance without over-application", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicepay-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0700",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK",
      dueDate: "2026-06-15"
    });
    expect(issued.ok).toBe(true);

    const first = applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1000,
      note: "Partial payment"
    });
    expect(first.ok).toBe(true);
    expect(first.openBalance).toBe(250);
    expect(first.appliedRules).toContain("DK-INVOICE-PAYMENT-001");

    const status1 = getInvoiceStatus(db, issued.documentId!, "2026-06-20");
    expect(status1.ok).toBe(true);
    expect(status1.status).toBe("open");
    expect(status1.paidAmount).toBe(1000);
    expect(status1.openBalance).toBe(250);
    expect(status1.effectiveDueDate).toBe("2026-06-15");
    expect(status1.isOverdue).toBe(true);
    expect(status1.overdueDays).toBe(5);

    const overpay = applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-21",
      amount: 300,
      note: "Too much"
    });
    expect(overpay.ok).toBe(false);
    expect(overpay.errors[0]).toContain("exceeds open invoice balance");

    const second = applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-21",
      amount: 250,
      note: "Final payment"
    });
    expect(second.ok).toBe(true);
    expect(second.openBalance).toBe(0);

    const status2 = getInvoiceStatus(db, issued.documentId!);
    expect(status2.asOfDate).toBe("2026-06-15");
    expect(status2.status).toBe("paid");
    expect(status2.paidAmount).toBe(1250);
    expect(status2.openBalance).toBe(0);
    expect(status2.payments).toHaveLength(2);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("defaults invoice status comparisons to persisted invoice dates instead of wall-clock time", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-status-deterministic-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0700C",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK",
      dueDate: "2026-06-15"
    });
    expect(issued.ok).toBe(true);

    const status = getInvoiceStatus(db, issued.documentId!);
    expect(status.ok).toBe(true);
    expect(status.asOfDate).toBe("2026-06-15");
    expect(status.isOverdue).toBe(false);
    expect(status.overdueDays).toBe(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects direct invoice payment inserts without journal evidence and ignores orphaned rows in status", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicepay-proof-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0700B",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK",
      dueDate: "2026-06-15"
    });
    expect(issued.ok).toBe(true);

    expect(() => db.run(
      `INSERT INTO invoice_payments (invoice_document_id, payment_date, amount, currency, note)
       VALUES (?, ?, ?, 'DKK', ?)`,
      issued.documentId!,
      "2026-05-20",
      1000,
      "Manual entry"
    )).toThrow("invoice payments must reference a journal entry");

    db.exec("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO invoice_payments (invoice_document_id, payment_date, amount, currency, journal_entry_id, note)
       VALUES (?, ?, ?, 'DKK', ?, ?)`,
      issued.documentId!,
      "2026-05-20",
      1000,
      999999,
      "Broken legacy import"
    );
    db.exec("PRAGMA foreign_keys = ON");

    const status = getInvoiceStatus(db, issued.documentId!);
    expect(status.ok).toBe(true);
    expect(status.paidAmount).toBe(0);
    expect(status.openBalance).toBe(1250);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(false);
    expect(chain.errors.some((error) => error.includes("invoice payment") && error.includes("missing journal evidence"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("reduces open balance by linked credit notes before accepting payment", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicecredit-balance-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0701",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    const firstCredit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Half cancelled",
      grossAmount: 625
    });
    expect(firstCredit.ok).toBe(true);

    const midStatus = getInvoiceStatus(db, issued.documentId!);
    expect(midStatus.ok).toBe(true);
    expect(midStatus.creditedAmount).toBe(625);
    expect(midStatus.openBalance).toBe(625);
    expect(midStatus.status).toBe("open");

    const secondCredit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-18",
      reason: "Rest cancelled"
    });
    expect(secondCredit.ok).toBe(true);

    const status = getInvoiceStatus(db, issued.documentId!, "2026-06-20");
    expect(status.ok).toBe(true);
    expect(status.creditedAmount).toBe(1250);
    expect(status.openBalance).toBe(0);
    expect(status.status).toBe("credited");
    expect(status.effectiveDueDate).toBe("2026-06-15");
    expect(status.isOverdue).toBe(false);
    expect(status.creditNotes).toHaveLength(2);
    expect(status.refunds).toHaveLength(0);

    const payment = applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1,
      note: "Should be blocked after full credit"
    });
    expect(payment.ok).toBe(false);
    expect(payment.errors[0]).toContain("exceeds open invoice balance 0");
    expect(payment.appliedRules).toContain("DK-INVOICE-CORRECTION-BALANCE-001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects direct invoice refund inserts without journal evidence and audit verify flags orphaned refund rows", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-refund-proof-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0702",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    expect(() => db.run(
      `INSERT INTO invoice_refunds (invoice_document_id, refund_date, amount, currency, note)
       VALUES (?, ?, ?, 'DKK', ?)`,
      issued.documentId!,
      "2026-05-20",
      100,
      "Manual refund entry"
    )).toThrow("invoice refunds must reference a journal entry");

    db.exec("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO invoice_refunds (invoice_document_id, refund_date, amount, currency, journal_entry_id, note)
       VALUES (?, ?, ?, 'DKK', ?, ?)`,
      issued.documentId!,
      "2026-05-20",
      100,
      999999,
      "Broken legacy refund import"
    );
    db.exec("PRAGMA foreign_keys = ON");

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("invoice refund") && error.includes("missing journal evidence"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects direct invoice claim-payment inserts without journal evidence and audit verify flags orphaned claim-payment rows", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-claim-proof-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0703",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    expect(() => db.run(
      `INSERT INTO invoice_claim_payments (invoice_document_id, payment_date, amount, currency, note)
       VALUES (?, ?, ?, 'DKK', ?)`,
      issued.documentId!,
      "2026-05-20",
      100,
      "Manual claim payment entry"
    )).toThrow("invoice claim payments must reference a journal entry");

    db.exec("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO invoice_claim_payments (invoice_document_id, payment_date, amount, currency, journal_entry_id, note)
       VALUES (?, ?, ?, 'DKK', ?, ?)`,
      issued.documentId!,
      "2026-05-20",
      100,
      999999,
      "Broken legacy claim payment import"
    );
    db.exec("PRAGMA foreign_keys = ON");

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("invoice claim payment") && error.includes("missing journal evidence"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
