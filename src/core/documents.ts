import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";
import { insertAuditLog } from "./actor";

export type DocumentType = "purchase_sale" | "cash_register_receipt";
export type DocumentExemptionCode = "FOREIGN_PHYSICAL_ONLY" | null;

export type DocumentMetadata = {
  source: string;
  documentType?: DocumentType;
  issueDate?: string;
  invoiceNo?: string;
  deliveryDescription?: string;
  amountIncVat?: number;
  currency?: string;
  sender?: { name?: string; address?: string; vatOrCvr?: string };
  recipient?: { name?: string; address?: string; vatOrCvr?: string };
  vatAmount?: number;
  paymentDetails?: string;
  exemptionCode?: DocumentExemptionCode;
};

export type DocumentValidationResult = {
  ok: boolean;
  appliedRules: string[];
  errors: string[];
};

export type IngestDocumentResult = {
  ok: boolean;
  documentId?: number;
  documentNo?: string;
  sha256?: string;
  storedPath?: string;
  errors?: string[];
};

export type IngestDocumentOptions = {
  forceDuplicateLogicalIdentity?: boolean;
};

const RULES = {
  STORAGE: "DK-DOCUMENT-STORAGE-001",
  CASH_RECEIPT: "DK-DOCUMENT-CASH-RECEIPT-001",
  FOREIGN_PHYSICAL: "DK-DOCUMENT-FOREIGN-PHYSICAL-001",
  INTEGRITY: "DK-DOCUMENT-INTEGRITY-001",
} as const;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function looksLikeIsoDate(value: unknown) {
  return hasText(value) && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function detectMimeType(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".txt") return "text/plain";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

function nextDocumentNo(db: Database) {
  const row = db.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
  return `DOC-${new Date().getFullYear()}-${String(row.n + 1).padStart(6, "0")}`;
}

export function validateDocumentMetadata(metadata: DocumentMetadata): DocumentValidationResult {
  const errors: string[] = [];
  const documentType = metadata.documentType ?? "purchase_sale";
  const exemptionCode = metadata.exemptionCode ?? null;
  const currency = (metadata.currency ?? "DKK").trim().toUpperCase();
  const appliedRules = [RULES.STORAGE, RULES.INTEGRITY];

  if (!hasText(metadata.source)) errors.push("source is required");
  if (!/^[A-Z]{3}$/.test(currency)) errors.push("currency must be a 3-letter ISO code");
  const allowsNonDkk = documentType === "cash_register_receipt" || exemptionCode === "FOREIGN_PHYSICAL_ONLY";
  if (currency !== "DKK" && !allowsNonDkk) errors.push("only DKK document metadata is supported unless documentType is cash_register_receipt or exemptionCode is FOREIGN_PHYSICAL_ONLY");
  if (documentType === "cash_register_receipt") appliedRules.splice(1, 0, RULES.CASH_RECEIPT);
  if (exemptionCode === "FOREIGN_PHYSICAL_ONLY") appliedRules.splice(appliedRules.length - 1, 0, RULES.FOREIGN_PHYSICAL);

  const exemptFromMinimumFields = documentType === "cash_register_receipt" || exemptionCode === "FOREIGN_PHYSICAL_ONLY";
  if (!exemptFromMinimumFields) {
    if (!looksLikeIsoDate(metadata.issueDate)) errors.push("issueDate must be present in YYYY-MM-DD format");
    if (!hasText(metadata.deliveryDescription)) errors.push("deliveryDescription is required");
    if (!hasNonNegativeNumber(metadata.amountIncVat)) errors.push("amountIncVat is required");
    if (!hasText(metadata.sender?.name)) errors.push("sender.name is required");
    if (!hasText(metadata.sender?.address)) errors.push("sender.address is required");
    if (!hasText(metadata.sender?.vatOrCvr)) errors.push("sender.vatOrCvr is required");
    if (!hasText(metadata.recipient?.name)) errors.push("recipient.name is required");
    if (!hasText(metadata.recipient?.address)) errors.push("recipient.address is required");
    if (!hasText(metadata.recipient?.vatOrCvr)) errors.push("recipient.vatOrCvr is required");
    if (!hasNonNegativeNumber(metadata.vatAmount)) errors.push("vatAmount is required");
  }

  return { ok: errors.length === 0, appliedRules, errors };
}

export function ingestDocument(db: Database, companyRoot: string, filePath: string, metadata: DocumentMetadata, options: IngestDocumentOptions = {}): IngestDocumentResult {
  const validation = validateDocumentMetadata(metadata);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  if (!existsSync(filePath)) return { ok: false, errors: [`file does not exist: ${filePath}`] };

  const sha256 = sha256File(filePath);
  const existing = db.query("SELECT id, document_no, stored_path FROM documents WHERE sha256_hash = ?").get(sha256) as { id: number; document_no: string; stored_path: string } | null;
  if (existing) {
    return { ok: false, errors: [`duplicate document content already ingested as ${existing.document_no}`] };
  }

  const documentNo = nextDocumentNo(db);
  const docType = metadata.documentType ?? "purchase_sale";
  const senderVatOrCvr = metadata.sender?.vatOrCvr?.trim();
  const invoiceNo = metadata.invoiceNo?.trim();
  if (!options.forceDuplicateLogicalIdentity && docType === "purchase_sale" && senderVatOrCvr && invoiceNo) {
    const existingLogical = db.query(
      `SELECT id, document_no
       FROM documents
       WHERE document_type = 'purchase_sale'
         AND sender_vat_cvr = ?
         AND invoice_no = ?
       LIMIT 1`
    ).get(senderVatOrCvr, invoiceNo) as { id: number; document_no: string } | null;
    if (existingLogical) {
      return { ok: false, errors: [`a document from ${senderVatOrCvr} with invoice ${invoiceNo} is already ingested as ${existingLogical.document_no}. Use --force to add another scan.`] };
    }
  }

  const p = companyPaths(companyRoot);
  mkdirSync(p.documentsOriginals, { recursive: true });
  const ext = extname(filePath).toLowerCase() || ".bin";
  const storedPath = join(p.documentsOriginals, `${sha256}${ext}`);
  copyFileSync(filePath, storedPath);

  const currency = (metadata.currency ?? "DKK").trim().toUpperCase();
  const result = db.query(
    `INSERT INTO documents (
      document_no, source, original_filename, stored_path, mime_type, sha256_hash,
      supplier_name, invoice_no, invoice_date, amount_inc_vat, currency, status,
      document_type, delivery_description, sender_name, sender_address, sender_vat_cvr,
      recipient_name, recipient_address, recipient_vat_cvr, vat_amount, payment_details, exemption_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id`
  ).get(
    documentNo,
    metadata.source,
    basename(filePath),
    storedPath,
    detectMimeType(filePath),
    sha256,
    metadata.sender?.name ?? null,
    metadata.invoiceNo ?? null,
    metadata.issueDate ?? null,
    metadata.amountIncVat ?? null,
    currency,
    docType,
    metadata.deliveryDescription ?? null,
    metadata.sender?.name ?? null,
    metadata.sender?.address ?? null,
    metadata.sender?.vatOrCvr ?? null,
    metadata.recipient?.name ?? null,
    metadata.recipient?.address ?? null,
    metadata.recipient?.vatOrCvr ?? null,
    metadata.vatAmount ?? null,
    metadata.paymentDetails ?? null,
    metadata.exemptionCode ?? null,
  ) as { id: number };

  insertAuditLog(db, {
    eventType: "document_ingest",
    entityType: "document",
    entityId: result.id,
    message: `Ingested supporting document ${documentNo} (${sha256})`,
  });

  return { ok: true, documentId: result.id, documentNo, sha256, storedPath };
}
