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
    expect(may.badDebtRecoveryBase25).toBe(0);
    expect(may.journalEntryCount).toBe(2);

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

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });
});
