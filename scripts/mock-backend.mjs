#!/usr/bin/env node
/**
 * =============================================================================
 * Nanogrid Local Telemetry Mock Backend
 * Zero-dependency Node.js HTTP Server for local simulation & testing
 * =============================================================================
 *
 * Implements identical endpoints and validation to Supabase Edge Function:
 *   - POST /ingest (ESP32 telemetry ingestion with X-Device-Key authentication)
 *   - GET  /ingest (Dashboard telemetry read endpoint: ?range=15m|1h|24h)
 *   - OPTIONS /ingest (CORS preflight handling)
 *
 * Usage:
 *   node scripts/mock-backend.mjs
 *   DEVICE_KEY=my-custom-key PORT=8787 node scripts/mock-backend.mjs
 */

import http from "node:http";
import crypto from "node:crypto";

const PORT = parseInt(process.env.PORT || "8787", 10);
const DEVICE_KEY = process.env.DEVICE_KEY || "test-device-key-change-me";

// In-memory data store
const nodeLatest = new Map(); // Map<nodeId, TelemetryRecord>
let nodeHistory = [];         // Array<TelemetryRecord>
const lastPostByNode = new Map();     // Map<nodeId, timestampMs> (1s rate limit)
const lastHistoryByNode = new Map();  // Map<nodeId, timestampMs> (30s downsample)

// Timing-safe string comparison
function constantTimeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    ...corsHeaders,
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(data));
}

