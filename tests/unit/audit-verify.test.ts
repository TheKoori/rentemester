import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { hashEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";

type ManualLine = {
  account_no: string;
  debit_amount: number;
  credit_amount: number;
  vat_code: string | null;
  text: string;
};

function insertManualEntry(db: ReturnType<typeof openDb>, input: {
  entryNo: string;
  previousHash: string;
  transactionDate: string;
  text: string;
  lines: ManualLine[];
  documentId?: number | null;
  sourceBankTransactionId?: number | null;
  status?: "posted" | "reversed";
  reversalOfEntryId?: number | null;
}) {
  const entry = {
    entry_no: input.entryNo,
    transaction_date: input.transactionDate,
    text: input.text,
    source_bank_transaction_id: input.sourceBankTransactionId ?? null,
    document_id: input.documentId ?? null,
    currency: "DKK",
    amount_foreign: null,
    amount_dkk: null,
    fx_rate_to_dkk: null,
    rule_version: "dk-v0.0.1",
    created_by: "system",
    created_by_program: "rentemester",
    status: input.status ?? "posted",
    reversal_of_entry_id: input.reversalOfEntryId ?? null,
  };
  const entryHash = hashEntry({ ...entry, lines: input.lines }, input.previousHash);

  db.run(
    `INSERT INTO journal_entries (
      entry_no, transaction_date, text, source_bank_transaction_id, document_id,
      currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
      rule_version, created_by, created_by_program, status, reversal_of_entry_id, previous_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    entry.entry_no,
    entry.transaction_date,
    entry.text,
    entry.source_bank_transaction_id,
    entry.document_id,
    entry.currency,
    entry.rule_version,
    entry.created_by,
    entry.created_by_program,
    entry.status,
    entry.reversal_of_entry_id,
    input.previousHash,
    entryHash,
  );

  const inserted = db.query("SELECT id FROM journal_entries WHERE entry_no = ?").get(entry.entry_no) as { id: number };
  for (const line of input.lines) {
    const account = db.query("SELECT id FROM accounts WHERE account_no = ?").get(line.account_no) as { id: number };
    db.run(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, ?, ?, ?, 'DKK', ?)`,
      inserted.id,
      account.id,
      line.debit_amount,
      line.credit_amount,
      line.vat_code,
      line.text,
    );
  }

  return { id: inserted.id, entryHash };
}

function insertEvidenceDocument(db: ReturnType<typeof openDb>, filePath: string, sha256Hash?: string) {
  const hash = sha256Hash ?? createHash("sha256").update(readFileSync(filePath)).digest("hex");
  db.run(
    `INSERT INTO documents (source, original_filename, stored_path, mime_type, sha256_hash, document_type, status)
     VALUES (?, ?, ?, ?, ?, 'purchase_sale', 'booked')`,
    "manual-test",
    filePath.split("/").pop() ?? "evidence.txt",
    filePath,
    "text/plain",
    hash,
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

describe("audit verify", () => {
  test("flags an unbalanced journal entry even when the stored hash chain matches", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "Corrupt unbalanced entry",
      lines: [
        { account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "1000", debit_amount: 0, credit_amount: 90, vat_code: null, text: "Income" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("entry is unbalanced"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("flags duplicate use of the same source bank transaction across journal entries", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, text, amount, currency, transaction_hash, status)
       VALUES ('2026-05-16', 'Customer payment', 1250, 'DKK', 'dup-bank-hash', 'imported')`
    );
    const bankTransaction = db.query("SELECT id FROM bank_transactions WHERE transaction_hash = 'dup-bank-hash'").get() as { id: number };

    const first = insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "First settlement",
      sourceBankTransactionId: bankTransaction.id,
      lines: [
        { account_no: "2000", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "1100", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Receivable" },
      ],
    });
    insertManualEntry(db, {
      entryNo: "2026-00002",
      previousHash: first.entryHash,
      transactionDate: "2026-05-16",
      text: "Duplicate settlement marked reversed without reversal link",
      sourceBankTransactionId: bankTransaction.id,
      status: "reversed",
      lines: [
        { account_no: "2000", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Bank again" },
        { account_no: "1100", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Receivable again" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("duplicate source_bank_transaction_id"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("flags missing evidence file for income/expense entries", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const paths = ensureCompanyDirs(root);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

    const evidencePath = join(root, "missing-evidence.txt");
    writeFileSync(evidencePath, "original evidence\n");
    const documentId = insertEvidenceDocument(db, evidencePath);
    unlinkSync(evidencePath);

    insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "Expense with deleted evidence file",
      documentId,
      lines: [
        { account_no: "3000", debit_amount: 100, credit_amount: 0, vat_code: "DK_PURCHASE_25", text: "Software" },
        { account_no: "2000", debit_amount: 0, credit_amount: 100, vat_code: null, text: "Bank" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("evidence file is missing"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("flags tampered evidence file hash mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const paths = ensureCompanyDirs(root);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

    const evidencePath = join(root, "tampered-evidence.txt");
    writeFileSync(evidencePath, "original evidence\n");
    const documentId = insertEvidenceDocument(db, evidencePath);
    writeFileSync(evidencePath, "tampered evidence\n");

    insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "Expense with tampered evidence file",
      documentId,
      lines: [
        { account_no: "3000", debit_amount: 100, credit_amount: 0, vat_code: "DK_PURCHASE_25", text: "Software" },
        { account_no: "2000", debit_amount: 0, credit_amount: 100, vat_code: null, text: "Bank" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("evidence file hash mismatch"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("allows a reversal pair to share the same source bank transaction without audit failure", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, text, amount, currency, transaction_hash, status)
       VALUES ('2026-05-16', 'Customer payment', 1250, 'DKK', 'reversal-bank-hash', 'imported')`
    );
    const bankTransaction = db.query("SELECT id FROM bank_transactions WHERE transaction_hash = 'reversal-bank-hash'").get() as { id: number };

    const original = insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "Settlement",
      sourceBankTransactionId: bankTransaction.id,
      lines: [
        { account_no: "2000", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "1100", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Receivable" },
      ],
    });
    insertManualEntry(db, {
      entryNo: "2026-00002",
      previousHash: original.entryHash,
      transactionDate: "2026-05-17",
      text: "Reversal of settlement",
      sourceBankTransactionId: bankTransaction.id,
      status: "reversed",
      reversalOfEntryId: original.id,
      lines: [
        { account_no: "2000", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Bank reversal" },
        { account_no: "1100", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Receivable reversal" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(true);
    expect(audit.errors).toHaveLength(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
