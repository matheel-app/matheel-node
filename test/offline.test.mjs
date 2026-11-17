// Offline tests: QR decoding, callback and Telr signatures, and the fileWithStore chain helper on a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Matheel, MatheelError, classify, decodeQr, verifyActivationCallback, verifyTelr } from "../index.mjs";
import cjs from "../index.cjs";

/** One TLV field, with a BER long-form length when the value exceeds 127 bytes. */
function tlv(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const len = v.length < 128 ? Buffer.from([v.length]) : Buffer.from([0x81, v.length]);
  return Buffer.concat([Buffer.from([tag]), len, v]);
}

test("CJS and ESM expose the same functions", () => {
  assert.equal(cjs.decodeQr, decodeQr);
  assert.equal(cjs.Matheel, Matheel);
});

test("decodeQr reads tags 1-9, Arabic text and long-form lengths", () => {
  const key = Buffer.alloc(136, 7);
  const qr = Buffer.concat([
    tlv(1, "شركة ماثل"), tlv(2, "399999999900003"), tlv(3, "2026-11-16T10:00:00"), tlv(4, "115.00"), tlv(5, "15.00"),
    tlv(6, "aGFzaA=="), tlv(7, "c2ln"), tlv(8, key), tlv(9, Buffer.from([1, 2, 3])),
  ]).toString("base64");
  const d = decodeQr(qr);
  assert.equal(d.sellerName, "شركة ماثل");
  assert.equal(d.vatNumber, "399999999900003");
  assert.equal(d.timestamp, "2026-11-16T10:00:00");
  assert.equal(d.total, "115.00");
  assert.equal(d.vatAmount, "15.00");
  assert.equal(d.invoiceHash, "aGFzaA==");
  assert.equal(d.signature, "c2ln");
  assert.deepEqual(Buffer.from(d.publicKey, "base64"), key);
  assert.equal(d.certificateSignature, "AQID");
});

test("decodeQr rejects truncated and non-ZATCA input", () => {
  const full = Buffer.concat([tlv(1, "Seller"), tlv(2, "399999999900003")]);
  assert.throws(() => decodeQr(full.subarray(0, full.length - 3).toString("base64")), /Truncated/);
  assert.throws(() => decodeQr(tlv(3, "x").toString("base64")), /tags 1 and 2/);
});

test("verifyActivationCallback accepts the right HMAC only", () => {
  const body = JSON.stringify({ reference: "m-1", devices: [{ device_token: "mdt1.x" }] });
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifyActivationCallback(body, sig, "s3cret"), true);
  assert.equal(verifyActivationCallback(Buffer.from(body), sig.toUpperCase().replace("SHA256", "sha256"), "s3cret"), true);
  assert.equal(verifyActivationCallback(body + " ", sig, "s3cret"), false);
  assert.equal(verifyActivationCallback(body, sig, "other"), false);
  assert.equal(verifyActivationCallback(body, undefined, "s3cret"), false);
  assert.equal(verifyActivationCallback(body, sig, ""), false);
});

test("verifyTelr checks tran_check with and without tran_order", () => {
  const f = {
    tran_store: "12345", tran_type: "sale", tran_class: "ecom", tran_test: "1", tran_ref: "040029158825",
    tran_prevref: "", tran_firstref: "040029158825", tran_currency: "SAR", tran_amount: "115.00",
    tran_cartid: "order-9", tran_desc: "Iqama renewal", tran_status: "A", tran_authcode: "123456", tran_authmessage: "Authorised",
  };
  const order = ["tran_store", "tran_type", "tran_class", "tran_test", "tran_ref", "tran_prevref", "tran_firstref"];
  const tail = ["tran_currency", "tran_amount", "tran_cartid", "tran_desc", "tran_status", "tran_authcode", "tran_authmessage"];
  const sha1 = (s) => createHash("sha1").update(s).digest("hex");
  const without = { ...f, tran_check: sha1(["secret", ...order.map((k) => f[k]), ...tail.map((k) => f[k])].join(":")).toUpperCase() };
  assert.equal(verifyTelr(without, "secret"), true);
  assert.equal(verifyTelr({ ...without, tran_amount: "1.00" }, "secret"), false);
  assert.equal(verifyTelr(without, "wrong"), false);
  const withOrder = { ...f, tran_order: "ORD1" };
  withOrder.tran_check = sha1(["secret", ...order.map((k) => f[k]), "ORD1", ...tail.map((k) => f[k])].join(":"));
  assert.equal(verifyTelr(withOrder, "secret"), true);
  assert.equal(verifyTelr({ ...f }, "secret"), false);
});

/** A fetch that answers from a queue of [status, body, headers?] (a string body is sent raw) and records each request. */
function mockFetch(answers, calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const [status, body, headers = {}] = answers.shift();
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
  };
}

/** An in-memory TokenStore that counts writes. */
function memoryStore(token) {
  const s = { token, writes: [], reads: 0 };
  s.read = async () => { s.reads++; return s.token; };
  s.write = async (t) => { s.writes.push(t); s.token = t; };
  return s;
}

