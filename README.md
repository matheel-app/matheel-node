# matheel

Official Node.js client for [Matheel](https://matheel.app), the **ZATCA (Fatoora) Phase 2** e-invoicing API for Saudi
Arabia. One call signs the invoice, files it with ZATCA (reporting or clearance) and returns ZATCA's answer, the legal
XML, the QR and a bilingual PDF. Node 18+, no dependencies, ESM and CommonJS, types included.

```sh
npm install matheel
```

```js
import { Matheel } from "matheel";

const matheel = new Matheel(process.env.MATHEEL_KEY); // no key needed on the sandbox

// Try it now: the keyless sandbox files as Matheel's shared test taxpayer.
const res = await matheel.fileInvoice({
  environment: "sandbox",
  pdf: true,
  invoice: { type: "simplified", line_items: [{ name: "Iqama renewal service", quantity: 1, price: "100.00" }] },
});
res.status;                        // "reported"
Buffer.from(res.pdf, "base64");    // the PDF/A-3 invoice
```

## After a payment: `fileWithStore`

Register the device once (`onboard`, or an `activationLink` for a merchant), keep its `device_token` in one database
row, and file every paid order through `fileWithStore`. The token carries the invoice chain (counter and hash), so
invoices of one device must be filed one after another: read and write the token under a row lock.

```js
// pg (node-postgres); CREATE TABLE matheel_device (id INT PRIMARY KEY, token TEXT NOT NULL);
// order.invoice_uuid: crypto.randomUUID(), made once when the order is created and stored with it.
export async function invoiceOrder(pool, order, items) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const store = {
      read: async () => (await db.query("SELECT token FROM matheel_device WHERE id = 1 FOR UPDATE")).rows[0].token,
      write: (token) => db.query("UPDATE matheel_device SET token = $1 WHERE id = 1", [token]),
    };
    const invoice = { type: "simplified", line_items: items };
    const res = await matheel.fileWithStore(store, invoice, { pdf: true, uuid: order.invoice_uuid });
    await db.query("COMMIT");
    return res; // save res.pdf and res.invoice_xml with the order
  } catch (e) {
    await db.query("ROLLBACK"); // the old token stays valid
    throw e;
  } finally {
    db.release();
  }
}
```

What `fileWithStore` does with each answer (up to `retries` resends, default 3):

* **200**: writes the next `device_token` and returns. `replayed: true` means this document was already accepted and
  its stored answer came back: it was not filed twice.
* **409 `device_token_reused`**: another invoice moved the chain on. It writes `error.latest_device_token` and sends this
  invoice again with it.
* **409 `filing_in_progress`**: waits `Retry-After` (at most 10 s) and sends the same request again.
* Anything else: leaves the token alone and throws a `MatheelError` (`status`, `body`, `code`, `retryAfter`).

**Pass a stable `uuid`.** Make one UUID v4 per business document, store it with the order, and send it on every
attempt (`uuid` option, or `invoice.uuid`). The library never invents one: a resend after a timeout is only safe
when it carries the same uuid, which is how Matheel knows not to file it twice.

### What to do with an error: `classify(error)`

```js
import { classify } from "matheel";

try {
  await invoiceOrder(pool, order, items);
} catch (e) {
  switch (classify(e)) {
    case "retry":     queueRetry(order); break;  // same request later: same token, same uuid
    case "permanent": markInvalid(order, e.body); break;  // fix the document (ZATCA rejection, bad fields)
    case "attention": alertOps(e); break;  // key, plan, certificate, or resend e.body.error.uuid first
  }
}
```

| `classify` | Codes |
|---|---|
| `"retry"` | `network_error` (status 0: timeout, DNS, reset), `invalid_response` (a 200 that is not the API's JSON), `filing_outcome_unknown` (504), `zatca_unavailable` (503), `filing_failed`, 429, any 5xx |
| `"permanent"` | `zatca_rejected`, `invalid`, `missing_fields`, `invalid_amount`, `validation_failed` (422) |
| `"attention"` | `invalid_api_key`, `invalid_csid` (401), `production_plan_required` (402), `previous_filing_unknown` (409: resend the document `error.uuid` first), anything unknown |

## API

| | |
|---|---|
| `new Matheel(key?, baseUrl?, { fetch?, timeoutMs? })` | The client. |
| `fileInvoice({ deviceToken, invoice, pdf, ...fields })` | `POST /api/v1/invoices`. Extra fields (`environment`, `seller`, `csid`, `mode`) pass through. |
| `fileWithStore(store, invoice, { pdf, retries, uuid })` | The safe chain helper above. |
| `classify(error)` | `"retry"`, `"permanent"` or `"attention"`, per the API contract. |
| `onboard({ environment, seller, device?, otp? })` | `POST /api/v1/onboarding`, returns `device_token`. |
| `activationLink({ environment, reference, callbackUrl?, expiresInDays?, maxDevices? })` | `POST /api/v1/onboarding/links`. |
| `decodeQr(qr)` | `{ sellerName, vatNumber, timestamp, total, vatAmount, invoiceHash, signature, publicKey?, certificateSignature? }` (tags 8 and 9 as base64). |
| `verifyActivationCallback(rawBody, req.headers["x-matheel-signature"], callbackSecret)` | Checks an activation callback (HMAC-SHA256, constant time). Pass the raw body, not re-serialised JSON. |
| `verifyTelr(postFields, telrSecret)` | Checks Telr's `tran_check` on a transaction advice. |

Every non-200 answer throws `MatheelError`; `code` is the API's error code (`device_token_reused`,
`sandbox_rate_limited`, `invalid_device_token`, …) or `zatca_rejected` when ZATCA's `errors` are in the body. A network
failure throws `MatheelError` with status 0 and code `network_error`, never a raw fetch error.
Keep the key and the device token on your server, never in an app.

Docs: https://matheel.app/en/docs · Node.js guide: https://matheel.app/en/zatca-integration/nodejs ·
API reference for agents: https://matheel.app/llms.txt

## عربي

مكتبة ماثل الرسمية لـ Node.js: أرسل فاتورة زاتكا (المرحلة الثانية) بطلب واحد، ويرجع لك رد الهيئة والـ XML والـ QR والـ PDF.
بعد الدفع استخدم `fileWithStore` مع قفل صف الجهاز في قاعدة بياناتك (`SELECT … FOR UPDATE`)، وهي تحفظ `device_token`
الجديد بعد كل فاتورة مقبولة. بيئة التجربة ما تحتاج مفتاح. الدليل: [matheel.app/rabt](https://matheel.app/rabt)
