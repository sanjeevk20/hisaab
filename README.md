# Hisaab — billing & inventory for small retailers

A phone-first web app for kirana / small retail shops:

- **Stock in** — point the phone camera at a product barcode. A known product gets its quantity increased; a new barcode asks for name, price and GST once, then it's a one-scan restock forever.
- **Bill** — scan items into a cart, apply a discount, pick Cash / UPI / Card / Udhaar, complete the sale. Sold quantities are **removed from stock automatically** in the same database transaction as the bill. If any item is short, nothing is written.
- **Receipt** — print it, or send it to the customer on WhatsApp.
- **Inventory** — search, low-stock filter, edit prices, correct stock (damage, recount), and see a full history of every stock movement.
- **Supplier purchases** — when a delivery arrives, pick the supplier on *Stock in* and scan each item on their bill with its cost price. Saving the purchase adds everything to stock, updates cost prices, and records the invoice number and how much you paid now (cash / UPI / bank / cheque). The unpaid part goes on that supplier's account. The bill in progress is saved on the phone, so closing the app won't lose it.
- **Udhaar khata** — choose *Udhaar* at checkout and the bill goes on the customer's account (matched by phone, or by name for regulars). See who owes what, record full or part payments (cash / UPI / card), send a WhatsApp reminder, and carry over balances from your paper khata as an opening balance.
- **Purchase returns** — sending damaged, expired or wrong goods back? On *Stock in*, pick the supplier, switch to *Return to supplier* and scan the items. Optionally link the return to the bill they came on: the return is then valued at that bill's cost, and you can't return more than was on it. Choose *Reduce what I owe* (the usual debit note) or *Got cash back*. Stock goes down and the history shows "Returned to …". Also reachable from a supplier's page in *Khata* → *Return goods*.
- **Supplier dues** — the *Khata* tab has two sides: *Customers owe you* and *You owe suppliers*. For each supplier: what you owe (or what they owe you after a return), every purchase bill, return and payment, record a payment, call them.
- **Supplier reports** — *Reports → Suppliers*: for this month, last month, last 3 months, this financial year (from 1 April) or all time, see each supplier's bills, purchases, returns, net purchases, payments and current dues. Tap a supplier for the items bought from them (quantity, average cost, returns). Download either view as CSV for Excel, Google Sheets or your accountant.
- **Works offline** — the app opens without internet, scanning works from a saved copy of your products, and bills, stock-ins, purchases and payments are saved on the phone and synced automatically when the connection returns.
- **Sales report** — today's revenue, bill count, what customers owe you, what you owe suppliers, stock value, low-stock count, and recent bills.

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

## Offline mode

- A service worker keeps the app itself (and the iPhone scanning library) cached, so it opens with no signal.
- The product catalog and customer list are saved on the phone (IndexedDB) and refreshed whenever you're online.
- Without internet, **bills, stock-ins, supplier purchases, returns and payments (both directions) go into a queue** on the phone. A chip in the header shows `Offline · N pending`; tap it to see the queue or *Sync now*. The queue is sent in order as soon as the connection returns (and every 30 seconds while anything is pending).
- **No double entries:** every queued action has a unique `client_id`. If a request reached the server but the reply was lost, the retry is recognised and ignored.
- **Bills keep their real time** — offline bills are recorded with the time they were made, not the time they synced.
- **Stock conflicts:** if another device sold the same stock while this one was offline, the offline sale is still accepted (the goods already left the shop). Stock stops at 0 and the shortfall is logged in the product's history as *"please recount"*. Online checkouts still refuse to oversell.
- If the server rejects a queued entry (for example, invalid data), it stays in the queue marked *Rejected* with the reason, so you can retry or discard it. It is never silently dropped.
- Needs internet: editing products, stock corrections, adding a customer or supplier from the Khata tab, opening balances, opening old bills, linking a return to a bill, and supplier reports (the last copy you opened is shown). You can still bill a new customer on udhaar offline, or add a new supplier on the Stock in tab; they are created when the entry syncs.

Using more than one phone? Each phone syncs to the same server, so stock and khata stay shared.

## API

All amounts are integer **paise** (₹1 = 100). Prices are GST-inclusive; bills report the GST contained in the total. Write endpoints accept an optional `client_id`; repeating a request with the same `client_id` returns the original result instead of recording it again.

