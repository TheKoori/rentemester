CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Unnamed company',
  country TEXT NOT NULL DEFAULT 'DK',
  currency TEXT NOT NULL DEFAULT 'DKK',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  account_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense','vat')),
  normal_balance TEXT NOT NULL CHECK(normal_balance IN ('debit','credit')),
  active INTEGER NOT NULL DEFAULT 1,
  default_vat_code TEXT,
  allow_direct_posting INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  document_no TEXT UNIQUE,
  source TEXT NOT NULL,
  original_filename TEXT,
  stored_path TEXT,
  mime_type TEXT,
  sha256_hash TEXT NOT NULL UNIQUE,
  upload_datetime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  supplier_name TEXT,
  invoice_no TEXT,
  invoice_date TEXT,
  amount_inc_vat NUMERIC,
  currency TEXT NOT NULL DEFAULT 'DKK',
  status TEXT NOT NULL DEFAULT 'ingested',
  document_type TEXT NOT NULL DEFAULT 'purchase_sale',
  delivery_description TEXT,
  sender_name TEXT,
  sender_address TEXT,
  sender_vat_cvr TEXT,
  recipient_name TEXT,
  recipient_address TEXT,
  recipient_vat_cvr TEXT,
  vat_amount NUMERIC,
  payment_details TEXT,
  exemption_code TEXT,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY,
  transaction_date TEXT NOT NULL,
  booking_date TEXT,
  text TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'DKK',
  reference TEXT,
  amount_dkk NUMERIC,
  fx_rate_to_dkk NUMERIC,
  source_file_hash TEXT,
  import_batch_id TEXT,
  transaction_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'imported'
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  transaction_date TEXT NOT NULL,
  registration_datetime TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  text TEXT NOT NULL,
  source_bank_transaction_id INTEGER,
  document_id INTEGER,
  currency TEXT NOT NULL DEFAULT 'DKK',
  amount_foreign NUMERIC,
  amount_dkk NUMERIC,
  fx_rate_to_dkk NUMERIC,
  rule_version TEXT NOT NULL DEFAULT 'dk-v0.0.1',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_by_program TEXT NOT NULL DEFAULT 'rentemester',
  status TEXT NOT NULL CHECK(status IN ('posted','reversed')) DEFAULT 'posted',
  reversal_of_entry_id INTEGER,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(source_bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  journal_entry_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  debit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(debit_amount >= 0),
  credit_amount NUMERIC NOT NULL DEFAULT 0 CHECK(credit_amount >= 0),
  vat_code TEXT,
  currency TEXT NOT NULL DEFAULT 'DKK',
  text TEXT,
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  CHECK(NOT (debit_amount > 0 AND credit_amount > 0))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  message TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
);

