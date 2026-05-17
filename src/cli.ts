#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCompanyDirs, companyPaths } from "./core/paths";
import { openDb, migrate } from "./core/db";
import { postJournalEntry, reverseJournalEntry, seedAccounts, verifyAuditChain } from "./core/ledger";
import { validateInvoice } from "./core/invoice";
import { ingestDocument } from "./core/documents";
import { importBankCsv } from "./core/bank";
import { buildVatReport, postEuServiceReverseChargePurchase, postRepresentationPurchase } from "./core/vat";
import { buildBankReconciliationReport } from "./core/reconciliation";
import { issueInvoice } from "./core/issued-invoices";
import { applyInvoicePayment, getInvoiceStatus } from "./core/invoice-payments";
import { postIssuedInvoiceToLedger } from "./core/invoice-booking";
import { settleInvoiceFromBank } from "./core/invoice-settlement";
import { settleInvoiceClaimsFromBank } from "./core/invoice-claim-settlement";
import { issueCreditNote } from "./core/credit-notes";
import { refundInvoiceToBank } from "./core/invoice-refunds";
import { calculateInvoiceLateInterest, postInvoiceLateInterestToLedger, registerInvoiceLateInterest } from "./core/invoice-interest";
import { calculateInvoiceLateCompensation, postInvoiceLateCompensationToLedger, registerInvoiceLateCompensation } from "./core/invoice-compensation";
import { postInvoiceReminderToLedger, registerInvoiceReminder } from "./core/invoice-reminders";
import { writeOffInvoiceBadDebt } from "./core/invoice-bad-debt";
import { recoverInvoiceBadDebtFromBank } from "./core/invoice-bad-debt-recovery";
import { createSystemBackup, getBackupComplianceStatus } from "./core/system-backups";
import { exportAuthorityPackage } from "./core/authority-export";
import { restoreSystemBackup } from "./core/system-restore";

function arg(name: string, fallback?: string) {
  const i = Bun.argv.indexOf(name);
  return i >= 0 ? Bun.argv[i + 1] : fallback;
}
function companyRoot() { return arg("--company", process.env.RENTEMESTER_COMPANY ?? "/company")!; }
function usage() {
  console.log(`Rentemester v0.0.1\n\nCommands:\n  init --company <path>\n  system healthcheck --company <path>\n  system backup --company <path> [--at <ISO-8601>]\n  system backup-status --company <path> [--as-of <ISO-8601>]\n  system restore-backup --backup-dir <dir> --target-company <path>\n  system export-authority --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <dir> [--requested-at <ISO-8601>] [--requester <name>]\n  audit verify --company <path>\n  accounts list --company <path>\n  exceptions list --company <path>\n  invoice validate --input <file.json>\n  invoice issue --company <path> --input <file.json>\n  invoice credit-note --company <path> --input <file.json>\n  invoice post --company <path> --document-id <n>\n  invoice settle-bank --company <path> --input <file.json>\n  invoice settle-claim-bank --company <path> --input <file.json>\n  invoice write-off-bad-debt --company <path> --input <file.json>\n  invoice recover-bad-debt-bank --company <path> --input <file.json>\n  invoice refund-bank --company <path> --input <file.json>\n  invoice apply-payment --company <path> --input <file.json>\n  invoice remind --company <path> --document-id <n> --date <YYYY-MM-DD> [--fee <n>] [--note <text>]\n  invoice post-reminder --company <path> --document-id <n> [--reminder-id <n>] [--date <YYYY-MM-DD>]\n  invoice status --company <path> --document-id <n> [--as-of <YYYY-MM-DD>]\n  invoice interest --company <path> --document-id <n> --as-of <YYYY-MM-DD> --reference-rate <pct>\n  invoice claim-interest --company <path> --document-id <n> --as-of <YYYY-MM-DD> --reference-rate <pct> [--note <text>]\n  invoice post-interest --company <path> --document-id <n> [--claim-id <n>] [--date <YYYY-MM-DD>]\n  invoice compensation --company <path> --document-id <n> --as-of <YYYY-MM-DD> [--amount-dkk <n>]\n  invoice claim-compensation --company <path> --document-id <n> --as-of <YYYY-MM-DD> [--amount-dkk <n>] [--note <text>]\n  invoice post-compensation --company <path> --document-id <n> [--date <YYYY-MM-DD>]\n  documents ingest --company <path> --file <path> --metadata <file.json>\n  documents list --company <path>\n  bank import --company <path> --file <transactions.csv>\n  bank list --company <path>\n  reconcile bank --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n  vat report --company <path> --from <YYYY-MM-DD> --to <YYYY-MM-DD>\n  vat post-eu-service-purchase --company <path> --input <file.json>\n  vat post-representation-purchase --company <path> --input <file.json>\n  journal post --company <path> --input <file.json>\n  journal reverse --company <path> --entry-id <n> --date <YYYY-MM-DD> --reason <text>\n  journal list --company <path>`);
}