// 16-field payload validation with friendly normalization for dev testing
function validatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, error: "Payload must be a JSON object", field: "root" };
  }

  // Normalization for flexible field names
  if (body.node_id !== undefined && body.node === undefined) {
    body.node = parseInt(body.node_id, 10);
  }
  if (body.source !== undefined && body.src === undefined) {
    body.src = String(body.source).toUpperCase();
  }
  if (body.tie_status !== undefined && body.tie === undefined) {
    body.tie = String(body.tie_status).toUpperCase();
  }
  if (body.uptime_s === undefined) {
    body.uptime_s = 0;
  }
  if (body.import_bus_ok === undefined) {
    body.import_bus_ok = true;
  }
  if (body.rssi === undefined) {
    body.rssi = -60;
  }
  if (body.fw === undefined) {
    body.fw = "v1.0.0";
  }

  // 1. node (1 or 2)
  if (typeof body.node !== "number" || !Number.isInteger(body.node) || (body.node !== 1 && body.node !== 2)) {
    return { valid: false, error: "Field 'node' must be integer 1 or 2", field: "node" };
  }

  // 2. uptime_s (>= 0)
  if (typeof body.uptime_s !== "number" || !Number.isInteger(body.uptime_s) || body.uptime_s < 0) {
    return { valid: false, error: "Field 'uptime_s' must be an integer >= 0", field: "uptime_s" };
  }

  // 3. src ('NONE' | 'PV' | 'BATTERY')
  if (typeof body.src !== "string" || !["NONE", "PV", "BATTERY"].includes(body.src)) {
    return { valid: false, error: "Field 'src' must be 'NONE', 'PV', or 'BATTERY'", field: "src" };
  }

  // 4. tie ('NONE' | 'EXPORT' | 'IMPORT')
  if (typeof body.tie !== "string" || !["NONE", "EXPORT", "IMPORT"].includes(body.tie)) {
    return { valid: false, error: "Field 'tie' must be 'NONE', 'EXPORT', or 'IMPORT'", field: "tie" };
  }

  // 5. soc (0 - 100)
  if (typeof body.soc !== "number" || !Number.isFinite(body.soc) || body.soc < 0 || body.soc > 100) {
    return { valid: false, error: "Field 'soc' must be a number between 0 and 100", field: "soc" };
  }

  const isBoundedNumber = (val) => typeof val === "number" && Number.isFinite(val) && val >= -100 && val <= 100;

  // 6. vbat
  if (!isBoundedNumber(body.vbat)) {
    return { valid: false, error: "Field 'vbat' must be a finite number between -100 and 100", field: "vbat" };
  }

  // 7. ibat
  if (!isBoundedNumber(body.ibat)) {
    return { valid: false, error: "Field 'ibat' must be a finite number between -100 and 100", field: "ibat" };
  }

  // 8. vpv
  if (!isBoundedNumber(body.vpv)) {
    return { valid: false, error: "Field 'vpv' must be a finite number between -100 and 100", field: "vpv" };
  }

  // 9. ipv
  if (!isBoundedNumber(body.ipv)) {
    return { valid: false, error: "Field 'ipv' must be a finite number between -100 and 100", field: "ipv" };
  }

  // 10. vbus
  if (!isBoundedNumber(body.vbus)) {
    return { valid: false, error: "Field 'vbus' must be a finite number between -100 and 100", field: "vbus" };
  }

  // 11. ibus
  if (!isBoundedNumber(body.ibus)) {
    return { valid: false, error: "Field 'ibus' must be a finite number between -100 and 100", field: "ibus" };
  }

  // 12. pv_ok
  if (typeof body.pv_ok !== "boolean") {
    return { valid: false, error: "Field 'pv_ok' must be a boolean", field: "pv_ok" };
  }

  // 13. lockout
  if (typeof body.lockout !== "boolean") {
    return { valid: false, error: "Field 'lockout' must be a boolean", field: "lockout" };
  }

  // 14. import_bus_ok
  if (typeof body.import_bus_ok !== "boolean") {
    return { valid: false, error: "Field 'import_bus_ok' must be a boolean", field: "import_bus_ok" };
  }

  // 15. rssi (-150 to 0)
  if (typeof body.rssi !== "number" || !Number.isInteger(body.rssi) || body.rssi < -150 || body.rssi > 0) {
    return { valid: false, error: "Field 'rssi' must be an integer between -150 and 0", field: "rssi" };
  }

  // 16. fw (non-empty string <= 64 chars)
  if (typeof body.fw !== "string" || body.fw.trim().length === 0 || body.fw.length > 64) {
    return { valid: false, error: "Field 'fw' must be a non-empty string <= 64 chars", field: "fw" };
  }

  return {
    valid: true,
    data: {
      node: body.node,
      uptime_s: body.uptime_s,
      src: body.src,
      tie: body.tie,
      soc: Number(body.soc.toFixed(2)),
      vbat: Number(body.vbat.toFixed(3)),
      ibat: Number(body.ibat.toFixed(3)),
      vpv: Number(body.vpv.toFixed(3)),
      ipv: Number(body.ipv.toFixed(3)),
      vbus: Number(body.vbus.toFixed(3)),
      ibus: Number(body.ibus.toFixed(3)),
      pv_ok: body.pv_ok,
      lockout: body.lockout,
      import_bus_ok: body.import_bus_ok,
      rssi: body.rssi,
      fw: body.fw.trim(),
    },
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Match /ingest or /functions/v1/ingest
  const isIngestPath = pathname === "/ingest" || pathname === "/functions/v1/ingest";

  if (!isIngestPath) {
    return sendJson(res, 404, { error: `Not found: ${pathname}` });
  }

  // ---------------------------------------------------------------------------
  // GET /ingest (Dashboard telemetry read endpoint)
  // ---------------------------------------------------------------------------
  if (req.method === "GET") {
    const rangeParam = url.searchParams.get("range") || "24h";
    let rangeMs = 24 * 60 * 60 * 1000;
    if (rangeParam === "15m") rangeMs = 15 * 60 * 1000;
    else if (rangeParam === "1h") rangeMs = 60 * 60 * 1000;
    else if (rangeParam === "24h") rangeMs = 24 * 60 * 60 * 1000;

    const cutoffMs = Date.now() - rangeMs;
    const latestList = Array.from(nodeLatest.values()).sort((a, b) => a.node - b.node);
    const filteredHistory = nodeHistory
      .filter((rec) => new Date(rec.received_at).getTime() >= cutoffMs)
      .sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime());

    return sendJson(res, 200, {
      latest: latestList,
      history: filteredHistory,
      server_time: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // POST /ingest (ESP32 telemetry ingestion)
  // ---------------------------------------------------------------------------
  if (req.method === "POST") {
    // 1. Device Key Authentication
    const clientKey = req.headers["x-device-key"] || "";
    if (!constantTimeCompare(DEVICE_KEY, clientKey)) {
      return sendJson(res, 401, { error: "Unauthorized: invalid or missing X-Device-Key" });
    }

    // Read body
    let rawData = "";
    req.on("data", (chunk) => {
      rawData += chunk;
      // Guard against huge payload attacks
      if (rawData.length > 65536) {
        res.destroy();
      }
    });

    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(rawData);
      } catch (err) {
        // Resilient fallback for PowerShell CLI which strips double-quotes from native curl args
        try {
          const fixed = rawData
            .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
            .replace(/:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*([,}])/g, (match, val, ending) => {
              if (val === 'true' || val === 'false' || val === 'null') return `:${val}${ending}`;
              return `:"${val}"${ending}`;
            });
          body = JSON.parse(fixed);
        } catch {
          console.error("JSON parse failed. rawData was:", JSON.stringify(rawData), "error:", err.message);
          return sendJson(res, 400, { error: `Invalid JSON format: ${err.message}` });
        }
      }

      // 2. Validate payload
      const validation = validatePayload(body);
      if (!validation.valid) {
        return sendJson(res, 400, { error: validation.error, field: validation.field });
      }

      const payload = validation.data;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      // 3. Rate limiting (< 1500ms per node)
      const RATE_LIMIT_MS = 1500;
      const lastPost = lastPostByNode.get(payload.node);
      if (lastPost && nowMs - lastPost < RATE_LIMIT_MS) {
        return sendJson(res, 429, {
          error: "Rate limit exceeded: Telemetry frequency must not exceed 1 packet per 1.5 seconds per node",
          node: payload.node,
        });
      }
      lastPostByNode.set(payload.node, nowMs);

      // 4. Update node_latest
      const record = {
        ...payload,
        received_at: nowIso,
      };
      nodeLatest.set(payload.node, record);

      // 5. Downsampled History (30 seconds) + 24h retention
      const lastHist = lastHistoryByNode.get(payload.node);
      let historySampled = false;

      if (!lastHist || nowMs - lastHist >= 30_000) {
        historySampled = true;
        lastHistoryByNode.set(payload.node, nowMs);
        nodeHistory.push({
          id: nodeHistory.length + 1,
          ...record,
        });

        // Prune older than 24 hours
        const retentionCutoff = nowMs - 24 * 60 * 60 * 1000;
        nodeHistory = nodeHistory.filter(
          (h) => new Date(h.received_at).getTime() >= retentionCutoff
        );
      }

      console.log(
        `[${nowIso}] Node ${payload.node} ACK | vbat: ${payload.vbat}V | soc: ${payload.soc}% | src: ${payload.src} | hist_sampled: ${historySampled}`
      );

      return sendJson(res, 200, {
        ok: true,
        node: payload.node,
        received_at: nowIso,
        history_sampled: historySampled,
      });
    });

    return;
  }

  return sendJson(res, 405, { error: `Method ${req.method} not allowed` });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("=".repeat(70));
  console.log(`Nanogrid Mock Backend running on http://localhost:${PORT}`);
  console.log(`Ingest endpoint: POST http://localhost:${PORT}/ingest`);
  console.log(`Read endpoint:   GET  http://localhost:${PORT}/ingest?range=15m|1h|24h`);
  console.log(`Auth Header:     X-Device-Key: ${DEVICE_KEY}`);
  console.log("=".repeat(70));
});

// Graceful termination
process.on("SIGINT", () => {
  server.close(() => {
    console.log("\nMock backend stopped.");
    process.exit(0);
  });
});
