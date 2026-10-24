# Dual Nanogrid Mobile Monitoring System — Zero-to-Hero Deployment Guide

> **For Beginners:** If you have never deployed an app, database, or cloud server before, this guide is written step-by-step for you. Follow each numbered step in order and you will have your live nanogrid monitoring dashboard running on phones anywhere in the world!

---

## Table of Contents

1. [Architecture Overview & Data Flow](#1-architecture-overview--data-flow)
2. [Security Architecture & Secret Checklist](#2-security-architecture--secret-checklist)
3. [Step-by-Step Supabase Setup](#3-step-by-step-supabase-setup)
   - [3.1 Create Supabase Project](#31-create-a-free-supabase-project)
   - [3.2 Run Database Migrations](#32-run-the-database-migration)
   - [3.3 Set the Device Key Secret](#33-set-the-secret-device-key)
   - [3.4 Deploy the Edge Function](#34-deploy-the-ingest-edge-function)
   - [3.5 Copy Your Credentials & Ingest URL](#35-copy-your-project-credentials)
4. [Testing the Ingest Endpoint with `curl` & Scripts](#4-testing-the-ingest-endpoint)
   - [4.1 Running Automated Test Scripts](#41-automated-verification-test-scripts)
   - [4.2 Manual `curl` Tests (PowerShell & Bash)](#42-manual-curl-commands)
   - [4.3 Verifying Live Rows in Supabase Dashboard](#43-verifying-data-in-supabase-table-editor)
5. [Step-by-Step Vercel Website Deployment](#5-step-by-step-vercel-website-deployment)
   - [5.1 Deploy via GitHub (Recommended)](#51-deploy-via-github-web-ui)
   - [5.2 Deploy via Vercel CLI](#52-deploy-via-vercel-cli)
   - [5.3 Mobile Verification (Cellular Data)](#53-verifying-on-mobile-data)
6. [Flashing the ESP32 Hardware Nodes](#6-flashing-the-esp32-hardware-nodes)
   - [6.1 Firmware Header Configuration](#61-configure-esp32telemetryh)
   - [6.2 The 4-Line Arduino Sketch Integration](#62-the-4-lines-to-add-to-your-arduino-sketch)
   - [6.3 Verifying Over Serial Monitor](#63-serial-monitor-verification)
7. [System Acceptance Checklist](#7-system-acceptance-checklist)
8. [Troubleshooting & FAQ](#8-troubleshooting--faq)

---

## 1. Architecture Overview & Data Flow

Your nanogrid consists of two hardware nodes (**Node 1** and **Node 2**), each powered by solar panels and a battery bank, connected by an inter-tie direct current (DC) shared bus.

```
┌─────────────────┐       ┌─────────────────┐
│  ESP32 Node 1   │       │  ESP32 Node 2   │
│  (Solar+Battery)│       │  (Solar+Battery)│
└────────┬────────┘       └────────┬────────┘
         │ (HTTPS POST every 3s)   │ (HTTPS POST every 3s)
         │ Header: X-Device-Key    │ Header: X-Device-Key
         └────────────┬────────────┘
                      ▼
       ┌───────────────────────────────┐
       │     Supabase Edge Function    │
       │    POST /functions/v1/ingest  │
       │   - Constant-time Auth Check  │
       │   - Strict 16-Field Validate  │
       │   - 1 req/s Rate Limiter      │
       └──────────────┬────────────────┘
                      ▼
         ┌─────────────────────────┐
         │ PostgreSQL Database     │
         │ - node_latest (Upsert)  │
         │ - node_history (>=30s)  │
         └────────────┬────────────┘
                      ▼
       ┌───────────────────────────────┐
       │     Vercel Static Website     │
       │   Public Read-Only Dashboard  │
       │   - Dark Theme OLED (#0B0F14) │
       │   - Live SVG Energy Flow      │
       │   - 15m / 1h / 24h Charts     │
       │   - Accessible Worldwide      │
       └───────────────────────────────┘
```

### Why Outbound Push?
Colleges and campuses use strict firewalls that block all incoming internet connections. If your ESP32 tried to host a web server, nobody outside the college WiFi could ever connect to it. 

Instead, the ESP32 **pushes data out** to Supabase via standard HTTPS on port 443 (just like opening a webpage). The public Vercel website reads data directly from Supabase. No inbound ports or network configurations are ever required!

---

## 2. Security Architecture & Secret Checklist

| Item | Where it lives | Exposed to Browser? | Committed to Git? |
|---|---|:---:|:---:|
| `DEVICE_KEY` | Supabase Secrets & ESP32 (`esp32/telemetry.h`) | **NO** | **NO** (Blocked by `.gitignore`) |
| `VITE_SUPABASE_URL` | Vercel Environment Variables & `.env` | Yes (Public URL) | No |
| `VITE_SUPABASE_ANON_KEY` | Vercel Environment Variables & `.env` | Yes (Public Read-Only) | No |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Internal Edge Runtime | **NO** | No |

### The Golden Security Rules
1. **Never write `DEVICE_KEY` into `.env` or any frontend file.** All `VITE_*` variables in Vite projects are baked into public JavaScript files that anyone can read by inspecting the website.
2. **`DEVICE_KEY` only lives in two places:**
   - In Supabase Edge Function Secrets: `npx supabase secrets set DEVICE_KEY="..."`
   - In your local, untracked `esp32/telemetry.h` file on your computer.
3. **Database Row Level Security (RLS) protects your data:**
   - The database rules allow the public anonymous key to **read only** (`SELECT`).
   - Direct insertions, updates, or deletions from the browser or unauthorized users are blocked by PostgreSQL. Only the server-side Edge Function can write to the tables.
4. **No Relay Control:** The website has zero write permissions or endpoints for controlling physical hardware relays. This is strictly a passive, read-only monitoring interface.

---

## 3. Step-by-Step Supabase Setup

### 3.1 Create a Free Supabase Project
1. Open [https://supabase.com](https://supabase.com) and click **Start your project** (sign in with GitHub).
2. Click **New Project**.
3. Fill in the project details:
   - **Name:** `nanogrid-telemetry`
   - **Database Password:** Enter a strong password (save this in your password manager).
   - **Region:** Choose the region closest to you (e.g., `us-east-1` or `ap-south-1`).
   - **Pricing Plan:** Free ($0/month).
4. Click **Create new project** and wait ~2 minutes for provisioning.

---

### 3.2 Run the Database Migration

You can run the migration using either the **Supabase Web Dashboard (Easiest)** or the **Supabase CLI**.

#### Option A: Supabase Web Dashboard (Recommended for beginners)
1. In your Supabase project dashboard, click **SQL Editor** in the left sidebar (the `>_` icon).
2. Click **New Query**.
3. Open the file `supabase/migrations/20261024000000_nanogrid_telemetry.sql` in VS Code or Notepad.
4. Copy the entire contents and paste them into the SQL Editor window.
5. Click **Run** (green button on the bottom right).
6. You will see `Success. No rows returned`.

#### Option B: Supabase CLI
If you have the Supabase CLI installed:
```powershell
# Link your local project to your Supabase project (find reference ID in Project Settings)
npx supabase link --project-ref <PROJECT_REF>

# Push the migration
npx supabase db push
```

---

### 3.3 Set the Secret Device Key

Pick a long, random secret key (e.g. `grid_sec_9f7a8b23c4d5e6f1a8b0c2d3`).

Run this command in PowerShell or your terminal:
```bash
npx supabase secrets set DEVICE_KEY="your-long-random-secret"
```

> **Note:** If prompted to log in to Supabase CLI, run `npx supabase login` and paste your Supabase Personal Access Token generated from [https://supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).

Alternatively, you can set it via the Web Dashboard:
1. Go to **Project Settings** -> **Edge Functions**.
2. Scroll to **Secrets**.
3. Click **Add new secret**.
4. Name: `DEVICE_KEY`
5. Value: `your-long-random-secret`
6. Click **Save**.

---

### 3.4 Deploy the Ingest Edge Function

Deploy the ingest Edge Function with the `--no-verify-jwt` flag so the ESP32 can authenticate using the custom `X-Device-Key` header:

```bash
npx supabase functions deploy ingest --no-verify-jwt
```

> **Why `--no-verify-jwt`?** Supabase Edge Functions verify Supabase User Auth JWTs by default. Since hardware microcontrollers authenticate directly via `X-Device-Key`, disabling JWT verification allows the function code to inspect and validate the device key directly.

---

### 3.5 Copy Your Project Credentials

Go to **Project Settings** -> **API** in the Supabase Dashboard:

1. **`INGEST_URL`**:
   `https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/ingest`
   *(Replace `<YOUR_PROJECT_REF>` with your 20-character project reference, e.g. `abcdefghijklmnopqrs`)*
2. **`SUPABASE_URL`**:
   `https://<YOUR_PROJECT_REF>.supabase.co`
3. **`SUPABASE_ANON_KEY`**:
   The long string under **Project API keys** labeled `anon` / `public`.

---

## 4. Testing the Ingest Endpoint

Before connecting any hardware, test the ingest endpoint to verify that authorization, data ingestion, rate-limiting, and validation are working.

### 4.1 Automated Verification Test Scripts

The repository includes automated test suites for both Windows PowerShell and Bash/Linux.

#### On Windows (PowerShell):
```powershell
# Set your target URL and secret key:
$env:INGEST_URL = "https://<PROJECT_REF>.supabase.co/functions/v1/ingest"
$env:DEVICE_KEY = "your-long-random-secret"

# Run the test suite:
powershell -ExecutionPolicy Bypass -File .\scripts\test-ingest.ps1
```

#### On Linux / macOS / Git Bash:
```bash
export INGEST_URL="https://<PROJECT_REF>.supabase.co/functions/v1/ingest"
export DEVICE_KEY="your-long-random-secret"

chmod +x ./scripts/test-ingest.sh
./scripts/test-ingest.sh
```

**Expected Output:**
```
======================================================================
  Dual Nanogrid Telemetry Ingest Verification Test Suite
======================================================================
[Test 1] Valid Ingest POST for Node 2... [PASS]
[Test 2] Valid Ingest POST for Node 1... [PASS]
[Test 3] Reject wrong X-Device-Key with 401... [PASS]
[Test 4] Reject malformed body with 400... [PASS]
[Test 5] Rapid duplicate POST (< 1000ms) for Node 2 rate limit... [PASS]

Test Results: 5 Passed, 0 Failed (Total 5)
```

---

### 4.2 Manual `curl` Commands

#### Test 1: Valid Ingest POST for Node 2
##### Windows PowerShell:
```powershell
curl.exe -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/ingest" `
  -H "Content-Type: application/json" `
  -H "X-Device-Key: your-long-random-secret" `
  -d '{
    "node": 2,
    "uptime_s": 1234,
    "src": "BATTERY",
    "tie": "EXPORT",
    "soc": 98.0,
    "vbat": 13.12,
    "ibat": -0.123,
    "vpv": 12.40,
    "ipv": 0.105,
    "vbus": 15.01,
    "ibus": -0.210,
    "pv_ok": true,
    "lockout": false,
    "import_bus_ok": false,
    "rssi": -61,
    "fw": "telemetry-1"
  }'
```

##### Linux / macOS / Git Bash:
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: your-long-random-secret" \
  -d '{
    "node": 2,
    "uptime_s": 1234,
    "src": "BATTERY",
    "tie": "EXPORT",
    "soc": 98.0,
    "vbat": 13.12,
    "ibat": -0.123,
    "vpv": 12.40,
    "ipv": 0.105,
    "vbus": 15.01,
    "ibus": -0.210,
    "pv_ok": true,
    "lockout": false,
    "import_bus_ok": false,
    "rssi": -61,
    "fw": "telemetry-1"
  }'
```

**Expected Response (`HTTP 200 OK`):**
```json
{
  "ok": true,
  "node": 2,
  "received_at": "2026-10-24T13:42:00.000Z",
  "history_sampled": true
}
```

---

#### Test 2: Testing Wrong `X-Device-Key` (HTTP 401 Unauthorized)
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: WRONG-PASSWORD" \
  -d '{"node": 2, "uptime_s": 100}'
```

**Expected Response (`HTTP 401 Unauthorized`):**
```json
{
  "error": "Unauthorized: invalid or missing X-Device-Key"
}
```

---

#### Test 3: Testing Malformed Body (HTTP 400 Bad Request)
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: your-long-random-secret" \
  -d '{"node": 99, "uptime_s": -1}'
```

**Expected Response (`HTTP 400 Bad Request`):**
```json
{
  "error": "Field 'node' must be integer 1 or 2",
  "field": "node"
}
```

---

### 4.3 Verifying Data in Supabase Table Editor
1. In your Supabase Dashboard, click **Table Editor** on the left menu.
2. Select table `node_latest`: you should see a row for `node = 2` with `soc = 98.0`, `vbat = 13.12`, etc.
3. Select table `node_history`: you should see a row timestamped with the time you ran `curl`.

---

## 5. Step-by-Step Vercel Website Deployment

### 5.1 Deploy via GitHub Web UI (Recommended)

1. **Commit and push your project to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit for Nanogrid Monitor"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo-name>.git
   git push -u origin main
   ```
   > Double-check that `.env` and `esp32/telemetry.h` are NOT listed in `git status`.

2. **Open Vercel:**
   - Go to [https://vercel.com](https://vercel.com) and log in with GitHub.
   - Click **Add New...** -> **Project**.
   - Select your nanogrid repository and click **Import**.

3. **Configure Project & Environment Variables:**
   - **Framework Preset:** Vite
   - **Root Directory:** `./`
   - Expand **Environment Variables** and add the following two variables:
     | Key | Value | Description |
     |---|---|---|
     | `VITE_SUPABASE_URL` | `https://<PROJECT_REF>.supabase.co` | Your Supabase project URL |
     | `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOi...` | Your Supabase `anon` public key |
     | `VITE_VIEW_PASSCODE` | *(Optional)* e.g. `nanogrid2026` | Viewer gate passcode (optional) |

4. **Click Deploy:**
   - Vercel will install dependencies, build the static assets, and give you a public URL:
     `https://<your-project-name>.vercel.app`

---

### 5.2 Deploy via Vercel CLI
If you prefer deploying directly from your computer terminal:
```bash
# 1. Install or run Vercel CLI
npx vercel

# 2. Follow prompts:
# ? Set up and deploy? [Y/n] y
# ? Which scope? Select your personal account
# ? Link to existing project? [y/N] n
# ? What's your project's name? nanogrid-monitor
# ? In which directory is your code located? ./

# 3. Add environment variables
npx vercel env add VITE_SUPABASE_URL production
npx vercel env add VITE_SUPABASE_ANON_KEY production

# 4. Deploy to production
npx vercel --prod
```

---

### 5.3 Verifying on Mobile Data

1. Grab your phone.
2. **Turn off WiFi** and enable **Mobile Cellular Data (4G/5G)**.
3. Open mobile Safari or Chrome and navigate to `https://<your-project-name>.vercel.app`.
4. Observe the live dashboard:
   - Deep OLED dark background (`#0B0F14`) matches the browser chrome bar.
   - Node 2 displays the values you sent via `curl`.
   - Send another `curl` packet for Node 2 from your computer: within 2–3 seconds, the phone screen updates automatically!

#### Add to Phone Home Screen (PWA):
- **iOS Safari:** Tap the **Share** button (box with upward arrow) -> tap **Add to Home Screen**.
- **Android Chrome:** Tap the **three dots** menu -> tap **Add to Home screen** (or **Install app**).
- Open the app icon from your phone's home screen: it launches full-screen without URL bars, looking like a native mobile application!

---

## 6. Flashing the ESP32 Hardware Nodes

### 6.1 Configure `esp32/telemetry.h`

1. Inside your project folder, make a copy of the template:
   ```bash
   cp esp32/telemetry.h.example esp32/telemetry.h
   ```
2. Open `esp32/telemetry.h` in your editor and paste your credentials:
   ```cpp
   // Set your exact Supabase Ingest URL:
   static const char* INGEST_URL = "https://<PROJECT_REF>.supabase.co/functions/v1/ingest";

   // Set your secret Device Key (must match Supabase secret):
   static const char* DEVICE_KEY = "your-long-random-secret";
   ```

---

### 6.2 The 4 Lines to Add to Your Arduino Sketch

Open your existing Arduino nanogrid sketch. **Do not modify your relay control or safety logic!** Only add these 4 lines:

```cpp
// =============================================================================
// LINE 1: Include the telemetry library header at the top of your sketch
// =============================================================================
#include "telemetry.h"

void setup() {
    Serial.begin(115200);
    // ... your existing ADC, GPIO, and relay setup ...
    // ... ensure WiFi.begin(ssid, password) connects to your WiFi ...
}

void loop() {
    // ... YOUR EXISTING RELAY CONTROL & SAFETY LOGIC RUNS UNTOUCHED ...

    // =========================================================================
    // LINE 2: Read current sensor state into the NanogridTelemetry structure
    // =========================================================================
    NanogridTelemetry data = readCurrentState(); // replace with your state variable

    // =========================================================================
    // LINE 3: Stamp uptime in seconds
    // =========================================================================
    data.uptime_s = millis() / 1000UL;

    // =========================================================================
    // LINE 4: Transmit telemetry (automatically paced at 3-second intervals)
    // =========================================================================
    sendTelemetry(data);
}
```

#### Node 1 vs. Node 2 Setting:
In each sketch, make sure `data.node` is set to `1` on the Node 1 board, and `2` on the Node 2 board:
```cpp
data.node = 1; // On ESP32 #1
data.node = 2; // On ESP32 #2
```

---

### 6.3 Serial Monitor Verification

Open Arduino IDE Serial Monitor at **115200 baud**. Every 3 seconds you will see:
```text
[Telemetry] Posting Node 2 telemetry to https://...
[Telemetry] Success HTTP 200: {"ok":true,"node":2,"received_at":"...","history_sampled":true}
```

If WiFi drops, the telemetry engine non-blockingly waits and retries once connection is restored, never interrupting your power or relay controls.

---

## 7. System Acceptance Checklist

| # | Acceptance Requirement | Test Procedure | Pass Criteria |
|---|---|---|:---:|
| 1 | **Live Data Update** | Post sample JSON for Node 2 using `curl` | Node 2 card updates on screen within 3 seconds |
| 2 | **Delayed State** | Stop posting data for 10 seconds | Card displays amber "Delayed" chip (10s threshold) |
| 3 | **Offline State** | Stop posting data for 30 seconds | Card displays "Offline — no data from this node" |
| 4 | **Auth Rejection** | Send POST with wrong `X-Device-Key` | Ingest function rejects with HTTP `401 Unauthorized` |
| 5 | **Malformed Body** | Send POST with invalid types or missing fields | Ingest function rejects with HTTP `400 Bad Request` |
| 6 | **Rate Limiting** | Send two requests within 1 second for same node | Ingest function rejects 2nd request with HTTP `429` |
| 7 | **Mobile Usability** | Open Vercel URL on mobile phone over 4G/5G data | Page loads fast, zero horizontal scroll, responsive |
| 8 | **Responsive Design** | Inspect at 360px, 390px, 768px, and 1280px wide | Stacked cards on mobile, side-by-side on desktop |
| 9 | **Dark Theme Polish** | Inspect theme across all views | Consistent `#0B0F14` dark theme; no white flashes |

---

## 8. Troubleshooting & FAQ

### Q: Why do I get `401 Unauthorized` when testing `curl`?
- Check that the header `-H "X-Device-Key: ..."` exactly matches the secret set in Supabase (`npx supabase secrets set DEVICE_KEY=...`).
- Ensure there are no accidental spaces around the key.

### Q: Why do I get `400 Bad Request`?
- The backend enforces strict type checking on all 16 JSON fields:
  - `node`: must be integer `1` or `2`.
  - `src`: must be one of `"NONE"`, `"PV"`, or `"BATTERY"`.
  - `tie`: must be one of `"NONE"`, `"EXPORT"`, or `"IMPORT"`.
  - `soc`: must be a number between `0.0` and `100.0`.
  - `vbat`, `ibat`, `vpv`, `ipv`, `vbus`, `ibus`: must be finite numbers.
  - `pv_ok`, `lockout`, `import_bus_ok`: must be booleans (`true` or `false`).
  - `rssi`: must be integer between `-150` and `0`.
  - `fw`: non-empty string up to 64 chars.

### Q: Why do I get `429 Too Many Requests`?
- Rate limiting is active! The backend rejects more than 1 request per second per node. The ESP32 is programmed to transmit every 3 seconds (`TELEMETRY_INTERVAL_MS = 3000UL`), which is well within limits.

### Q: Can I run everything locally without deploying to Supabase or Vercel?
- **Yes!** Run `node scripts/mock-backend.mjs` in one terminal, and `npm run dev` in another. The Vite dev server will proxy `/ingest` requests to your local mock backend.
- You can test `curl` against `http://localhost:8787/ingest` with `X-Device-Key: test-device-key-change-me`.
