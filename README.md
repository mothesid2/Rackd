# Rackd POS

A full-featured Point of Sale and business-management desktop application for specialty retail shops — vape, smoke, adult, and general retail — built with Electron + TypeScript + SQLite. Branding and the minimum purchase age are configurable per store, so the same build serves any vertical.

---

## Quick Start

### Prerequisites
- Node.js 18+ and npm
- Windows 10/11 (primary target)

### Setup

```bash
cd "SEI VAPES"
npm install
npm run seed        # Creates DB and loads sample data
npm start           # Launches the app
```

### Default Credentials
| Role    | Username  | Password     |
|---------|-----------|--------------|
| Manager | `admin`   | `admin123`   |
| Cashier | `cashier1`| `cashier123` |

> **You will be prompted to change your password on first login.**

---

## Build (Windows Installer)

```bash
npm run build
```

Produces a Windows NSIS installer in `release/`.

---

## Configuration

### Receipt Printer
Navigate to **Settings** in the app, or set `printer_interface` in settings:
- `printer` — uses the Windows default printer
- A specific printer name (e.g. `"EPSON TM-T20III"`)
- A network path (e.g. `\\server\printer`)

If the printer is offline, receipts are automatically saved as `.txt` files in:
`%APPDATA%\sei-vape-pos\receipts\`

### Card Terminal
In **Settings**:
1. Set **Terminal Type**: `Mock` (testing), `PAX`, or `Dejavoo`
2. Set the terminal's **IP Address** and **Port**
   - PAX default port: `10009`
   - Dejavoo default port: `9100`

The **Mock terminal** approves 80% of transactions automatically — perfect for testing.

### Twilio SMS
In **Settings** → Twilio SMS section:
1. Enter your **Twilio Account SID**
2. Enter your **Auth Token**
3. Enter your **From Number** (must be a Twilio number, e.g. `+15550001234`)

If not configured, the SMS blast UI is hidden.

---

## Project Structure

```
src/
  main/
    index.ts              ← Electron main process
    preload.ts            ← Context bridge (IPC bridge to renderer)
    db/
      schema.ts           ← SQLite schema initialization
      seed.ts             ← Sample data seeder
    ipc/                  ← IPC handlers (auth, products, transactions, etc.)
    services/
      cardTerminal.ts     ← PAX / Dejavoo / Mock terminal
      printer.ts          ← Thermal printer (node-thermal-printer)
      twilio.ts           ← Twilio SMS client
    windows/
      main.ts             ← Main BrowserWindow
      customerDisplay.ts  ← Second-monitor customer display
  renderer/
    login/                ← Login screen
    main-menu/            ← Dashboard + Today Overview
    pos/                  ← New Transaction / POS
    receipts/             ← Previous Transactions
    merchandise/          ← Inventory sub-menu + sub-screens
    customer-lookup/      ← Customer CRM + SMS
    xz-out/               ← X/Z Reports
    customer-display/     ← Second screen (dark theme)
    settings/             ← App configuration
assets/
  icon.svg                ← App icon
```

---

## Database

SQLite database is stored at:
`%APPDATA%\sei-vape-pos\seivapes.db`

### Re-seeding
```bash
npm run seed
```

This will **add** the sample data if it doesn't exist (uses `INSERT OR IGNORE`).

---

## Receipt Format

```
My Store
123 Main St | (555) 000-0000
----------------------------------------
Txn #42  4/23/2024  2:34 PM
Cashier: admin
----------------------------------------
Disposable Vape - Mint
  2 x $14.99                      $29.98
----------------------------------------
Subtotal:                          $29.98
Tax (8.25%):                        $2.47
TOTAL:                             $32.45
----------------------------------------
Cash
Tendered: $40.00  Change: $7.55
----------------------------------------
Thank you for your purchase!
Must be 21+ to purchase.        (only if a minimum age is set)
Thank you for shopping My Store!
```

> Store name, address, phone, footer, tax rate, and **minimum purchase age** are all set under **Settings → Receipt Configuration**.

---

## Features

| Feature               | Notes                                              |
|-----------------------|----------------------------------------------------|
| POS / New Sale        | Barcode scanner, product search, cart management   |
| Cash payment          | Change calculator                                  |
| Card payment          | PAX / Dejavoo TCP/IP or Mock terminal              |
| Discounts             | % or $ — >10% requires manager PIN                |
| Customer attachment   | Attach customer to sale                            |
| Inventory             | Stock levels, low stock alerts, CSV import         |
| Receive Invoice       | Update stock from supplier invoices                |
| Receipts              | Full transaction history with reprint              |
| Customer CRM          | Profile, transaction history, SMS opt-in           |
| SMS Blast             | Twilio-powered bulk SMS to opted-in customers      |
| X/Z Reports           | Shift totals, end-of-day close                     |
| Customer Display      | Second-monitor display (dark navy theme)           |
| Settings              | Terminal, printer, Twilio, receipt config          |