const [cmd, sub] = Bun.argv.slice(2).filter(a => !a.startsWith("--") && !Bun.argv[Bun.argv.indexOf(a)-1]?.startsWith("--"));

if (!cmd || cmd === "help" || cmd === "--help") usage();
else if (cmd === "init") {
  const root = companyRoot();
  const p = ensureCompanyDirs(root);
  const db = openDb(p.db); migrate(db); seedAccounts(db);
  db.run("INSERT OR IGNORE INTO companies (id, name) VALUES (1, 'Rentemester company')");
  const policy = join(p.config, "policy.yaml");
  if (!existsSync(policy)) writeFileSync(policy, `company_policy:\n  country: DK\n  currency: DKK\n  allow_direct_sql_write: false\n  block_if_uncertain: true\n`);
  db.run("INSERT INTO audit_log (event_type, entity_type, message) VALUES ('init','company','Company volume initialized')");
  console.log(`Initialized Rentemester company at ${root}`);
  console.log(`Ledger: ${p.db}`);
  db.close();
}
else if (cmd === "system" && sub === "healthcheck") {
  const p = companyPaths(companyRoot());
  const checks = [
    ["company_root", existsSync(p.root)], ["data_dir", existsSync(p.data)], ["ledger", existsSync(p.db)], ["documents", existsSync(p.documentsInbox)], ["config", existsSync(p.config)]
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? "OK" : "FAIL"} ${name}`); if (!pass) ok = false; }
  if (!ok) process.exit(1);
}
else if (cmd === "system" && sub === "backup") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = createSystemBackup(db, companyRoot(), { createdAt: arg("--at") });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "system" && sub === "backup-status") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = getBackupComplianceStatus(db, companyRoot(), arg("--as-of"));
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "system" && sub === "restore-backup") {
  const backupDir = arg("--backup-dir");
  const targetCompanyRoot = arg("--target-company");
  if (!backupDir || !targetCompanyRoot) {
    console.error("Missing required --backup-dir <dir> or --target-company <path>");
    process.exit(2);
  }
  const result = restoreSystemBackup({ backupDir, targetCompanyRoot });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
else if (cmd === "system" && sub === "export-authority") {
  const from = arg("--from");
  const to = arg("--to");
  const outputDir = arg("--out");
  if (!from || !to || !outputDir) {
    console.error("Missing required --from <YYYY-MM-DD>, --to <YYYY-MM-DD>, or --out <dir>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = exportAuthorityPackage(db, companyRoot(), {
    periodStart: from,
    periodEnd: to,
    outputDir,
    requestedAt: arg("--requested-at"),
    requester: arg("--requester"),
  });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "audit" && sub === "verify") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const r = verifyAuditChain(db);
  console.log(JSON.stringify(r, null, 2));
  db.close();
  if (!r.ok) process.exit(1);
}
else if (cmd === "accounts" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT account_no, name, type, default_vat_code FROM accounts ORDER BY account_no").all();
  console.table(rows);
  db.close();
}
else if (cmd === "exceptions" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, type, severity, status, message, required_action, created_at FROM exceptions ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else if (cmd === "invoice" && sub === "validate") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = validateInvoice(payload);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "issue") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = issueInvoice(db, root, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "credit-note") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = issueCreditNote(db, root, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "post") {
  const documentId = Number(arg("--document-id"));
  if (!Number.isInteger(documentId) || documentId <= 0) {
    console.error("Missing required --document-id <n>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = postIssuedInvoiceToLedger(db, { invoiceDocumentId: documentId });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "settle-bank") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = settleInvoiceFromBank(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "settle-claim-bank") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = settleInvoiceClaimsFromBank(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "write-off-bad-debt") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = writeOffInvoiceBadDebt(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "recover-bad-debt-bank") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = recoverInvoiceBadDebtFromBank(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "apply-payment") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = applyInvoicePayment(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "refund-bank") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = refundInvoiceToBank(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "remind") {
  const documentId = Number(arg("--document-id"));
  const reminderDate = arg("--date");
  const feeArg = arg("--fee");
  const feeAmount = feeArg === undefined ? undefined : Number(feeArg);
  const note = arg("--note");
  if (!Number.isInteger(documentId) || documentId <= 0 || !reminderDate || (feeArg !== undefined && Number.isNaN(feeAmount))) {
    console.error("Missing required --document-id <n> or --date <YYYY-MM-DD>; optional --fee <n> must be numeric when present");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = registerInvoiceReminder(db, { invoiceDocumentId: documentId, reminderDate, feeAmount, note: note ?? undefined });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "post-reminder") {
  const documentId = Number(arg("--document-id"));
  const reminderIdArg = arg("--reminder-id");
  const reminderId = reminderIdArg === undefined ? undefined : Number(reminderIdArg);
  const transactionDate = arg("--date");
  if (!Number.isInteger(documentId) || documentId <= 0 || (reminderIdArg !== undefined && (!Number.isInteger(reminderId) || reminderId <= 0))) {
    console.error("Missing required --document-id <n>; optional --reminder-id <n> must be a positive integer when present");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = postInvoiceReminderToLedger(db, { invoiceDocumentId: documentId, reminderId, transactionDate: transactionDate ?? undefined });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "status") {
  const documentId = Number(arg("--document-id"));
  if (!Number.isInteger(documentId) || documentId <= 0) {
    console.error("Missing required --document-id <n>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = getInvoiceStatus(db, documentId, arg("--as-of"));
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "interest") {
  const documentId = Number(arg("--document-id"));
  const asOfDate = arg("--as-of");
  const referenceRatePercent = Number(arg("--reference-rate"));
  if (!Number.isInteger(documentId) || documentId <= 0 || !asOfDate || Number.isNaN(referenceRatePercent)) {
    console.error("Missing required --document-id <n>, --as-of <YYYY-MM-DD>, or --reference-rate <pct>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = calculateInvoiceLateInterest(db, { invoiceDocumentId: documentId, asOfDate, referenceRatePercent });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "claim-interest") {
  const documentId = Number(arg("--document-id"));
  const asOfDate = arg("--as-of");
  const rateArg = arg("--reference-rate");
  const note = arg("--note");
  const referenceRatePercent = rateArg === undefined ? NaN : Number(rateArg);
  if (!Number.isInteger(documentId) || documentId <= 0 || !asOfDate || Number.isNaN(referenceRatePercent)) {
    console.error("Missing required --document-id <n>, --as-of <YYYY-MM-DD>, or --reference-rate <pct>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = registerInvoiceLateInterest(db, { invoiceDocumentId: documentId, asOfDate, referenceRatePercent, note: note ?? undefined });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "post-interest") {
  const documentId = Number(arg("--document-id"));
  const claimIdArg = arg("--claim-id");
  const claimId = claimIdArg === undefined ? undefined : Number(claimIdArg);
  const transactionDate = arg("--date");
  if (!Number.isInteger(documentId) || documentId <= 0 || (claimIdArg !== undefined && (!Number.isInteger(claimId) || claimId <= 0))) {
    console.error("Missing required --document-id <n>; optional --claim-id <n> must be a positive integer when present");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = postInvoiceLateInterestToLedger(db, { invoiceDocumentId: documentId, claimId, transactionDate: transactionDate ?? undefined });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "compensation") {
  const documentId = Number(arg("--document-id"));
  const asOfDate = arg("--as-of");
  const amountArg = arg("--amount-dkk");
  const compensationAmountDkk = amountArg === undefined ? undefined : Number(amountArg);
  if (!Number.isInteger(documentId) || documentId <= 0 || !asOfDate || (amountArg !== undefined && Number.isNaN(compensationAmountDkk))) {
    console.error("Missing required --document-id <n> or --as-of <YYYY-MM-DD>; optional --amount-dkk <n> must be numeric when present");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = calculateInvoiceLateCompensation(db, { invoiceDocumentId: documentId, asOfDate, compensationAmountDkk });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "claim-compensation") {
  const documentId = Number(arg("--document-id"));
  const asOfDate = arg("--as-of");
  const amountArg = arg("--amount-dkk");
  const note = arg("--note");
  const compensationAmountDkk = amountArg === undefined ? undefined : Number(amountArg);
  if (!Number.isInteger(documentId) || documentId <= 0 || !asOfDate || (amountArg !== undefined && Number.isNaN(compensationAmountDkk))) {
    console.error("Missing required --document-id <n> or --as-of <YYYY-MM-DD>; optional --amount-dkk must be numeric when present");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = registerInvoiceLateCompensation(db, { invoiceDocumentId: documentId, asOfDate, compensationAmountDkk, note: note ?? undefined });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "invoice" && sub === "post-compensation") {
  const documentId = Number(arg("--document-id"));
  const transactionDate = arg("--date");
  if (!Number.isInteger(documentId) || documentId <= 0) {
    console.error("Missing required --document-id <n>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = postInvoiceLateCompensationToLedger(db, { invoiceDocumentId: documentId, transactionDate: transactionDate ?? undefined });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "documents" && sub === "ingest") {
  const file = arg("--file");
  const metadataFile = arg("--metadata");
  if (!file || !metadataFile) {
    console.error("Missing required --file <path> or --metadata <file.json>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  const result = ingestDocument(db, root, file, metadata);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "documents" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, document_no, source, original_filename, invoice_date, amount_inc_vat, currency, status, stored_path FROM documents ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else if (cmd === "bank" && sub === "import") {
  const file = arg("--file");
  if (!file) {
    console.error("Missing required --file <transactions.csv>");
    process.exit(2);
  }
  const root = companyRoot();
  const db = openDb(companyPaths(root).db); migrate(db);
  const result = importBankCsv(db, root, file);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "bank" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, transaction_date, booking_date, text, amount, currency, amount_dkk, fx_rate_to_dkk, reference, import_batch_id, status FROM bank_transactions ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else if (cmd === "reconcile" && sub === "bank") {
  const from = arg("--from");
  const to = arg("--to");
  if (!from || !to) {
    console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildBankReconciliationReport(db, from, to);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "vat" && sub === "report") {
  const from = arg("--from");
  const to = arg("--to");
  if (!from || !to) {
    console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = buildVatReport(db, from, to);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "vat" && sub === "post-eu-service-purchase") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = postEuServiceReverseChargePurchase(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "vat" && sub === "post-representation-purchase") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = postRepresentationPurchase(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "journal" && sub === "post") {
  const input = arg("--input");
  if (!input) {
    console.error("Missing required --input <file.json>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const payload = JSON.parse(readFileSync(input, "utf8"));
  const result = postJournalEntry(db, payload);
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "journal" && sub === "reverse") {
  const entryId = Number(arg("--entry-id"));
  const date = arg("--date");
  const reason = arg("--reason");
  if (!Number.isInteger(entryId) || !date || !reason) {
    console.error("Missing required --entry-id <n>, --date <YYYY-MM-DD>, or --reason <text>");
    process.exit(2);
  }
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const result = reverseJournalEntry(db, { entryId, transactionDate: date, reason });
  console.log(JSON.stringify(result, null, 2));
  db.close();
  if (!result.ok) process.exit(1);
}
else if (cmd === "journal" && sub === "list") {
  const db = openDb(companyPaths(companyRoot()).db); migrate(db);
  const rows = db.query("SELECT id, entry_no, transaction_date, text, currency, amount_foreign, amount_dkk, fx_rate_to_dkk, document_id, source_bank_transaction_id, status, reversal_of_entry_id FROM journal_entries ORDER BY id DESC").all();
  console.table(rows);
  db.close();
}
else {
  console.error(`Unknown command: ${cmd}${sub ? " " + sub : ""}`);
  usage();
  process.exit(2);
}
