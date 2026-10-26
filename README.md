# Hisaab — billing & inventory for small retailers

A phone-first web app for kirana / small retail shops:

- **Stock in** — point the phone camera at a product barcode. A known product gets its quantity increased; a new barcode asks for name, price and GST once, then it's a one-scan restock forever.
- **Bill** — scan items into a cart, apply a discount, pick Cash / UPI / Card / Udhaar, complete the sale. Sold quantities are **removed from stock automatically** in the same database transaction as the bill. If any item is short, nothing is written.
- **Receipt** — print it, or send it to the customer on WhatsApp.
- **Customer returns** — on *Bill*, switch to *Customer return*. Load the bill (type its number, or tap *↩ Return* on any receipt) and the refund is exactly what the customer paid, after their share of any bill discount. You can't return more than was bought. No bill? Just scan the items; they're refunded at today's price. Refund in Cash / UPI / Card or *Off udhaar*; an udhaar bill defaults to coming off the khata. Untick *Put back in stock* for damaged goods.
- **Inventory** — search, low-stock filter, edit prices, correct stock (damage, recount), and see a full history of every stock movement.
- **Supplier purchases** — when a delivery arrives, pick the supplier on *Stock in* and scan each item on their bill with its cost price. Saving the purchase adds everything to stock, updates cost prices, and records the invoice number and how much you paid now (cash / UPI / bank / cheque). The unpaid part goes on that supplier's account. The bill in progress is saved on the phone, so closing the app won't lose it.
- **Udhaar khata** — choose *Udhaar* at checkout and the bill goes on the customer's account (matched by phone, or by name for regulars). See who owes what, record full or part payments (cash / UPI / card), send a WhatsApp reminder, and carry over balances from your paper khata as an opening balance.
- **Purchase returns** — sending damaged, expired or wrong goods back? On *Stock in*, pick the supplier, switch to *Return to supplier* and scan the items. Optionally link the return to the bill they came on: the return is then valued at that bill's cost, and you can't return more than was on it. Choose *Reduce what I owe* (the usual debit note) or *Got cash back*. Stock goes down and the history shows "Returned to …". Also reachable from a supplier's page in *Khata* → *Return goods*.
- **Supplier dues** — the *Khata* tab has two sides: *Customers owe you* and *You owe suppliers*. For each supplier: what you owe (or what they owe you after a return), every purchase bill, return and payment, record a payment, call them.
- **Supplier reports** — *Reports → Suppliers*: for this month, last month, last 3 months, this financial year (from 1 April) or all time, see each supplier's bills, purchases, returns, net purchases, payments and current dues. Tap a supplier for the items bought from them (quantity, average cost, returns). Download either view as CSV for Excel, Google Sheets or your accountant.
- **Works offline** — the app opens without internet, scanning works from a saved copy of your products, and bills, stock-ins, purchases and payments are saved on the phone and synced automatically when the connection returns.
- **Profit report** — *Reports → Profit*: net sales (after discounts and returns), cost of goods sold, gross profit and margin for any period, a profit-by-day chart, and every product's profit and margin. Sort to find low-margin and loss-making items. Each sale records the cost price at the moment of sale, so changing a cost later doesn't rewrite past profit. Products with no cost price are flagged. GST inside sales is shown separately for shops that pay it. CSV by product or by day.
- **Sales report** — today's revenue (net of returns), bill count, what customers owe you, what you owe suppliers, stock value, low-stock count, and recent bills.

Products are never deleted when they sell out — they drop to 0 and show as *Out of stock*, so the next restock is still a single scan and past bills stay intact.

## Owner and cashier logins

A new shop starts without logins. Open **Settings → Set up owner login** (6–12 digit PIN) to protect it, then **People → Add a person** for each cashier (4–12 digit PIN). From then on every phone shows a sign-in screen, and the server checks every request.

