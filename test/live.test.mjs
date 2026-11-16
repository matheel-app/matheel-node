// Live test against the keyless sandbox (one filing; set MATHEEL_OFFLINE=1 to skip).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Matheel, decodeQr } from "../index.mjs";

test("files a simplified invoice on the keyless sandbox, with PDF and QR", { skip: process.env.MATHEEL_OFFLINE === "1" }, async () => {
  const res = await new Matheel().fileInvoice({
    environment: "sandbox",
    pdf: true,
    invoice: {
      type: "simplified", counter: 1, uuid: randomUUID(), number: "T-1",
      line_items: [{ name: "Iqama renewal service", quantity: 1, price: "100.00" }],
    },
  });
  assert.equal(res.status, "reported");
  assert.equal(Buffer.from(res.pdf, "base64").subarray(0, 4).toString("latin1"), "%PDF");
  assert.match(decodeQr(res.qr).vatNumber, /^\d{15}$/);
});
