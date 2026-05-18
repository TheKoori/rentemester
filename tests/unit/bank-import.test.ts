import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { importBankCsv } from "../../src/core/bank";

describe("bank import", () => {
  test("stores null FX columns for DKK-only rows and skips deterministic duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-"));
    const csv = join(root, "transactions.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-17,Card payment,-1250,DKK,REF-1",
      "2026-05-18,2026-05-18,Customer payment,2500,DKK,REF-2"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const first = importBankCsv(db, root, csv);
    expect(first.ok).toBe(true);
    expect(first.imported).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    const second = importBankCsv(db, root, csv);
    expect(second.ok).toBe(true);
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(2);

    const rows = db.query("SELECT transaction_date, text, amount, amount_dkk, fx_rate_to_dkk, import_batch_id, transaction_hash FROM bank_transactions ORDER BY id ASC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].transaction_date).toBe("2026-05-16");
    expect(rows[0].transaction_hash).toBeTruthy();
    expect(rows[0].amount_dkk).toBeNull();
    expect(rows[0].fx_rate_to_dkk).toBeNull();
    expect(rows[1].text).toBe("Customer payment");
    expect(rows[1].amount_dkk).toBeNull();
    expect(rows[1].fx_rate_to_dkk).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("imports non-DKK rows when DKK amount and FX rate are supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-fx-"));
    const csv = join(root, "fx.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,amount_dkk,fx_rate_to_dkk,reference",
      "2026-05-19,2026-05-19,Stripe payout,100,EUR,746,7.46,EUR-REF-1"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);

    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(true);
    const rows = db.query("SELECT currency, amount, amount_dkk, fx_rate_to_dkk FROM bank_transactions ORDER BY id ASC").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ currency: "EUR", amount: 100, amount_dkk: 746, fx_rate_to_dkk: 7.46 });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects impossible calendar dates in bank rows", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-baddate-"));
    const csv = join(root, "bad-date.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-02-30,2026-04-31,Customer payment,2500,DKK,REF-1"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("rows[0].transactionDate must be YYYY-MM-DD");
    expect(result.errors).toContain("rows[0].bookingDate must be YYYY-MM-DD when present");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("imports quoted fields with commas and escaped quotes", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-quotes-"));
    const csv = join(root, "quoted.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-17,\"Nordea, faktura \"\"A-42\"\"\",-1250,DKK,REF-1"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    const row = db.query("SELECT text, amount FROM bank_transactions ORDER BY id ASC LIMIT 1").get() as any;
    expect(row).toEqual({ text: "Nordea, faktura \"A-42\"", amount: -1250 });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("imports Danish bank headers with semicolon delimiter and European amounts", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-danish-"));
    const csv = join(root, "nordea.csv");
    writeFileSync(csv, [
      "Bogføringsdato;Rentedato;Tekst;Beløb;Valuta;Reference",
      "17-05-2026;16-05-2026;\"Kunde, faktura 100\";\"1.234,56\";DKK;N-100"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    const row = db.query("SELECT transaction_date, booking_date, text, amount, reference FROM bank_transactions ORDER BY id ASC LIMIT 1").get() as any;
    expect(row).toEqual({ transaction_date: "2026-05-17", booking_date: "2026-05-16", text: "Kunde, faktura 100", amount: 1234.56, reference: "N-100" });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("imports multiline quoted text fields as one logical CSV row", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-multiline-"));
    const csv = join(root, "multiline.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      '2026-05-16,2026-05-17,"Kortkøb NETS',
      'Kvittering 123",-1250,DKK,REF-1'
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    const row = db.query("SELECT text, amount, reference FROM bank_transactions ORDER BY id ASC LIMIT 1").get() as any;
    expect(row).toEqual({ text: "Kortkøb NETS\nKvittering 123", amount: -1250, reference: "REF-1" });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("imports trailing-minus localized amounts as negative numbers", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-trailing-minus-"));
    const csv = join(root, "trailing-minus.csv");
    writeFileSync(csv, [
      "Bogføringsdato;Rentedato;Tekst;Beløb;Valuta;Reference",
      "17-05-2026;16-05-2026;Gebyr;1.234,56-;DKK;N-101"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(1);
    const row = db.query("SELECT transaction_date, booking_date, text, amount, reference FROM bank_transactions ORDER BY id ASC LIMIT 1").get() as any;
    expect(row).toEqual({ transaction_date: "2026-05-17", booking_date: "2026-05-16", text: "Gebyr", amount: -1234.56, reference: "N-101" });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("returns header and row-shape errors close to the CSV root cause", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-header-"));
    const csv = join(root, "bad-header.csv");
    writeFileSync(csv, [
      "Dato,Tekst,Saldo",
      "2026-05-16,Payment,999,EXTRA"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("CSV header missing required column: amount (accepted: amount, beløb, belob)");
    expect(result.errors).toContain("CSV row 2 has 4 fields, header has 3");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects malformed bank rows", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bank-bad-"));
    const csv = join(root, "bad.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,amount_dkk,fx_rate_to_dkk,reference",
      "32-05-2026,,,-abc,EUR,,,REF-1"
    ].join("\n"));

    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    const result = importBankCsv(db, root, csv);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("transactionDate"))).toBe(true);
    expect(result.errors.some((e) => e.includes("amount"))).toBe(true);
    expect(result.errors.some((e) => e.includes("amountDkk"))).toBe(true);
    expect(result.errors.some((e) => e.includes("fxRateToDkk"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
