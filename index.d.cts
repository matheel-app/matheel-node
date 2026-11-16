// Types for matheel, the official Node.js client for the Matheel ZATCA Phase 2 e-invoicing API.

/** An invoice as the API takes it (snake_case fields: type, line_items, buyer, …). */
export type Invoice = Record<string, unknown>;

/** Matheel's 200 answer for a filed invoice. */
export interface InvoiceResult {
  status: "cleared" | "reported" | string;
  device_token?: string;
  counter?: number;
  zatca_uuid: string;
  invoice_hash: string;
  previous_invoice_hash?: string;
  qr: string;
  invoice_xml: string;
  pdf?: string | null;
  warnings: unknown[];
  errors: unknown[];
  [field: string]: unknown;
}

/** Where the caller keeps one device's token, read and written under the caller's own DB lock. */
export interface TokenStore {
  /** Returns the current device token (e.g. SELECT token … FOR UPDATE). */
  read(): string | Promise<string>;
  /** Saves the token returned by an accepted invoice. */
  write(token: string): void | Promise<void>;
}

/** The fields of a ZATCA Phase 2 TLV QR. */
export interface QrData {
  sellerName: string;
  vatNumber: string;
  timestamp: string;
  total: string;
  vatAmount: string;
  invoiceHash: string | null;
  signature: string | null;
  /** Tag 8, base64. */
  publicKey?: string;
  /** Tag 9, base64 (simplified invoices). */
  certificateSignature?: string;
}

/** Client options. */
export interface MatheelOptions {
  /** A fetch implementation (default: the global fetch). */
  fetch?: typeof fetch;
  /** Per-call timeout in milliseconds (default 60000). */
  timeoutMs?: number;
}

/** An API answer other than 200. */
export declare class MatheelError extends Error {
  /** Builds the error from the HTTP status and the parsed body. */
  constructor(status: number, body: any);
  status: number;
  body: any;
  /** body.error (string or .code), else "zatca_rejected" when ZATCA's errors are present, else "http_<status>". */
  code: string;
}

/** A client for the Matheel API; the key is optional on the sandbox. */
export declare class Matheel {
  /** Creates a client. */
  constructor(key?: string | null, baseUrl?: string, options?: MatheelOptions);
  /** POSTs JSON to an API path; throws MatheelError on any status but 200. */
  post(path: string, body: unknown): Promise<any>;
  /** Files one invoice (POST /api/v1/invoices). */
  fileInvoice(request: {
    deviceToken?: string;
    invoice: Invoice;
    pdf?: boolean;
    environment?: "sandbox" | "simulation" | "production";
    [field: string]: unknown;
  }): Promise<InvoiceResult>;
  /** Files with the token in `store`; 200 writes the new token, 409 device_token_reused re-reads and retries. */
  fileWithStore(store: TokenStore, invoice: Invoice, options?: { pdf?: boolean; retries?: number; [field: string]: unknown }): Promise<InvoiceResult>;
  /** Registers a device (POST /api/v1/onboarding). */
  onboard(request: {
    environment: "sandbox" | "simulation" | "production";
    seller: Record<string, unknown>;
    device?: { name?: string; branch?: string; invoice_types?: string[] };
    otp?: string;
    [field: string]: unknown;
  }): Promise<{ device_token: string; device: Record<string, unknown>; compliance_checks: number; [field: string]: unknown }>;
  /** Makes a merchant activation link (POST /api/v1/onboarding/links). */
  activationLink(request: {
    environment: "sandbox" | "simulation" | "production";
    reference: string;
    callbackUrl?: string;
    expiresInDays?: number;
    maxDevices?: number;
    [field: string]: unknown;
  }): Promise<{ url: string; callback_secret: string; expires_at: string }>;
}

/** Decodes the base64 TLV ZATCA QR. */
export declare function decodeQr(base64Tlv: string): QrData;
/** Checks the x-matheel-signature header of an activation callback. */
export declare function verifyActivationCallback(rawBody: string | Buffer, signatureHeader: string | null | undefined, callbackSecret: string): boolean;
/** Checks Telr's tran_check on a transaction advice POST. */
export declare function verifyTelr(postFields: Record<string, string | undefined>, secret: string): boolean;