CREATE TABLE IF NOT EXISTS invoice_refunds (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  refund_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
);

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  reminder_date TEXT NOT NULL,
  fee_amount NUMERIC NOT NULL CHECK(fee_amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_compensation_claims (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL UNIQUE,
  claim_date TEXT NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_claims (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  claim_date TEXT NOT NULL,
  reference_rate_percent NUMERIC NOT NULL,
  annual_interest_rate_percent NUMERIC NOT NULL,
  overdue_days INTEGER NOT NULL,
  principal_open_balance NUMERIC NOT NULL,
  amount_dkk NUMERIC NOT NULL CHECK(amount_dkk > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(invoice_document_id, claim_date, reference_rate_percent),
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id)
);

CREATE TABLE IF NOT EXISTS invoice_compensation_postings (
  id INTEGER PRIMARY KEY,
  compensation_claim_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(compensation_claim_id) REFERENCES invoice_compensation_claims(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_reminder_postings (
  id INTEGER PRIMARY KEY,
  reminder_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(reminder_id) REFERENCES invoice_reminders(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_interest_postings (
  id INTEGER PRIMARY KEY,
  interest_claim_id INTEGER NOT NULL UNIQUE,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(interest_claim_id) REFERENCES invoice_interest_claims(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_claim_payments (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER,
  payment_date TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK(amount > 0),
  currency TEXT NOT NULL DEFAULT 'DKK',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
);

CREATE TABLE IF NOT EXISTS invoice_bad_debt_writeoffs (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  writeoff_date TEXT NOT NULL,
  gross_amount NUMERIC NOT NULL CHECK(gross_amount > 0),
  net_amount NUMERIC NOT NULL CHECK(net_amount >= 0),
  vat_amount NUMERIC NOT NULL CHECK(vat_amount >= 0),
  note TEXT,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS invoice_bad_debt_recoveries (
  id INTEGER PRIMARY KEY,
  invoice_document_id INTEGER NOT NULL,
  bank_transaction_id INTEGER NOT NULL UNIQUE,
  recovery_date TEXT NOT NULL,
  gross_amount NUMERIC NOT NULL CHECK(gross_amount > 0),
  net_amount NUMERIC NOT NULL CHECK(net_amount >= 0),
  vat_amount NUMERIC NOT NULL CHECK(vat_amount >= 0),
  note TEXT,
  journal_entry_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
  FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id),
  FOREIGN KEY(journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  related_bank_transaction_id INTEGER,
  related_document_id INTEGER,
  message TEXT NOT NULL,
  required_action TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);

CREATE TRIGGER IF NOT EXISTS journal_entries_no_update
BEFORE UPDATE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries are append-only; create reversal instead');
END;

CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete
BEFORE DELETE ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal_entries are append-only; create reversal instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_update_issued_invoice
BEFORE UPDATE ON documents
WHEN OLD.document_type IN ('issued_invoice','credit_note')
BEGIN
  SELECT RAISE(ABORT, 'issued invoice documents are append-only; create credit note instead');
END;

CREATE TRIGGER IF NOT EXISTS documents_no_delete_issued_invoice
BEFORE DELETE ON documents
WHEN OLD.document_type IN ('issued_invoice','credit_note')
BEGIN
  SELECT RAISE(ABORT, 'issued invoice documents are append-only; create credit note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_no_update
BEFORE UPDATE ON invoice_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice payments are append-only; add a correcting payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_payments_no_delete
BEFORE DELETE ON invoice_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice payments are append-only; add a correcting payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_no_update
BEFORE UPDATE ON invoice_refunds
BEGIN
  SELECT RAISE(ABORT, 'invoice refunds are append-only; add a correcting refund application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_refunds_no_delete
BEFORE DELETE ON invoice_refunds
BEGIN
  SELECT RAISE(ABORT, 'invoice refunds are append-only; add a correcting refund application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminders_no_update
BEFORE UPDATE ON invoice_reminders
BEGIN
  SELECT RAISE(ABORT, 'invoice reminders are append-only; add a later reminder or corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminders_no_delete
BEFORE DELETE ON invoice_reminders
BEGIN
  SELECT RAISE(ABORT, 'invoice reminders are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_claims_no_update
BEFORE UPDATE ON invoice_compensation_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation claims are append-only; add a correcting note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_claims_no_delete
BEFORE DELETE ON invoice_compensation_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation claims are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_claims_no_update
BEFORE UPDATE ON invoice_interest_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest claims are append-only; add a correcting note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_claims_no_delete
BEFORE DELETE ON invoice_interest_claims
BEGIN
  SELECT RAISE(ABORT, 'invoice interest claims are append-only; add a corrective note instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_postings_no_update
BEFORE UPDATE ON invoice_compensation_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_compensation_postings_no_delete
BEFORE DELETE ON invoice_compensation_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice compensation postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminder_postings_no_update
BEFORE UPDATE ON invoice_reminder_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice reminder postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_reminder_postings_no_delete
BEFORE DELETE ON invoice_reminder_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice reminder postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_postings_no_update
BEFORE UPDATE ON invoice_interest_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice interest postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_interest_postings_no_delete
BEFORE DELETE ON invoice_interest_postings
BEGIN
  SELECT RAISE(ABORT, 'invoice interest postings are append-only; reverse the journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_claim_payments_no_update
BEFORE UPDATE ON invoice_claim_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice claim payments are append-only; add a correcting claim payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_claim_payments_no_delete
BEFORE DELETE ON invoice_claim_payments
BEGIN
  SELECT RAISE(ABORT, 'invoice claim payments are append-only; add a correcting claim payment application instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_writeoffs_no_update
BEFORE UPDATE ON invoice_bad_debt_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt writeoffs are append-only; add a correcting journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_writeoffs_no_delete
BEFORE DELETE ON invoice_bad_debt_writeoffs
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt writeoffs are append-only; add a correcting journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_recoveries_no_update
BEFORE UPDATE ON invoice_bad_debt_recoveries
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt recoveries are append-only; add a correcting journal entry instead');
END;

CREATE TRIGGER IF NOT EXISTS invoice_bad_debt_recoveries_no_delete
BEFORE DELETE ON invoice_bad_debt_recoveries
BEGIN
  SELECT RAISE(ABORT, 'invoice bad-debt recoveries are append-only; add a correcting journal entry instead');
END;
