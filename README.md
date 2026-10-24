# Dual Nanogrid Mobile Monitoring System

A mobile-first, dark-themed real-time monitoring web application and telemetry backend for a two-node solar PV + battery nanogrid.

Designed for high reliability behind firewalled institutional networks (e.g. college campuses), where microcontrollers cannot accept inbound connections and must securely push outbound telemetry over HTTPS.

---

## Architecture Overview

```
┌──────────────────┐       ┌──────────────────┐
│   ESP32 Node 1   │       │   ESP32 Node 2   │
│ (Solar + Battery)│       │ (Solar + Battery)│
└────────┬─────────┘       └────────┬─────────┘
         │ (HTTPS POST every 3s)    │ (HTTPS POST every 3s)
         │ Header: X-Device-Key     │ Header: X-Device-Key
         └─────────────┬────────────┘
                       ▼
        ┌───────────────────────────────┐
        │     Supabase Edge Function    │
        │    POST /functions/v1/ingest  │
        │   - Timing-safe Auth Check    │
        │   - 16-field Strict Validation│
        │   - 1 req/s Rate Limiter      │
        └──────────────┬────────────────┘
                       ▼
          ┌─────────────────────────┐
          │  PostgreSQL (Supabase)  │
          │  - public.node_latest   │
          │  - public.node_history  │
          └────────────┬────────────┘
                       ▼
        ┌───────────────────────────────┐
        │      Vercel Static Host       │
        │   Public Read-Only Website    │
        │   - OLED Dark Theme (#0B0F14) │
        │   - Live SVG Energy Flow      │
        │   - 15m / 1h / 24h Charts     │
        │   - PWA Fullscreen on Phones  │
        └───────────────────────────────┘
```

- **ESP32 Outbound Push:** Node 1 and Node 2 post telemetry packets every 3 seconds to the Supabase Edge Function (`/functions/v1/ingest`).
- **Database Storage:**
  - `public.node_latest`: Current operational snapshot (upsert on `node` key).
  - `public.node_history`: Historical downsampled time series (1 row per node every >= 30 seconds, 24-hour retention window).
- **Client Frontend:** Deployed to Vercel as a lightweight static web app. Reads data via Supabase REST API or Edge Function read endpoint. Operates from anywhere over mobile data (cellular 4G/5G).

---

## Security Architecture & Checklist

- [x] **No Secrets in Frontend:** The client website requires zero private keys. The browser only receives `VITE_SUPABASE_URL` and the read-only `VITE_SUPABASE_ANON_KEY`.
- [x] **`DEVICE_KEY` Isolation:** The secret authentication token lives in only two secure locations:
  1. Supabase Edge Function Secrets (`supabase secrets set DEVICE_KEY=...`)
  2. Local untracked firmware header on the microcontroller (`esp32/telemetry.h`)
- [x] **Git Ignored:** `.env`, `.env.*`, and `esp32/telemetry.h` are explicitly ignored in `.gitignore`.
- [x] **PostgreSQL Row Level Security (RLS):** Read-only access (`SELECT`) is granted to the public anonymous role. Direct writes (`INSERT`/`UPDATE`/`DELETE`) from the web are blocked by database policies.
- [x] **Read-Only Physical Hardware:** There are no endpoints or relay controls exposed through the website.

---

## Repository Structure

```
PV_research/
├── DEPLOYMENT.md              # Complete zero-to-hero step-by-step deployment guide
├── README.md                  # System overview and quick reference
├── .env.example               # Example public frontend environment variables
├── .gitignore                 # Excludes secrets, node_modules, and firmware credentials
├── package.json               # Vite project configuration and scripts
├── vite.config.js             # Vite config with local backend proxy
├── vercel.json                # Vercel static routing and security headers
├── index.html                 # Mobile-first PWA HTML entry point
├── public/
│   ├── favicon.svg            # Custom SVG nanogrid icon
│   └── manifest.webmanifest   # Web App Manifest for mobile installation
├── src/
│   ├── main.js                # Application controller, polling, and charts
│   └── styles.css             # OLED dark theme, responsive grid, animations
├── supabase/
│   ├── config.toml            # Edge Function configuration (verify_jwt = false)
│   ├── migrations/
│   │   └── 20261024000000_nanogrid_telemetry.sql # Tables, RLS, & Realtime
│   └── functions/
│       └── ingest/
│           └── index.ts       # Secure Edge Function ingest & read endpoint
├── esp32/
│   └── telemetry.h.example    # Non-blocking Arduino telemetry client library
└── scripts/
    ├── mock-backend.mjs       # Zero-dependency local mock server on :8787
    ├── test-ingest.ps1        # PowerShell automated verification test script
    └── test-ingest.sh         # Bash / curl automated verification test script
```

---

## Quick Start (Local Development)

You can run and test the complete system locally without any cloud accounts:

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Local Mock Backend
In your first terminal:
```bash
npm run mock
# Listens on http://localhost:8787/ingest with DEVICE_KEY="test-device-key-change-me"
```

