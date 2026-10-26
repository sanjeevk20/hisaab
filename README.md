# Hisaab — billing & inventory for small retailers

A phone-first web app for kirana / small retail shops:

- **Stock in** — point the phone camera at a product barcode. A known product gets its quantity increased; a new barcode asks for name, price and GST once, then it's a one-scan restock forever.
- **Bill** — scan items into a cart, apply a discount, pick Cash / UPI / Card / Udhaar, complete the sale. Sold quantities are **removed from stock automatically** in the same database transaction as the bill. If any item is short, nothing is written.
- **Receipt** — print it, or send it to the customer on WhatsApp.
- **Inventory** — search, low-stock filter, edit prices, correct stock (damage, recount), and see a full history of every stock movement.
- **Sales** — today's revenue, bill count, stock value, low-stock count, and recent bills.

Products are never deleted when they sell out — they drop to 0 and show as *Out of stock*, so the next restock is still a single scan and past bills stay intact.

## Run it

Requires Node.js 22.13+ (uses the built-in SQLite — no `npm install` needed).

```bash
npm start          # http://localhost:3000
npm test           # API tests
```

Data lives in `data/hisaab.db` (one SQLite file — back it up by copying it).

| Env var | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `HISAAB_DB` | Path to the SQLite file |
| `HISAAB_PIN` | If set, the app asks for this PIN before any API access |
| `HTTPS_KEY`, `HTTPS_CERT` | Serve over HTTPS (needed for the camera on phones) |

## Using it on a phone

Browsers only allow the camera on `https://` pages (or `localhost`). Pick one:

1. **Tunnel (easiest):** `npx cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, then open the https URL on the phone.
2. **Local HTTPS:** create a cert with [mkcert](https://github.com/FiloSottile/mkcert) for your laptop's LAN IP, then
   `HTTPS_KEY=certs/key.pem HTTPS_CERT=certs/cert.pem npm start`.
3. **Deploy** to any Node host (Render, Railway, Fly.io, a VPS) — they provide HTTPS. Mount a persistent disk for `data/`.

On the phone, use the browser's *Add to Home screen* to install it like an app. Set the shop name by tapping "My Shop" in the header. Set `HISAAB_PIN` whenever the server is reachable from the internet.

Scanning uses the native `BarcodeDetector` on Android Chrome and falls back to [ZXing](https://github.com/zxing-js/library) (loaded from unpkg) on iPhone Safari and others. Supported: EAN-13/8, UPC-A/E, Code 128/39, ITF, QR. A USB/Bluetooth barcode gun also works — it types into the barcode box.

## API

All amounts are integer **paise** (₹1 = 100). Prices are GST-inclusive; bills report the GST contained in the total.

| Method & path | Body / query | Does |
| --- | --- | --- |
| `POST /api/stock-in` | `{barcode, quantity, name?, price?, cost?, gst_rate?, low_stock?}` | Restock a known barcode, or create a new product (name + price required) |
| `GET /api/products` | `?q=` search, `?low=1` | List products |
| `GET /api/products/barcode/:code` | | Look up by barcode |
| `POST /api/products` | product fields | Create product |
| `PATCH /api/products/:id` | any of name, price, cost, gst_rate, low_stock, barcode | Edit product |
| `POST /api/products/:id/stock` | `{change, reason: "stock_in"\|"adjustment", note?}` | Manual stock change |
| `GET /api/products/:id/movements` | | Stock history |
| `POST /api/sales` | `{items:[{product_id, quantity}], discount?, payment_method?, customer_name?, customer_phone?}` | Create bill + remove stock (atomic) |
| `GET /api/sales`, `GET /api/sales/:id` | `?from=&to=&limit=` | Bills |
| `GET /api/summary` | `?since=YYYY-MM-DD HH:MM:SS` (UTC) | Dashboard numbers |

## Layout

```
server/db.js      schema + data access (SQLite, transactions, stock ledger)
server/app.js     JSON API + static hosting
server/index.js   entry point (HTTP/HTTPS)
public/           mobile web app (no build step)
test/             API tests (node:test)
```

## Possible next steps

- Multi-user logins and roles (owner vs. cashier), multiple shops
- Purchase entries with supplier and invoice, customer credit (udhaar) ledger
- Full GST invoices (GSTIN, HSN codes, CGST/SGST split), thermal printer support
- Offline mode with background sync; product lookup from a public barcode catalog
- Native app wrapper (Capacitor) if Play Store distribution is needed
