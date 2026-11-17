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
  issued_at?: string;
  /** True when an already-accepted document's stored answer is replayed (a resend of the same invoice.uuid). */
  replayed?: boolean;
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
  /** A fetch implementation (default: node:https with a classic X25519 TLS key share). */
  fetch?: typeof fetch;
  /** Per-call timeout in milliseconds (default 60000). */
  timeoutMs?: number;
}

/** An API answer other than 200, or status 0 / code "network_error" when the network failed. */
export declare class MatheelError extends Error {
  /** Builds the error from the HTTP status, the parsed body and the Retry-After seconds. */
  constructor(status: number, body: any, retryAfter?: number | null);
  /** The HTTP status; 0 for a network failure, 502 for an answer that is not the API's JSON ("invalid_response"). */
  status: number;
  body: any;
  /** body.error (string or .code), else "zatca_rejected" when ZATCA's errors are present, else "http_<status>". */
  code: string;
  /** The Retry-After header in seconds, when sent (409 filing_in_progress sends 5). */
  retryAfter: number | null;
}

/** What to do with an error: resend the same request later, fix the document, or have a person look. */
export type ErrorClass = "retry" | "permanent" | "attention";

/** Classifies an error per the API contract; anything that is not a MatheelError is "attention". */
export declare function classify(error: unknown): ErrorClass;

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
  /** Files with the token in `store`; 200 writes the next token, 409 device_token_reused stores the latest and resends, filing_in_progress waits and resends. */
  fileWithStore(
    store: TokenStore,
    invoice: Invoice,
    options?: { pdf?: boolean; retries?: number; /** Put into an invoice without one: a UUID v4 stored once per document. */ uuid?: string; [field: string]: unknown },
  ): Promise<InvoiceResult>;
  /** Sleeps between fileWithStore retries; replace it in tests. */
  wait(ms: number): Promise<void>;
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
