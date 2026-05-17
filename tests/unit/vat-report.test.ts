import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { buildVatReport } from "../../src/core/vat";
import { postJournalEntry, reverseJournalEntry, seedAccounts } from "../../src/core/ledger";

describe("vat report", () => {
  test("builds deterministic VAT totals from journal entries in a period", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-vat-inbox-"));
    const sourceFile = join(inbox, "invoice.txt");
    writeFileSync(sourceFile, "Invoice\n1250 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-VAT-1",
      deliveryDescription: "Softwareabonnement",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Bankoverførsel"
    });
    expect(doc.ok).toBe(true);

    const sale = postJournalEntry(db, {
      transactionDate: "2026-05-10",
      text: "Consulting sale",
      documentId: doc.documentId,
      lines: [
        { accountNo: "2000", debitAmount: 1250 },
        { accountNo: "1000", creditAmount: 1000, vatCode: "DK_SALE_25" },
        { accountNo: "1200", creditAmount: 250 }
      ]
    });
    expect(sale.ok).toBe(true);

    const purchase = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Software purchase",
      documentId: doc.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 }
      ]
    });
    expect(purchase.ok).toBe(true);

    const may = buildVatReport(db, "2026-05-01", "2026-05-31");
    expect(may.ok).toBe(true);
    expect(may.outputVat).toBe(250);
    expect(may.inputVat).toBe(250);
    expect(may.netVatPayable).toBe(0);
    expect(may.salesBase25).toBe(1000);
    expect(may.purchaseBase25).toBe(1000);
    expect(may.badDebtReliefBase25).toBe(0);
    expect(may.taxAgencyMapping).toEqual({
      rubrikA_outputVatDomestic: 250,
      rubrikB_euGoodsPurchaseVat: 0,
      rubrikC_euServicesPurchaseVat: 0,
      rubrikD_inputVatDomestic: 250,
      rubrikE_euGoodsSale: 0,
      rubrikF_euServicesSale: 0,
      rubrikG_exportOutsideEu: 0,
      netToPayOrReceive: 0,
    });
    expect(may.formGuidance).toEqual({
      skatTastSelvUrl: "https://www.skat.dk/tastselv/erhverv",
      periodLabel: "2026-05-01..2026-05-31",
      companyCvr: "DK12345678",
    });
    expect(may.journalEntryCount).toBe(2);
    expect(may.totalJournalEntryCount).toBe(2);
    expect(may.warnings).toEqual([]);

    const reversed = reverseJournalEntry(db, {
      entryId: sale.entryId!,
      transactionDate: "2026-06-01",
      reason: "Sale moved to next month"
    });
    expect(reversed.ok).toBe(true);

    const june = buildVatReport(db, "2026-06-01", "2026-06-30");
    expect(june.ok).toBe(true);
    expect(june.outputVat).toBe(-250);
    expect(june.salesBase25).toBe(-1000);
    expect(june.netVatPayable).toBe(-250);
    expect(june.journalEntryCount).toBe(0);
    expect(june.reversalJournalEntryCount).toBe(1);
    expect(june.reversedJournalEntryCount).toBe(0);
    expect(june.totalJournalEntryCount).toBe(1);
    expect(june.linesConsidered).toBe(0);
    expect(june.reversalLinesConsidered).toBe(3);
    expect(june.totalLinesConsidered).toBe(3);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("warns when VAT base and booked VAT do not reconcile and distinguishes reversed entries in-period", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-warning-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-vat-warning-inbox-"));
    const sourceFile = join(inbox, "invoice.txt");
    writeFileSync(sourceFile, "Invoice\n1250 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-VAT-2",
      deliveryDescription: "Softwareabonnement",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Bankoverførsel"
    });
    expect(doc.ok).toBe(true);

    const brokenPurchase = postJournalEntry(db, {
      transactionDate: "2026-05-12",
      text: "Broken VAT booking",
      documentId: doc.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
        { accountNo: "2000", creditAmount: 1000 }
      ]
    });
    expect(brokenPurchase.ok).toBe(true);

    const reversibleSale = postJournalEntry(db, {
      transactionDate: "2026-05-13",
      text: "Sale booked then reversed",
      documentId: doc.documentId,
      lines: [
        { accountNo: "2000", debitAmount: 1250 },
        { accountNo: "1000", creditAmount: 1000, vatCode: "DK_SALE_25" },
        { accountNo: "1200", creditAmount: 250 }
      ]
    });
    expect(reversibleSale.ok).toBe(true);

    const reversed = reverseJournalEntry(db, {
      entryId: reversibleSale.entryId!,
      transactionDate: "2026-05-20",
      reason: "Booked in wrong month"
    });
    expect(reversed.ok).toBe(true);

    const report = buildVatReport(db, "2026-05-01", "2026-05-31");
    expect(report.ok).toBe(true);
    expect(report.purchaseBase25).toBe(1000);
    expect(report.inputVat).toBe(0);
    expect(report.outputVat).toBe(0);
    expect(report.netVatPayable).toBe(0);
    expect(report.journalEntryCount).toBe(1);
    expect(report.reversedJournalEntryCount).toBe(1);
    expect(report.reversalJournalEntryCount).toBe(1);
    expect(report.totalJournalEntryCount).toBe(3);
    expect(report.linesConsidered).toBe(2);
    expect(report.reversedLinesConsidered).toBe(3);
    expect(report.reversalLinesConsidered).toBe(3);
    expect(report.totalLinesConsidered).toBe(8);
    expect(report.warnings).toContain("input VAT mismatch: booked 0, expected from base × rate 250");
  });

  test("separates reverse-charge VAT into TastSelv rubrik C instead of domestic rubrik A/D", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-vat-rubrik-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-vat-rubrik-inbox-"));
    const sourceFile = join(inbox, "invoice.txt");
    writeFileSync(sourceFile, "EU service invoice\n1000 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-VAT-RC-1",
      deliveryDescription: "EU software service",
      amountIncVat: 1000,
      currency: "DKK",
      sender: { name: "EU Supplier GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 0,
      paymentDetails: "Bank transfer"
    });
    expect(doc.ok).toBe(true);

    expect(postJournalEntry(db, {
      transactionDate: "2026-05-17",
      text: "EU service purchase",
      documentId: doc.documentId,
      lines: [
        { accountNo: "3010", debitAmount: 1000, vatCode: "EU_SERVICE_REVERSE_CHARGE" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1000 },
        { accountNo: "1200", creditAmount: 250 }
      ]
    }).ok).toBe(true);

    const report = buildVatReport(db, "2026-05-01", "2026-05-31");
    expect(report.ok).toBe(true);
    expect(report.taxAgencyMapping).toEqual({
      rubrikA_outputVatDomestic: 0,
      rubrikB_euGoodsPurchaseVat: 0,
      rubrikC_euServicesPurchaseVat: 250,
      rubrikD_inputVatDomestic: 0,
      rubrikE_euGoodsSale: 0,
      rubrikF_euServicesSale: 0,
      rubrikG_exportOutsideEu: 0,
      netToPayOrReceive: 250,
    });
    expect(report.netVatPayable).toBe(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });
});