test("fileWithStore: 409 then 200 re-reads the token, writes the new one once", async () => {
  const calls = [];
  const fetch = mockFetch([
    [409, { error: { code: "device_token_reused", message: "…" } }],
    [200, { status: "reported", device_token: "mdt1.new" }],
  ], calls);
  const store = memoryStore("mdt1.old");
  const res = await new Matheel("mtl_x", "https://example.test/", { fetch }).fileWithStore(store, { type: "simplified" }, { pdf: true });
  assert.equal(res.status, "reported");
  assert.deepEqual(store.writes, ["mdt1.new"]);
  assert.equal(store.reads, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://example.test/api/v1/invoices");
  assert.equal(calls[0].auth, "Bearer mtl_x");
  assert.deepEqual(calls[1].body, { invoice: { type: "simplified" }, device_token: "mdt1.old", pdf: true });
});

test("fileWithStore: a rejection leaves the token untouched and throws a typed error", async () => {
  const calls = [];
  const rejected = { status: "rejected", errors: [{ code: "BR-KSA-33" }] };
  const fetch = mockFetch([[422, rejected]], calls);
  const store = memoryStore("mdt1.old");
  await assert.rejects(new Matheel(null, undefined, { fetch }).fileWithStore(store, {}), (e) => {
    assert.ok(e instanceof MatheelError);
    assert.equal(e.status, 422);
    assert.equal(e.code, "zatca_rejected");
    assert.deepEqual(e.body, rejected);
    return true;
  });
  assert.deepEqual(store.writes, []);
  assert.equal(calls[0].auth, undefined);
});

test("fileWithStore: gives up after 3 retries on repeated 409", async () => {
  const calls = [];
  const reused = [409, { error: { code: "device_token_reused" } }];
  const fetch = mockFetch([reused, reused, reused, reused, reused], calls);
  const store = memoryStore("mdt1.old");
  await assert.rejects(new Matheel(null, undefined, { fetch }).fileWithStore(store, {}), { code: "device_token_reused", status: 409 });
  assert.equal(calls.length, 4);
  assert.deepEqual(store.writes, []);
});

test("onboard and activationLink send the documented bodies", async () => {
  const calls = [];
  const fetch = mockFetch([[200, { device_token: "mdt1.a" }], [200, { url: "https://matheel.app/activate#x" }]], calls);
  const m = new Matheel("k", undefined, { fetch });
  await m.onboard({ environment: "sandbox", seller: { vat_number: "1" }, device: { name: "Till 1" } });
  await m.activationLink({ environment: "production", reference: "m-42", callbackUrl: "https://a.test/cb", maxDevices: 3 });
  assert.equal(calls[0].url, "https://matheel.app/api/v1/onboarding");
  assert.deepEqual(calls[0].body, { environment: "sandbox", seller: { vat_number: "1" }, device: { name: "Till 1" } });
  assert.equal(calls[1].url, "https://matheel.app/api/v1/onboarding/links");
  assert.deepEqual(calls[1].body, { environment: "production", reference: "m-42", callback_url: "https://a.test/cb", max_devices: 3 });
});

test("error codes come from a string error", async () => {
  const fetch = mockFetch([[429, { error: "sandbox_rate_limited" }]], []);
  await assert.rejects(new Matheel(null, undefined, { fetch }).fileInvoice({ invoice: {} }), { code: "sandbox_rate_limited", status: 429 });
});

test("fileWithStore: 409 with latest_device_token stores it and resends with it; uuid fills an invoice without one", async () => {
  const calls = [];
  const fetch = mockFetch([
    [409, { error: { code: "device_token_reused", latest_device_token: "mdt1.latest", latest_counter: 7 } }],
    [200, { status: "reported", device_token: "mdt1.next", counter: 8 }],
  ], calls);
  const store = memoryStore("mdt1.old");
  const uuid = "3cf5ee18-ee25-44ea-a444-2c37ba7f28be";
  const res = await new Matheel(null, undefined, { fetch }).fileWithStore(store, { type: "simplified" }, { uuid });
  assert.equal(res.counter, 8);
  assert.deepEqual(store.writes, ["mdt1.latest", "mdt1.next"]);
  assert.deepEqual(calls.map((c) => c.body.device_token), ["mdt1.old", "mdt1.latest"]);
  assert.deepEqual(calls.map((c) => c.body.invoice.uuid), [uuid, uuid]);
  const own = await new Matheel(null, undefined, { fetch: mockFetch([[200, { device_token: "t" }]], calls) })
    .fileWithStore(memoryStore("x"), { uuid: "own" }, { uuid });
  assert.equal(own.device_token, "t");
  assert.equal(calls[2].body.invoice.uuid, "own");
});

test("fileWithStore: 409 filing_in_progress waits Retry-After (capped at 10 s) and resends the same request", async () => {
  const calls = [];
  const busy = { error: { code: "filing_in_progress" } };
  const fetch = mockFetch([[409, busy, { "retry-after": "5" }], [409, busy, { "retry-after": "60" }], [200, { device_token: "mdt1.next" }]], calls);
  const m = new Matheel(null, undefined, { fetch });
  const waits = [];
  m.wait = async (ms) => { waits.push(ms); };
  const store = memoryStore("mdt1.old");
  await m.fileWithStore(store, { uuid: "u1" });
  assert.deepEqual(waits, [5000, 10000]);
  assert.deepEqual(calls.map((c) => c.body), Array(3).fill({ invoice: { uuid: "u1" }, device_token: "mdt1.old" }));
  assert.deepEqual(store.writes, ["mdt1.next"]);
});

test("fileWithStore: in_progress is bounded and previous_filing_unknown is not retried", async () => {
  const busy = [409, { error: { code: "filing_in_progress" } }, { "retry-after": "1" }];
  const m = new Matheel(null, undefined, { fetch: mockFetch([busy, busy, busy, busy, busy], []) });
  m.wait = async () => {};
  await assert.rejects(m.fileWithStore(memoryStore("t"), {}, { retries: 2 }), (e) => e.code === "filing_in_progress" && e.retryAfter === 1);
  const calls = [];
  const prev = [409, { error: { code: "previous_filing_unknown", uuid: "earlier" } }];
  await assert.rejects(new Matheel(null, undefined, { fetch: mockFetch([prev], calls) }).fileWithStore(memoryStore("t"), {}), (e) => {
    assert.equal(classify(e), "attention");
    assert.equal(e.body.error.uuid, "earlier");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("network failures become MatheelError status 0 network_error (mocked fetch and the real transport)", async () => {
  for (const thrown of [new TypeError("fetch failed"), new DOMException("The operation timed out.", "TimeoutError")]) {
    const fetch = async () => { throw thrown; };
    const store = memoryStore("mdt1.old");
    await assert.rejects(new Matheel(null, undefined, { fetch }).fileWithStore(store, {}), (e) => {
      assert.ok(e instanceof MatheelError);
      assert.equal(e.status, 0);
      assert.equal(e.code, "network_error");
      assert.equal(e.cause, thrown);
      assert.equal(classify(e), "retry");
      return true;
    });
    assert.deepEqual(store.writes, []);
  }
  // Nothing listens on port 1: the built-in node:https transport must fail the same way.
  await assert.rejects(new Matheel(null, "https://127.0.0.1:1").fileInvoice({ invoice: {} }), { status: 0, code: "network_error" });
});

test("a 200 that is not the API's answer is invalid_response, never success", async () => {
  const html = "<!DOCTYPE html><html><body>Login to Wi-Fi</body></html>";
  for (const body of [html, { status: "reported" }, "null"]) {
    const store = memoryStore("mdt1.old");
    const m = new Matheel(null, undefined, { fetch: mockFetch([[200, body]], []) });
    await assert.rejects(m.fileWithStore(store, {}), (e) => {
      assert.ok(e instanceof MatheelError);
      assert.equal(e.code, "invalid_response");
      assert.equal(e.status, 502);
      assert.equal(classify(e), "retry");
      return true;
    });
    assert.deepEqual(store.writes, []);
  }
  // Without a device_token (keyless sandbox, own credentials) a JSON 200 with no token is fine.
  const ok = await new Matheel(null, undefined, { fetch: mockFetch([[200, { status: "reported" }]], []) }).fileInvoice({ invoice: {} });
  assert.equal(ok.status, "reported");
});

test("classify follows the API contract", () => {
  const e = (status, error) => new MatheelError(status, { error });
  const cases = [
    [e(0, "network_error"), "retry"], [e(502, "invalid_response"), "retry"], [e(504, { code: "filing_outcome_unknown" }), "retry"],
    [e(503, { code: "zatca_unavailable" }), "retry"], [e(429, "sandbox_rate_limited"), "retry"], [e(500, "boom"), "retry"],
    [e(409, { code: "device_token_reused" }), "retry"], [e(409, { code: "filing_in_progress" }), "retry"],
    [e(422, { code: "filing_failed" }), "retry"],
    [new MatheelError(422, { status: "rejected", errors: [{ code: "BR-KSA-33" }] }), "permanent"],
    [e(422, { code: "zatca_rejected" }), "permanent"], [e(422, { code: "invalid" }), "permanent"],
    [e(422, { code: "missing_fields" }), "permanent"], [e(422, { code: "invalid_amount" }), "permanent"],
    [e(422, { code: "validation_failed" }), "permanent"],
    [e(401, "invalid_api_key"), "attention"], [e(401, { code: "invalid_csid" }), "attention"],
    [e(402, "production_plan_required"), "attention"], [e(409, { code: "previous_filing_unknown" }), "attention"],
    [new Error("store failed"), "attention"],
  ];
  for (const [error, expected] of cases) assert.equal(classify(error), expected, error.message);
});