### 3. Start the Frontend Development Server
In your second terminal:
```bash
npm run dev
# Vite runs on http://localhost:5173 with automatic proxying to :8787
```

### 4. Run Automated Test Verification
In a third terminal:
- **Windows (PowerShell):**
  ```powershell
  .\scripts\test-ingest.ps1
  ```
- **macOS / Linux / Git Bash:**
  ```bash
  ./scripts/test-ingest.sh
  ```

---

## Cloud Deployment Guide (Supabase + Vercel)

For complete, beginner-friendly instructions with screenshots, refer to [DEPLOYMENT.md](file:///c:/Users/Ranja/Desktop/PV_research/DEPLOYMENT.md).

### Summary of Deployment Steps:

1. **Supabase Project:**
   - Create a project at [supabase.com](https://supabase.com).
   - In SQL Editor, run `supabase/migrations/20261024000000_nanogrid_telemetry.sql`.
   - Set secret: `npx supabase secrets set DEVICE_KEY="your-secret-key"`.
   - Deploy function: `npx supabase functions deploy ingest --no-verify-jwt`.
   - Copy `INGEST_URL`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY`.

2. **Verify with `curl`:**
   ```bash
   curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/ingest" \
     -H "Content-Type: application/json" \
     -H "X-Device-Key: your-secret-key" \
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
   *Expected response:* `{"ok":true,"node":2,...}` with HTTP 200.

3. **Vercel Website:**
   - Push repository to GitHub.
   - Import into [vercel.com](https://vercel.com).
   - Set environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
   - Deploy and open URL on phone over mobile data.

4. **Flash ESP32 Microcontrollers:**
   - Copy `esp32/telemetry.h.example` to `esp32/telemetry.h`.
   - Set `INGEST_URL` and `DEVICE_KEY`.
   - Add the 4 integration lines into your Arduino sketch (`#include "telemetry.h"`, `readCurrentState()`, `data.uptime_s = millis()/1000UL`, `sendTelemetry(data)`).

---

## Telemetry Payload Specification

The ingest endpoint requires exactly 16 fields in each JSON packet:

| Field | Type | Description / Range |
|---|---|---|
| `node` | `integer` | Node identifier (`1` or `2`) |
| `uptime_s` | `integer` | Microcontroller uptime in seconds (`>= 0`) |
| `src` | `string` | Local power source: `"NONE"`, `"PV"`, or `"BATTERY"` |
| `tie` | `string` | Inter-tie bus status: `"NONE"`, `"EXPORT"`, or `"IMPORT"` |
| `soc` | `number` | Estimated Battery State of Charge (`0.0` to `100.0%`) |
| `vbat` | `number` | Battery terminal voltage (V) |
| `ibat` | `number` | Battery net current (A). Positive = charging, negative = discharging |
| `vpv` | `number` | Regulated Solar PV rail voltage (V, ~12.4V when active) |
| `ipv` | `number` | Solar PV rail current (A) |
| `vbus` | `number` | Inter-tie DC bus voltage (V) |
| `ibus` | `number` | Inter-tie DC bus current (A). Negative = exporting, positive = importing |
| `pv_ok` | `boolean` | Solar PV rail health status |
| `lockout` | `boolean` | Active safety lockout trip (true when all relays open) |
| `import_bus_ok` | `boolean` | Inter-tie bus health status |
| `rssi` | `integer` | WiFi signal strength in dBm (`-150` to `0`) |
| `fw` | `string` | Firmware version identifier string (e.g. `"telemetry-1"`) |

---

## Telemetry Number Interpretations

- **Battery Current (`ibat`):**
  - Positive (> 0): Battery is **Charging** (green glow).
  - Negative (< 0): Battery is **Discharging** (soft cyan/teal glow).
  - Near zero (|ibat| <= 0.02 A): **Idle**.
- **Shared Bus Current (`ibus`):**
  - Negative (< -0.02 A): Node is **Exporting** power to the shared DC bus (blue flow).
  - Positive (> 0.02 A): Node is **Importing** power from the shared DC bus (violet flow).
- **Warnings & Lockouts:**
  - Amber warning banner: Battery voltage `< 11.0V` or `> 14.6V`, or any sensor current `> 0.6A`.
  - Red lockout banner: `lockout: true` (system safety trip active).
  - Freshness chips: `Updated 2s ago` (healthy), `Delayed` (> 10s), `Offline` (> 30s).

---

## Verification & Acceptance Testing

Run the automated test suite to verify backend compliance:

```powershell
# Windows PowerShell
.\scripts\test-ingest.ps1
```

```bash
# Linux / macOS / Git Bash
./scripts/test-ingest.sh
```

All 5 core acceptance criteria are validated:
1. Valid Node 2 POST returns HTTP 200 OK.
2. Valid Node 1 POST returns HTTP 200 OK.
3. Invalid `X-Device-Key` returns HTTP 401 Unauthorized.
4. Schema violation or malformed body returns HTTP 400 Bad Request.
5. Rapid duplicate requests (< 1000ms per node) return HTTP 429 Too Many Requests.
