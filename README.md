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
export async function invoiceOrder(pool, items) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const store = {
      read: async () => (await db.query("SELECT token FROM matheel_device WHERE id = 1 FOR UPDATE")).rows[0].token,
      write: (token) => db.query("UPDATE matheel_device SET token = $1 WHERE id = 1", [token]),
    };
    const res = await matheel.fileWithStore(store, { type: "simplified", line_items: items }, { pdf: true });
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

On 200 it writes the new token. On `409 device_token_reused` it re-reads the token and retries (3 times). On any other
error it leaves the token alone and throws a `MatheelError` (`status`, `body`, `code`): fix the invoice and resend.

## API

| | |
|---|---|
| `new Matheel(key?, baseUrl?, { fetch?, timeoutMs? })` | The client. |
| `fileInvoice({ deviceToken, invoice, pdf, ...fields })` | `POST /api/v1/invoices`. Extra fields (`environment`, `seller`, `csid`, `mode`) pass through. |
| `fileWithStore(store, invoice, { pdf, retries })` | The safe chain helper above. |
| `onboard({ environment, seller, device?, otp? })` | `POST /api/v1/onboarding`, returns `device_token`. |
| `activationLink({ environment, reference, callbackUrl?, expiresInDays?, maxDevices? })` | `POST /api/v1/onboarding/links`. |
| `decodeQr(qr)` | `{ sellerName, vatNumber, timestamp, total, vatAmount, invoiceHash, signature, publicKey?, certificateSignature? }` (tags 8 and 9 as base64). |
| `verifyActivationCallback(rawBody, req.headers["x-matheel-signature"], callbackSecret)` | Checks an activation callback (HMAC-SHA256, constant time). Pass the raw body, not re-serialised JSON. |
| `verifyTelr(postFields, telrSecret)` | Checks Telr's `tran_check` on a transaction advice. |

Every non-200 answer throws `MatheelError`; `code` is the API's error code (`device_token_reused`,
`sandbox_rate_limited`, `invalid_device_token`, …) or `zatca_rejected` when ZATCA's `errors` are in the body.
Keep the key and the device token on your server, never in an app.

Docs: https://matheel.app/en/docs · Node.js guide: https://matheel.app/en/zatca-integration/nodejs ·
API reference for agents: https://matheel.app/llms.txt

## عربي

مكتبة ماثل الرسمية لـ Node.js: أرسل فاتورة زاتكا (المرحلة الثانية) بطلب واحد، ويرجع لك رد الهيئة والـ XML والـ QR والـ PDF.
بعد الدفع استخدم `fileWithStore` مع قفل صف الجهاز في قاعدة بياناتك (`SELECT … FOR UPDATE`)، وهي تحفظ `device_token`
الجديد بعد كل فاتورة مقبولة. بيئة التجربة ما تحتاج مفتاح. الدليل: [matheel.app/rabt](https://matheel.app/rabt)