| Method & path | Body / query | Does |
| --- | --- | --- |
| `POST /api/stock-in` | `{barcode, quantity, name?, price?, cost?, gst_rate?, low_stock?, client_id?}` | Restock a known barcode, or create a new product (name + price required) |
| `GET /api/products` | `?q=` search, `?low=1` | List products |
| `GET /api/products/barcode/:code` | | Look up by barcode |
| `POST /api/products` | product fields | Create product |
| `PATCH /api/products/:id` | any of name, price, cost, gst_rate, low_stock, barcode | Edit product |
| `POST /api/products/:id/stock` | `{change, reason: "stock_in"\|"adjustment", note?}` | Manual stock change |
| `GET /api/products/:id/movements` | | Stock history |
| `POST /api/sales` | `{items:[{product_id \| barcode, quantity}], discount?, payment_method?: cash\|upi\|card\|credit, customer_id? \| customer_name? + customer_phone?, client_id?, created_at?, offline?}` | Create bill + remove stock (atomic). `credit` puts it on the customer's khata |
| `GET /api/customers` | `?q=`, `?due=1` | Customers with current balance, largest dues first |
| `POST /api/customers` | `{name, phone?, opening_balance?}` | Add customer (opening balance from a paper khata) |
| `GET /api/customers/:id` | | Customer, balance and khata entries |
| `POST /api/customers/:id/payments` | `{amount, method?, note?, client_id?, created_at?}` | Record an udhaar payment (can't exceed the balance) |
| `GET /api/suppliers` | `?q=`, `?due=1` | Suppliers with what you owe them, largest first |
| `POST /api/suppliers` | `{name, phone?, gstin?, opening_balance?}` | Add supplier (opening balance = what you already owe) |
| `GET /api/suppliers/:id` | | Supplier, balance, khata entries and recent purchases |
| `POST /api/suppliers/:id/payments` | `{amount, method?: cash\|upi\|bank\|cheque, note?, client_id?, created_at?}` | Record a payment to the supplier (can't exceed what you owe) |
| `POST /api/purchases` | `{supplier_id \| supplier_name + supplier_phone?, invoice_no?, items:[{barcode, quantity, unit_cost, name?, price?, gst_rate?, low_stock?}], paid?, payment_method?, note?, client_id?, created_at?}` | Supplier bill: adds stock, sets cost prices, creates new products (name + price required) and the supplier if new; `total − paid` goes on their khata. All-or-nothing |
| `GET /api/purchases`, `GET /api/purchases/:id` | `?supplier_id=&limit=` | Purchase bills; a single bill includes `returnable` (what can still be returned from it) |
| `POST /api/purchase-returns` | `{supplier_id, purchase_id?, items:[{barcode, quantity, unit_cost?}], settlement?: adjust\|refund, refund_method?, reason?, client_id?, created_at?}` | Goods back to a supplier: stock down; `adjust` reduces what you owe, `refund` records cash back. With `purchase_id`, lines must be on that bill and within what's left to return |
| `GET /api/purchase-returns`, `GET /api/purchase-returns/:id` | `?supplier_id=&limit=` | Returns |
| `GET /api/reports/suppliers` | `?from=&to=` (UTC, `to` exclusive; default this month), `&format=csv` | Per-supplier bills, purchased, returned, net, paid, refunded, balance, last purchase, with totals |
| `GET /api/reports/suppliers/:id` | same | One supplier: summary, items bought (qty, amount, avg cost, returned), purchases and returns |
| `GET /api/sales`, `GET /api/sales/:id` | `?from=&to=&limit=` | Bills |
| `GET /api/summary` | `?since=YYYY-MM-DD HH:MM:SS` (UTC) | Dashboard numbers |

## Layout

```
server/db.js      schema, migrations + data access (SQLite, transactions, stock ledger, customer & supplier khata, purchases)
server/app.js     JSON API + static hosting
server/index.js   entry point (HTTP/HTTPS)
public/           mobile web app (no build step)
  offline.js      IndexedDB cache, outbox queue and sync
  sw.js           service worker (offline app shell) — bump CACHE when changing app files
test/             API tests (node:test)
```

## Possible next steps

- Multi-user logins and roles (owner vs. cashier), multiple shops
- Customer returns on a bill; product-wise sales and profit (margin) reports
- Full GST invoices (GSTIN, HSN codes, CGST/SGST split), thermal printer support
- Product lookup from a public barcode catalog; SMS reminders for udhaar
- Native app wrapper (Capacitor) if Play Store distribution is needed
