// Official Node.js client for the Matheel ZATCA Phase 2 e-invoicing API (https://matheel.app). No dependencies.
"use strict";

const crypto = require("node:crypto");

const DEFAULT_BASE_URL = "https://matheel.app";

/** An API answer other than 200: carries the HTTP status, the parsed body and the error code. */
class MatheelError extends Error {
  /** Builds the error from the HTTP status and the parsed response body. */
  constructor(status, body) {
    const code = errorCode(status, body);
    super(`Matheel ${status}: ${code}`);
    this.name = "MatheelError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/** The code of an error body: `error` (a string or `{code}`), else `zatca_rejected` when ZATCA's `errors` are present. */
function errorCode(status, body) {
  const error = body && body.error;
  if (typeof error === "string") return error;
  if (error && typeof error.code === "string") return error.code;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) return "zatca_rejected";
  return `http_${status}`;
}

/** A client for the Matheel API; `key` is optional on the sandbox. */
class Matheel {
  /** Creates a client; `options.fetch` replaces the global fetch, `options.timeoutMs` bounds each call (default 60 s). */
  constructor(key, baseUrl = DEFAULT_BASE_URL, options = {}) {
    this.key = key || null;
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 60000;
    if (typeof this.fetch !== "function") throw new Error("matheel: no fetch available (Node >= 18 required)");
  }

  /** POSTs JSON to an API path and returns the parsed body; throws MatheelError on any status but 200. */
  async post(path, body) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    const res = await this.fetch(this.baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: "invalid_json", raw: text };
    }
    if (res.status !== 200) throw new MatheelError(res.status, parsed);
    return parsed;
  }

  /** Files one invoice (POST /api/v1/invoices) and returns ZATCA's answer; extra fields (environment, seller, csid, mode) pass through. */
  fileInvoice({ deviceToken, invoice, pdf, ...rest }) {
    const body = { ...rest, invoice };
    if (deviceToken) body.device_token = deviceToken;
    if (pdf !== undefined) body.pdf = pdf;
    return this.post("/api/v1/invoices", body);
  }

  /**
   * Files with the device token held in `store`: writes the new token on 200, re-reads and retries on 409
   * device_token_reused (up to `retries` times), leaves the token untouched on any other error (and throws).
   */
  async fileWithStore(store, invoice, { pdf, retries = 3, ...rest } = {}) {
    for (let attempt = 0; ; attempt++) {
      const deviceToken = await store.read();
      try {
        const res = await this.fileInvoice({ ...rest, deviceToken, invoice, pdf });
        if (res.device_token) await store.write(res.device_token);
        return res;
      } catch (e) {
        if (!(e instanceof MatheelError && e.status === 409 && e.code === "device_token_reused") || attempt >= retries) throw e;
      }
    }
  }

  /** Registers a device with ZATCA (POST /api/v1/onboarding) and returns its `device_token`. */
  onboard({ environment, seller, device, otp, ...rest }) {
    const body = { ...rest, environment, seller };
    if (device) body.device = device;
    if (otp) body.otp = otp;
    return this.post("/api/v1/onboarding", body);
  }

  /** Makes a merchant activation link (POST /api/v1/onboarding/links): `{url, callback_secret, expires_at}`. */
  activationLink({ environment, reference, callbackUrl, expiresInDays, maxDevices, ...rest }) {
    const body = { ...rest, environment, reference };
    if (callbackUrl) body.callback_url = callbackUrl;
    if (expiresInDays) body.expires_in_days = expiresInDays;
    if (maxDevices) body.max_devices = maxDevices;
    return this.post("/api/v1/onboarding/links", body);
  }
}

/** Decodes the base64 TLV ZATCA QR (`qr` in Matheel's answer); byte tags 8 and 9 come back as base64. */
function decodeQr(base64Tlv) {
  const bytes = Buffer.from(String(base64Tlv).trim(), "base64");
  const tags = new Map();
  let i = 0;
  while (i + 2 <= bytes.length) {
    const tag = bytes[i++];
    let length = bytes[i++];
    if (length & 0x80) {
      // BER long form: the low bits count the length bytes that follow (keys and signatures exceed 127 bytes).
      const count = length & 0x7f;
      length = 0;
      for (let k = 0; k < count; k++) length = length * 256 + bytes[i++];
    }
    if (i + length > bytes.length) throw new Error("Truncated ZATCA QR");
    tags.set(tag, bytes.subarray(i, i + length));
    i += length;
  }
  const text = (tag) => (tags.has(tag) ? tags.get(tag).toString("utf8") : "");
  if (!text(1) || !text(2)) throw new Error("Not a ZATCA QR: tags 1 and 2 are required");
  const qr = {
    sellerName: text(1),
    vatNumber: text(2),
    timestamp: text(3),
    total: text(4),
    vatAmount: text(5),
    invoiceHash: tags.has(6) ? text(6) : null,
    signature: tags.has(7) ? text(7) : null,
  };
  if (tags.has(8)) qr.publicKey = tags.get(8).toString("base64");
  if (tags.has(9)) qr.certificateSignature = tags.get(9).toString("base64");
  return qr;
}

/** Compares two strings in constant time (false when lengths differ). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** True when `x-matheel-signature` ("sha256=<hex>") is the HMAC-SHA256 of the raw callback body with `callback_secret`. */
function verifyActivationCallback(rawBody, signatureHeader, callbackSecret) {
  if (!callbackSecret || !signatureHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", callbackSecret).update(rawBody).digest("hex");
  return safeEqual(expected, String(signatureHeader).trim().toLowerCase());
}

const TELR_FIELDS = [
  "tran_store", "tran_type", "tran_class", "tran_test", "tran_ref", "tran_prevref", "tran_firstref", "tran_order",
  "tran_currency", "tran_amount", "tran_cartid", "tran_desc", "tran_status", "tran_authcode", "tran_authmessage",
];

/** True when Telr's `tran_check` matches the SHA1 of the secret and the transaction fields (tran_order only when sent). */
function verifyTelr(postFields, secret) {
  const fields = postFields || {};
  if (!secret || !fields.tran_check) return false;
  const parts = [secret];
  for (const name of TELR_FIELDS) {
    if (name === "tran_order" && !(name in fields)) continue;
    parts.push(fields[name] == null ? "" : String(fields[name]));
  }
  const expected = crypto.createHash("sha1").update(parts.join(":")).digest("hex");
  return safeEqual(expected, String(fields.tran_check).trim().toLowerCase());
}

module.exports = { Matheel, MatheelError, decodeQr, verifyActivationCallback, verifyTelr };
