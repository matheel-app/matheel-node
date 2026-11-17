// Official Node.js client for the Matheel ZATCA Phase 2 e-invoicing API (https://matheel.app). No dependencies.
"use strict";

const crypto = require("node:crypto");
const https = require("node:https");

const DEFAULT_BASE_URL = "https://matheel.app";

/** A failed call: an API answer other than 200 (HTTP status, parsed body, error code), or status 0 for a network failure. */
class MatheelError extends Error {
  /** Builds the error from the HTTP status, the parsed response body and the Retry-After header (seconds, or null). */
  constructor(status, body, retryAfter = null) {
    const code = errorCode(status, body);
    super(`Matheel ${status}: ${code}`);
    this.name = "MatheelError";
    this.status = status;
    this.body = body;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// What the caller should do with an error, per the API contract (https://matheel.app/llms.txt).
const RETRY_CODES = new Set([
  "network_error", "invalid_response", "device_token_reused", "filing_in_progress", "filing_outcome_unknown",
  "zatca_unavailable", "filing_failed", "billing_unavailable", "sandbox_rate_limited",
]);
const PERMANENT_CODES = new Set(["zatca_rejected", "invalid", "missing_fields", "invalid_amount", "validation_failed"]);

/**
 * "retry" (send the same request again later: same token, same invoice.uuid), "permanent" (fix the document) or
 * "attention" (a person must act: key, plan, certificate, an earlier unanswered document, anything unknown).
 */
function classify(error) {
  if (!(error instanceof MatheelError)) return "attention";
  if (RETRY_CODES.has(error.code)) return "retry";
  if (PERMANENT_CODES.has(error.code)) return "permanent";
  if (error.status === 0 || error.status === 429 || error.status >= 500) return "retry";
  return "attention";
}

/** The MatheelError for an answer that is not the API's JSON (an HTML page, a 200 with no device_token). */
function invalidResponse(body) {
  return new MatheelError(502, { error: "invalid_response", raw: body });
}

/** Waits `ms` milliseconds. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The code of an error body: `error` (a string or `{code}`), else `zatca_rejected` when ZATCA's `errors` are present. */
function errorCode(status, body) {
  const error = body && body.error;
  if (typeof error === "string") return error;
  if (error && typeof error.code === "string") return error.code;
  if (body && Array.isArray(body.errors) && body.errors.length > 0) return "zatca_rejected";
  return `http_${status}`;
}

// Some networks between a cloud host and Matheel's edge drop the large post-quantum TLS ClientHello that
// OpenSSL 3.5 (Node 24+) sends by default (measured 2026-11-17: Node 24 fetch fails, the same call with a classic
// key share succeeds). So the default transport is node:https with a classic key share; options.fetch overrides it.
const CURVES = "X25519:P-256:P-384";

/** A minimal fetch over node:https with a classic TLS key share: enough for the JSON POSTs this client makes. */
function httpsFetch(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, signal, ecdhCurve: CURVES }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: { get: (name) => res.headers[name.toLowerCase()] ?? null }, text: async () => text });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A client for the Matheel API; `key` is optional on the sandbox. */
class Matheel {
  /** Creates a client; `options.fetch` replaces the built-in node:https transport, `options.timeoutMs` bounds each call (default 60 s). */
  constructor(key, baseUrl = DEFAULT_BASE_URL, options = {}) {
    this.key = key || null;
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch || httpsFetch;
    this.timeoutMs = options.timeoutMs || 60000;
  }

  /** POSTs JSON to an API path and returns the parsed body; throws MatheelError on any status but 200 (status 0 when the network failed). */
  async post(path, body) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.key) headers.Authorization = `Bearer ${this.key}`;
    let res, text;
    try {
      res = await this.fetch(this.baseUrl + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      // Timeouts, DNS, resets, TLS: the request may or may not have reached Matheel, so it is safe to send again.
      const error = new MatheelError(0, { error: "network_error", message: String((e && e.message) || e) });
      error.cause = e;
      throw error;
    }
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: "invalid_json", raw: text };
    }
    if (res.status !== 200) {
      const header = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
      const retryAfter = header == null || header === "" ? NaN : Number(header);
      throw new MatheelError(res.status, parsed, retryAfter >= 0 ? retryAfter : null);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.error === "invalid_json") throw invalidResponse(text);
    return parsed;
  }

  /** Files one invoice (POST /api/v1/invoices) and returns ZATCA's answer; extra fields (environment, seller, csid, mode) pass through. */
  async fileInvoice({ deviceToken, invoice, pdf, ...rest }) {
    const body = { ...rest, invoice };
    if (deviceToken) body.device_token = deviceToken;
    if (pdf !== undefined) body.pdf = pdf;
    const res = await this.post("/api/v1/invoices", body);
    // A device filing always answers with the next token; without one the answer did not come from the API.
    if (deviceToken && typeof res.device_token !== "string") throw invalidResponse(res);
    return res;
  }

  /**
   * Files with the device token held in `store` and writes the next token on 200. Up to `retries` times it stores
   * the latest token and resends on 409 device_token_reused, or waits Retry-After (max 10 s) on filing_in_progress.
   * `uuid` is put into an invoice that has none: pass one per business document so a resend is never filed twice.
   */
  async fileWithStore(store, invoice, { pdf, retries = 3, uuid, ...rest } = {}) {
    if (uuid && invoice && !invoice.uuid) invoice = { ...invoice, uuid };
    let deviceToken = await store.read();
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fileInvoice({ ...rest, deviceToken, invoice, pdf });
        if (res.device_token) await store.write(res.device_token);
        return res;
      } catch (e) {
        if (!(e instanceof MatheelError && e.status === 409) || attempt >= retries) throw e;
        const latest = e.body && e.body.error && e.body.error.latest_device_token;
        if (e.code === "device_token_reused" && latest) {
          await store.write(latest);
          deviceToken = latest;
        } else if (e.code === "device_token_reused") {
          deviceToken = await store.read(); // no latest token in the answer: another writer may have stored it
        } else if (e.code === "filing_in_progress") {
          await this.wait(Math.min(e.retryAfter ?? 5, 10) * 1000);
        } else {
          throw e;
        }
      }
    }
  }

  /** Sleeps between fileWithStore retries; replace it in tests. */
  wait(ms) {
    return delay(ms);
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

module.exports = { Matheel, MatheelError, classify, decodeQr, verifyActivationCallback, verifyTelr };
