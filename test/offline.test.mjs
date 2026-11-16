// Offline tests: QR decoding, callback and Telr signatures, and the fileWithStore chain helper on a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Matheel, MatheelError, decodeQr, verifyActivationCallback, verifyTelr } from "../index.mjs";
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

/** A fetch that answers from a queue of [status, body] and records each request body. */
function mockFetch(answers, calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const [status, body] = answers.shift();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
