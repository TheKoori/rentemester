import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { postJournalEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";

describe("journal posting", () => {
  test("rejects unbalanced journal entries", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const result = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Broken posting",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 900 }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("journal entry must balance: debit 1000 != credit 900");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("supports foreign-currency journal entries with stored FX basis", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-fx-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-inbox-fx-"));
    const sourceFile = join(inbox, "vendor-eur.txt");
    writeFileSync(sourceFile, "Vendor invoice\n100 EUR\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-19",
      invoiceNo: "INV-EUR-1",
      deliveryDescription: "Softwareabonnement EUR",
      amountIncVat: 746,
      currency: "DKK",
      sender: { name: "Leverandør GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 149.2,
      paymentDetails: "Kortbetaling"
    });
    expect(doc.ok).toBe(true);

    const badFx = postJournalEntry(db, {
      transactionDate: "2026-05-19",
      text: "FX journal without conversion basis",
      documentId: doc.documentId,
      currency: "EUR",
      lines: [
        { accountNo: "3000", debitAmount: 596.8, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 149.2 },
        { accountNo: "2000", creditAmount: 746 }
      ]
    });
    expect(badFx.ok).toBe(false);
    expect(badFx.errors).toContain("amountForeign must be positive for non-DKK journal entries");

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-19",
      text: "FX journal with conversion basis",
      documentId: doc.documentId,
      currency: "EUR",
      amountForeign: 100,
      amountDkk: 746,
      fxRateToDkk: 7.46,
      lines: [
        { accountNo: "3000", debitAmount: 596.8, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 149.2 },
        { accountNo: "2000", creditAmount: 746 }
      ]
    });

    expect(posted.ok).toBe(true);
    expect(posted.appliedRules).toContain("DK-BOOKKEEPING-FX-001");
    const entry = db.query("SELECT currency, amount_foreign, amount_dkk, fx_rate_to_dkk FROM journal_entries WHERE id = ?").get(posted.entryId!) as any;
    expect(entry).toEqual({ currency: "EUR", amount_foreign: 100, amount_dkk: 746, fx_rate_to_dkk: 7.46 });

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("records a non-system actor from environment in journal entries and audit log", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-actor-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const prevActor = process.env.RENTEMESTER_ACTOR;
    const prevVia = process.env.RENTEMESTER_ACTOR_VIA;
    process.env.RENTEMESTER_ACTOR = "agent:freja";
    process.env.RENTEMESTER_ACTOR_VIA = "openclaw";

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Owner contribution",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });

    if (prevActor === undefined) delete process.env.RENTEMESTER_ACTOR; else process.env.RENTEMESTER_ACTOR = prevActor;
    if (prevVia === undefined) delete process.env.RENTEMESTER_ACTOR_VIA; else process.env.RENTEMESTER_ACTOR_VIA = prevVia;

    expect(posted.ok).toBe(true);
    const entry = db.query("SELECT created_by, created_by_program FROM journal_entries WHERE id = ?").get(posted.entryId!) as any;
    expect(entry).toEqual({ created_by: "agent:freja", created_by_program: "openclaw" });
    const audit = db.query("SELECT actor FROM audit_log WHERE event_type = 'journal_post' ORDER BY id DESC LIMIT 1").get() as any;
    expect(audit.actor).toBe("agent:freja via openclaw");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("requires document evidence for expense or income postings and hashes lines into the audit chain", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-journal-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-inbox-"));
    const sourceFile = join(inbox, "vendor.txt");
    writeFileSync(sourceFile, "Vendor invoice\n1250 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const missingDoc = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Software expense without evidence",
      lines: [
        { accountNo: "3000", debitAmount: 1000 },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 }
      ]
    });
    expect(missingDoc.ok).toBe(false);
    expect(missingDoc.errors).toContain("documentId is required when posting expense or income lines");

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-3000",
      deliveryDescription: "Softwareabonnement",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Bankoverførsel"
    });
    expect(doc.ok).toBe(true);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Software expense with evidence",
      documentId: doc.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250, text: "Bank payment" }
      ]
    });

    expect(posted.ok).toBe(true);
    expect(posted.entryNo).toBeDefined();
    expect(posted.appliedRules).toContain("DK-BOOKKEEPING-DOCUMENT-001");

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);
    expect(chain.entries).toBe(1);

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code, jl.text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toHaveLength(3);
    expect(lines[0].vat_code).toBe("DK_PURCHASE_25");

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });
});