| | Owner | Cashier |
| --- | --- | --- |
| Billing, udhaar sales, collecting udhaar payments, adding customers | ✓ | ✓ |
| Restocking products that already exist | ✓ | ✓ |
| Seeing their own bills and today's own sales | ✓ | ✓ (own only) |
| Cost prices, profit, supplier dues, all reports, GSTR-1 | ✓ | — (cost prices are never sent to a cashier's phone) |
| Adding products, changing prices, stock corrections | ✓ | — |
| Customer returns and refunds | ✓ | Within the owner's limits (below) |
| Purchases, suppliers, supplier returns | ✓ | — |
| Opening balances, settings, people, backups, change log | ✓ | — |

- **Who did what:** every bill, credit note, purchase, return, payment, stock movement and edit records who did it. Owners see it on bills ("Billed by Ravi"), in the bill list and in the change log.
- **PINs:** stored only as salted scrypt hashes. Sign-in tokens are stored only as hashes, so a backup can't be used to sign in.
- **Lockout:** five wrong PINs lock that login for 15 minutes. The owner can reset a PIN, which signs that person out everywhere.
- **Turning a login off** signs the person out at once. The last owner can't be removed or demoted.
- **Sessions:** last 30 days from last use. *Settings → Switch user* signs out. Before it does, anything the current person did offline must sync, so it's recorded under their name. Their cached data is then wiped from the phone.
- **Offline:** a signed-in phone keeps working offline. Signing in, switching user and managing people need the internet.

**Cashier returns.** By default only the owner can take returns, because unsupervised refunds are the most common way money goes missing at a counter. To let cashiers take them, set limits in **Settings → Cashier returns**:
- **Most per return** (e.g. ₹500). Set it to 0 to keep returns owner-only.
- **Most per cashier per day** (optional cap across all their returns).
- **Bill no older than** N days (default 7).

A cashier's return must be against a bill: they type the number on the customer's receipt, or tap ↩ Return on it. The app shows their limits and what's left today, and refuses anything over the limit before money changes hands. The server checks the same limits inside the same database step that saves the return, so even two returns at the same moment can't go past the daily cap together. Every return records who took it.

## GST compliance (regular registration)

Tap the shop name in the header → **Settings**, tick *Registered under GST (regular)*, and enter your GSTIN (the check digit is verified), legal name and address. From then on:

**Tax invoices (Rule 46).** Every bill is a *Tax Invoice* with your name, address, GSTIN and state; a serial number unique to the financial year (at most 16 characters, e.g. `A/26-27/00001`); the date; place of supply; *Reverse charge: No*; and per item the HSN code, quantity and unit, rate, taxable value and GST rate. A tax summary shows CGST + SGST (intra-state) or IGST (inter-state) for each rate. It also prints the amount in words and a signatory line.
- **B2B:** open *Business buyer (GSTIN)* at checkout, enter the buyer's GSTIN, legal name and address. Every item then needs an HSN code (4 digits, or 6 above ₹5 crore turnover; Notification 78/2020).
- **B2C ≥ ₹50,000:** the customer's name and address are required.
- **Place of supply** defaults to your state, since goods handed over at the counter are supplied there. Change it only when you deliver to another state; that makes the invoice IGST.
- **GST rates:** only current rates can be used: 0, 0.25, 3, 5, 18, 40%, and 28% for the tobacco items still on it. 12% items are flagged in Inventory for you to update.

**Numbering that works offline.** Rule 46(b) allows more than one series, so each phone gets its own (`A`, `B`, …) the first time it connects. It can then number invoices and credit notes with no internet, and two phones can never issue the same number. Numbers restart every 1 April (Indian time). If an offline bill is discarded, its number is reported as cancelled, never reused.

**Credit notes for returns (Rule 53, Section 34).** A customer return produces a *Credit Note* with its own series (`CNA/26-27/0001`). It quotes the original invoice number and date and reverses the tax exactly as the invoice charged it. It must be issued by 30 November after the end of that invoice's financial year, and returns without a bill aren't allowed (there's no invoice to credit).

**GSTR-1 (Reports → GST).** Pick the month to see the taxable value and output tax (CGST, SGST, IGST), then download each table as CSV in the GST offline tool's layout:
- B2B
- B2C large (inter-state above ₹1 lakh, Rule 59(4) since August 2024)
- B2C small (by state and rate, net of credit notes)
- CDNR and CDNUR
- HSN summary split B2B / B2C (Table 12)
- Documents issued (Table 13, with cancelled numbers)

The tables add up: B2B + B2C − credit notes = HSN summary = the month's total.

**Records (Rules 56–57).** Bills, purchases, payments and returns are never edited or deleted; corrections are new entries. Edits to products and settings, and voided numbers, go into a **change log** (Settings → Change log). The server writes a **backup every day** to `data/backups/` and keeps 60 days (`HISAAB_BACKUP_DIR`, `HISAAB_BACKUP_KEEP`). Settings → *Download backup* gives you a copy to keep off the machine. Records are kept indefinitely; the law asks for at least 72 months.

**Not covered — use your CA or other software for these:**
- e-invoicing (IRN/QR; only above ₹5 crore turnover)
- e-way bills
- GSTR-3B filing (the GST tab gives the outward-tax figures for 3.1(a))
- input tax credit / GSTR-2B reconciliation of purchases
- compensation cess
- composition scheme (bill of supply)
- uploading to the GST portal (use the offline tool with these CSVs)

Have your CA review an invoice and a month's GSTR-1 files before you rely on them.

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
| `HISAAB_PIN` | Optional extra shared PIN asked before any API access (older setup; owner/cashier logins are the better option) |
| `HTTPS_KEY`, `HTTPS_CERT` | Serve over HTTPS (needed for the camera on phones) |

## Using it on a phone

Browsers only allow the camera on `https://` pages (or `localhost`). Pick one:

1. **Tunnel (easiest):** `npx cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, then open the https URL on the phone.
2. **Local HTTPS:** create a cert with [mkcert](https://github.com/FiloSottile/mkcert) for your laptop's LAN IP, then
   `HTTPS_KEY=certs/key.pem HTTPS_CERT=certs/cert.pem npm start`.
3. **Deploy** to any Node host (Render, Railway, Fly.io, a VPS) — they provide HTTPS. Mount a persistent disk for `data/`.

On the phone, use the browser's *Add to Home screen* to install it like an app. Tap the shop name in the header for Settings. **Set up the owner login before the server is reachable from the internet**; until then anyone who can open it can do anything.

Scanning uses the native `BarcodeDetector` on Android Chrome and falls back to [ZXing](https://github.com/zxing-js/library) (loaded from unpkg) on iPhone Safari and others. Supported: EAN-13/8, UPC-A/E, Code 128/39, ITF, QR. A USB/Bluetooth barcode gun also works — it types into the barcode box.

## Offline mode

- A service worker keeps the app itself (and the iPhone scanning library) cached, so it opens with no signal.
- The product catalog and customer list are saved on the phone (IndexedDB) and refreshed whenever you're online.
- Without internet, **bills, customer returns, stock-ins, supplier purchases and returns, and payments (both directions) go into a queue** on the phone. A chip in the header shows `Offline · N pending`; tap it to see the queue or *Sync now*. The queue is sent in order as soon as the connection returns (and every 30 seconds while anything is pending).
- **No double entries:** every queued action has a unique `client_id`. If a request reached the server but the reply was lost, the retry is recognised and ignored.
- **Bills keep their real time** — offline bills are recorded with the time they were made, not the time they synced.
- **Stock conflicts:** if another device sold the same stock while this one was offline, the offline sale is still accepted (the goods already left the shop). Stock stops at 0 and the shortfall is logged in the product's history as *"please recount"*. Online checkouts still refuse to oversell.
- If the server rejects a queued entry (for example, invalid data), it stays in the queue marked *Rejected* with the reason, so you can retry or discard it. It is never silently dropped.
- Needs internet: editing products, stock corrections, adding a customer or supplier from the Khata tab, opening balances, opening old bills, linking a return (customer or supplier) to a bill, and the profit and supplier reports (the last copy you opened is shown). You can still bill a new customer on udhaar offline, or add a new supplier on the Stock in tab; they are created when the entry syncs.

Using more than one phone? Each phone syncs to the same server, so stock and khata stay shared.

## API

Once logins are set up, every endpoint except `health`, `auth/status`, `auth/login` and `auth/setup` needs a signed-in user. Cashiers get `403` outside their allow-list (`CASHIER_ALLOWED` in `server/app.js`), and cost fields are removed from what they receive. All amounts are integer **paise** (₹1 = 100). Prices are GST-inclusive; bills report the GST contained in the total. Write endpoints accept an optional `client_id`; repeating a request with the same `client_id` returns the original result instead of recording it again.

| Method & path | Body / query | Does |
| --- | --- | --- |
| `POST /api/stock-in` | `{barcode, quantity, name?, price?, cost?, gst_rate?, low_stock?, client_id?}` | Restock a known barcode, or create a new product (name + price required) |
| `GET /api/products` | `?q=` search, `?low=1` | List products |
| `GET /api/products/barcode/:code` | | Look up by barcode |
| `POST /api/products` | product fields | Create product |
| `PATCH /api/products/:id` | any of name, price, cost, gst_rate, low_stock, barcode | Edit product |
| `POST /api/products/:id/stock` | `{change, reason: "stock_in"\|"adjustment", note?}` | Manual stock change |
| `GET /api/products/:id/movements` | | Stock history |
| `POST /api/sales` | `{items:[{product_id \| barcode, quantity}], discount?, payment_method?: cash\|upi\|card\|credit, customer_id? \| customer_name? + customer_phone?, invoice_no?, buyer_gstin?, buyer_address?, place_of_supply?, client_id?, created_at?, offline?}` | Create bill + remove stock (atomic). `credit` puts it on the customer's khata. For a GST-registered shop it's a tax invoice: numbered (the device's `invoice_no`, or the server's own series `0/…`), validated, with CGST/SGST/IGST per line. Offline sales also send each line as printed (`unit_price`, `gst_rate`, `hsn`, `unit`) |
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
| `GET /api/sales/by-number/:number` | | Find a bill by the number on the receipt (invoice number or `#id`) |
| `GET /api/sales`, `GET /api/sales/:id` | `?from=&to=&limit=` | Bills; a single bill includes `returnable` (per line: what can still come back and its `unit_refund`) and earlier `returns` |
| `POST /api/sale-returns` | `{note_no?, sale_id?, items:[{barcode, quantity}], refund_method?: cash\|upi\|card\|khata, restock?, reason?, customer_id? \| customer_name? + customer_phone?, client_id?, created_at?}` | Customer return. With `sale_id`: refund what was paid, capped at what's left on the bill. `khata` takes it off udhaar (customer from the bill, or given). `restock: false` for damaged goods |
| `GET /api/sale-returns`, `GET /api/sale-returns/:id` | `?sale_id=&limit=` | Customer returns |
| `GET /api/auth/status` | | Whether logins are set up, and who the token belongs to |
| `POST /api/auth/setup` | `{name, username, pin}` | First run only: create the owner and sign in |
| `POST /api/auth/login`, `POST /api/auth/logout` | `{username, pin, device_id?}` | → `{token, user}`; send `Authorization: Bearer <token>` afterwards |
| `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id` | `{name, username, role, pin}` / `{name?, role?, pin?, active?}` | Owner only: manage people |
| `GET /api/settings`, `PUT /api/settings` | `{legal_name, trade_name, address, gstin, phone, email, gst_registered, hsn_digits: 4\|6, tz_offset, invoice_terms, cashier_return_limit, cashier_return_daily_limit, cashier_return_days}` | Shop profile printed on invoices. Changes are audit-logged |
| `POST /api/devices`, `GET /api/devices/:id` | `{name?}` | Register a device's own invoice series; get its last used numbers |
| `POST /api/documents/void` | `{number, reason?}` | Report a device-allocated number that will never be issued |
| `GET /api/reports/gstr1` | `?month=2026-10`, `&section=b2b\|b2cl\|b2cs\|cdnr\|cdnur\|hsn_b2b\|hsn_b2c\|docs&format=csv` | GSTR-1 tables for the month (shop's local time) |
| `GET /api/audit-log` | `?entity=&limit=` | Log of edits (Rule 56(8)) |
| `GET /api/backup` | | Download a consistent copy of the database |
| `GET /api/reports/profit` | `?from=&to=` (UTC, default this month), `&tz=330` (minutes from UTC, for local days), `&format=csv` (`&by=day` for daily rows) | Summary (gross sales, returns, net sales, cost of goods, gross profit, margin, GST, products without cost), `by_day`, `by_product` |
| `GET /api/summary` | `?since=YYYY-MM-DD HH:MM:SS` (UTC) | Dashboard numbers |

## Layout

```
server/db.js      schema, migrations (incl. table rebuilds) + data access (SQLite, transactions, stock ledger, customer & supplier khata, purchases)
server/app.js     JSON API + static hosting
server/index.js   entry point (HTTP/HTTPS, daily backups)
server/context.js who is making the current request
public/           mobile web app (no build step)
  gst.js          GST rules shared by server and app: GSTIN check, states, rates, tax split, numbering, FY
  invoice.js      printable tax invoice and credit note
  offline.js      IndexedDB cache, outbox queue and sync
  sw.js           service worker (offline app shell) — bump CACHE when changing app files
test/             API tests (node:test)
```

## Possible next steps

- Multi-user logins and roles (owner vs. cashier), multiple shops
- Encrypted off-site backups
- Purchase-side GST (supplier invoice details for ITC and GSTR-2B matching); GSTR-3B worksheet
- Reorder suggestions from sales speed and low stock; slow-moving / dead stock report
- Full GST invoices (GSTIN, HSN codes, CGST/SGST split), thermal printer support
- Product lookup from a public barcode catalog; SMS reminders for udhaar
- Native app wrapper (Capacitor) if Play Store distribution is needed