describe("ledger hardening", () => {
  test("prevents direct mutation of journal lines after posting", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-ledger-lines-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Owner contribution",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(posted.ok).toBe(true);

    expect(() => db.run("UPDATE journal_lines SET debit_amount = 999 WHERE journal_entry_id = ?", posted.entryId!)).toThrow("journal_lines are append-only");
    expect(() => db.run("DELETE FROM journal_lines WHERE journal_entry_id = ?", posted.entryId!)).toThrow("journal_lines are append-only");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("prevents mutation or deletion of purchase documents once linked to a journal entry", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-linked-doc-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-linked-doc-inbox-"));
    const sourceFile = join(inbox, "vendor.txt");
    writeFileSync(sourceFile, "Vendor invoice\n1250 DKK\n");

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const doc = ingestDocument(db, root, sourceFile, {
      source: "email",
      issueDate: "2026-05-16",
      invoiceNo: "INV-LINKED",
      deliveryDescription: "Softwareabonnement",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør ApS", address: "Sælgervej 1", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
      paymentDetails: "Bankoverførsel"
    });
    expect(doc.ok).toBe(true);

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Software expense with evidence",
      documentId: doc.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 }
      ]
    });
    expect(posted.ok).toBe(true);

    expect(() => db.run("UPDATE documents SET amount_inc_vat = 999 WHERE id = ?", doc.documentId!)).toThrow("document is linked to a journal entry");
    expect(() => db.run("DELETE FROM documents WHERE id = ?", doc.documentId!)).toThrow("document is linked to a journal entry");

    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  });

  test("enforces one posted journal entry per source bank transaction at database level", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-unique-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const bank = db.query(
      `INSERT INTO bank_transactions (transaction_date, text, amount, transaction_hash)
       VALUES ('2026-05-16', 'Customer payment', 1000, 'unique-bank-source-test')
       RETURNING id`
    ).get() as { id: number };

    const first = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Bank-linked posting",
      sourceBankTransactionId: bank.id,
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(first.ok).toBe(true);

    expect(() => postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Duplicate bank-linked posting",
      sourceBankTransactionId: bank.id,
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    })).toThrow("UNIQUE constraint failed");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("prevents mutation or deletion of referenced bank transactions", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-append-only-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const bank = db.query(
      `INSERT INTO bank_transactions (transaction_date, text, amount, transaction_hash)
       VALUES ('2026-05-16', 'Customer payment', 1000, 'bank-append-only-test')
       RETURNING id`
    ).get() as { id: number };

    const posted = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Bank-linked posting",
      sourceBankTransactionId: bank.id,
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 }
      ]
    });
    expect(posted.ok).toBe(true);

    expect(() => db.run("UPDATE bank_transactions SET amount = 9999 WHERE id = ?", bank.id)).toThrow("bank transaction is referenced by ledger or payment records and cannot be modified");
    expect(() => db.run("DELETE FROM bank_transactions WHERE id = ?", bank.id)).toThrow("bank transactions are append-only");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("audit verify detects structural ledger corruption beyond hash mismatch", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-corrupt-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    db.exec("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO journal_entries (entry_no, transaction_date, text, rule_version, status, previous_hash, entry_hash)
       VALUES ('2026-99999', '2026-05-16', 'Corrupt entry without lines', 'corrupt-fixture', 'posted', 'GENESIS', 'bad-hash')`
    );
    db.run(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, text)
       VALUES (999999, 999999, 1, 0, 'orphan broken account')`
    );
    db.exec("PRAGMA foreign_keys = ON");

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("entry has no journal lines"))).toBe(true);
    expect(result.errors.some((e) => e.includes("orphan journal_entry_id"))).toBe(true);
    expect(result.errors.some((e) => e.includes("missing account_id"))).toBe(true);
    expect(result.errors.some((e) => e.includes("foreign key violation"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  test("audit verify cross-checks stored invoice status against ledger balance", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-status-audit-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-STATUS-AUDIT",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    db.run("DROP TRIGGER documents_no_update_issued_invoice");
    db.run("UPDATE documents SET status = 'paid' WHERE id = ?", issued.documentId!);

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("stored status paid does not match ledger status open"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

});
