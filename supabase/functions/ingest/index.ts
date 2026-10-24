// Supabase Edge Function: Ingestion & Telemetry API
// Endpoint: /functions/v1/ingest
// Authentication for POST: X-Device-Key header matching secret DEVICE_KEY
// GET: Public read endpoint for dashboard data

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

// In-memory rate limiting map (per-isolate cache): node -> timestamp ms
const lastPostByNode = new Map<number, number>();

// Standard CORS headers for cross-origin frontend queries
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

// Timing-safe constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  if (bufA.length !== bufB.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

export interface TelemetryPayload {
  node: number;
  uptime_s: number;
  src: "NONE" | "PV" | "BATTERY";
  tie: "NONE" | "EXPORT" | "IMPORT";
  soc: number;
  vbat: number;
  ibat: number;
  vpv: number;
  ipv: number;
  vbus: number;
  ibus: number;
  pv_ok: boolean;
  lockout: boolean;
  import_bus_ok: boolean;
  rssi: number;
  fw: string;
}

function validateTelemetryPayload(body: unknown): { valid: true; data: TelemetryPayload } | { valid: false; error: string; field: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, error: "Payload must be a JSON object", field: "root" };
  }

  const raw = body as Record<string, unknown>;

  // 1. node (1 or 2)
  if (typeof raw.node !== "number" || !Number.isInteger(raw.node) || (raw.node !== 1 && raw.node !== 2)) {
    return { valid: false, error: "Field 'node' must be integer 1 or 2", field: "node" };
  }

  // 2. uptime_s (>= 0 integer)
  if (typeof raw.uptime_s !== "number" || !Number.isInteger(raw.uptime_s) || raw.uptime_s < 0) {
    return { valid: false, error: "Field 'uptime_s' must be an integer >= 0", field: "uptime_s" };
  }

  // 3. src ('NONE' | 'PV' | 'BATTERY')
  if (typeof raw.src !== "string" || !["NONE", "PV", "BATTERY"].includes(raw.src)) {
    return { valid: false, error: "Field 'src' must be 'NONE', 'PV', or 'BATTERY'", field: "src" };
  }

  // 4. tie ('NONE' | 'EXPORT' | 'IMPORT')
  if (typeof raw.tie !== "string" || !["NONE", "EXPORT", "IMPORT"].includes(raw.tie)) {
    return { valid: false, error: "Field 'tie' must be 'NONE', 'EXPORT', or 'IMPORT'", field: "tie" };
  }

  // 5. soc (0 - 100 finite number)
  if (typeof raw.soc !== "number" || !Number.isFinite(raw.soc) || raw.soc < 0 || raw.soc > 100) {
    return { valid: false, error: "Field 'soc' must be a number between 0 and 100", field: "soc" };
  }

  // Physical bounds check helper (-100V to +100V, -100A to +100A)
  const isBoundedNumber = (val: unknown): val is number => {
    return typeof val === "number" && Number.isFinite(val) && val >= -100 && val <= 100;
  };

  // 6. vbat
  if (!isBoundedNumber(raw.vbat)) {
    return { valid: false, error: "Field 'vbat' must be a finite number between -100 and 100", field: "vbat" };
  }

  // 7. ibat
  if (!isBoundedNumber(raw.ibat)) {
    return { valid: false, error: "Field 'ibat' must be a finite number between -100 and 100", field: "ibat" };
  }

  // 8. vpv
  if (!isBoundedNumber(raw.vpv)) {
    return { valid: false, error: "Field 'vpv' must be a finite number between -100 and 100", field: "vpv" };
  }

  // 9. ipv
  if (!isBoundedNumber(raw.ipv)) {
    return { valid: false, error: "Field 'ipv' must be a finite number between -100 and 100", field: "ipv" };
  }

  // 10. vbus
  if (!isBoundedNumber(raw.vbus)) {
    return { valid: false, error: "Field 'vbus' must be a finite number between -100 and 100", field: "vbus" };
  }

  // 11. ibus
  if (!isBoundedNumber(raw.ibus)) {
    return { valid: false, error: "Field 'ibus' must be a finite number between -100 and 100", field: "ibus" };
  }

  // 12. pv_ok
  if (typeof raw.pv_ok !== "boolean") {
    return { valid: false, error: "Field 'pv_ok' must be a boolean", field: "pv_ok" };
  }

  // 13. lockout
  if (typeof raw.lockout !== "boolean") {
    return { valid: false, error: "Field 'lockout' must be a boolean", field: "lockout" };
  }

  // 14. import_bus_ok
  if (typeof raw.import_bus_ok !== "boolean") {
    return { valid: false, error: "Field 'import_bus_ok' must be a boolean", field: "import_bus_ok" };
  }

  // 15. rssi (-150 to 0 dBm)
  if (typeof raw.rssi !== "number" || !Number.isInteger(raw.rssi) || raw.rssi < -150 || raw.rssi > 0) {
    return { valid: false, error: "Field 'rssi' must be an integer between -150 and 0", field: "rssi" };
  }

  // 16. fw (non-empty string <= 64 chars)
  if (typeof raw.fw !== "string" || raw.fw.trim().length === 0 || raw.fw.length > 64) {
    return { valid: false, error: "Field 'fw' must be a non-empty string <= 64 chars", field: "fw" };
  }

  return {
    valid: true,
    data: {
      node: raw.node,
      uptime_s: raw.uptime_s,
      src: raw.src as "NONE" | "PV" | "BATTERY",
      tie: raw.tie as "NONE" | "EXPORT" | "IMPORT",
      soc: Number(raw.soc.toFixed(2)),
      vbat: Number(raw.vbat.toFixed(3)),
      ibat: Number(raw.ibat.toFixed(3)),
      vpv: Number(raw.vpv.toFixed(3)),
      ipv: Number(raw.ipv.toFixed(3)),
      vbus: Number(raw.vbus.toFixed(3)),
      ibus: Number(raw.ibus.toFixed(3)),
      pv_ok: raw.pv_ok,
      lockout: raw.lockout,
      import_bus_ok: raw.import_bus_ok,
      rssi: raw.rssi,
      fw: raw.fw.trim(),
    },
  };
}

// Get Supabase service client
function getSupabaseAdmin() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable");
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // -------------------------------------------------------------------------
    // GET /ingest: Public read endpoint for latest status and historical trend
    // -------------------------------------------------------------------------
    if (req.method === "GET") {
      const url = new URL(req.url);
      const rangeParam = url.searchParams.get("range") || "24h";

      let rangeMs = 24 * 60 * 60 * 1000;
      if (rangeParam === "15m") {
        rangeMs = 15 * 60 * 1000;
      } else if (rangeParam === "1h") {
        rangeMs = 60 * 60 * 1000;
      } else if (rangeParam === "24h") {
        rangeMs = 24 * 60 * 60 * 1000;
      }

      const cutoff = new Date(Date.now() - rangeMs).toISOString();
      const supabase = getSupabaseAdmin();

      const [latestRes, historyRes] = await Promise.all([
        supabase
          .from("node_latest")
          .select("*")
          .order("node", { ascending: true }),
        supabase
          .from("node_history")
          .select("*")
          .gte("received_at", cutoff)
          .order("received_at", { ascending: true })
          .limit(5000),
      ]);

      if (latestRes.error) {
        return jsonResponse({ error: "Failed to fetch node_latest", details: latestRes.error.message }, 500);
      }
      if (historyRes.error) {
        return jsonResponse({ error: "Failed to fetch node_history", details: historyRes.error.message }, 500);
      }

      return jsonResponse({
        latest: latestRes.data ?? [],
        history: historyRes.data ?? [],
        server_time: new Date().toISOString(),
      });
    }

    // -------------------------------------------------------------------------
    // POST /ingest: ESP32 Telemetry Ingest
    // -------------------------------------------------------------------------
    if (req.method === "POST") {
      // 1. Device Key Authentication
      const expectedKey = Deno.env.get("DEVICE_KEY") || "";
      const providedKey = req.headers.get("x-device-key") || "";

      if (!expectedKey || !providedKey || !timingSafeEqual(expectedKey, providedKey)) {
        return jsonResponse({ error: "Unauthorized: invalid or missing X-Device-Key" }, 401);
      }

      // 2. Parse JSON body safely
      let body: unknown;
      try {
        body = await req.json();
      } catch (_err) {
        return jsonResponse({ error: "Invalid JSON format in request body" }, 400);
      }

      // 3. Strict 16-field validation
      const validation = validateTelemetryPayload(body);
      if (!validation.valid) {
        return jsonResponse({ error: validation.error, field: validation.field }, 400);
      }

      const payload = validation.data;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const supabase = getSupabaseAdmin();

      // 4. Rate Limiting Check (< 1500ms per node)
      const RATE_LIMIT_MS = 1500;

      // Check in-memory isolate timestamp
      const lastMemoryPost = lastPostByNode.get(payload.node);
      if (lastMemoryPost && nowMs - lastMemoryPost < RATE_LIMIT_MS) {
        return jsonResponse({
          error: "Rate limit exceeded: Telemetry frequency must not exceed 1 packet per 1.5 seconds per node",
          node: payload.node,
        }, 429);
      }

      // Check database timestamp on node_latest
      const { data: latestExisting } = await supabase
        .from("node_latest")
        .select("received_at")
        .eq("node", payload.node)
        .maybeSingle();

      if (latestExisting?.received_at) {
        const lastDbMs = new Date(latestExisting.received_at).getTime();
        if (nowMs - lastDbMs < RATE_LIMIT_MS) {
          return jsonResponse({
            error: "Rate limit exceeded: Telemetry frequency must not exceed 1 packet per 1.5 seconds per node",
            node: payload.node,
          }, 429);
        }
      }

      // Update in-memory rate map
      lastPostByNode.set(payload.node, nowMs);

      // 5. Upsert into public.node_latest
      const nodeRecord = {
        ...payload,
        received_at: nowIso,
      };

      const { error: upsertErr } = await supabase
        .from("node_latest")
        .upsert(nodeRecord, { onConflict: "node" });

      if (upsertErr) {
        return jsonResponse({ error: "Database upsert error on node_latest", details: upsertErr.message }, 500);
      }

      // 6. Downsampled History Ingestion (1 sample per >= 30 seconds)
      const { data: latestHistory } = await supabase
        .from("node_history")
        .select("received_at")
        .eq("node", payload.node)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      let historySampled = false;
      const shouldSampleHistory =
        !latestHistory ||
        nowMs - new Date(latestHistory.received_at).getTime() >= 30_000;

      if (shouldSampleHistory) {
        const { error: histInsertErr } = await supabase
          .from("node_history")
          .insert(nodeRecord);

        if (!histInsertErr) {
          historySampled = true;

          // Prune history older than 24 hours
          const cutoff24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
          await supabase
            .from("node_history")
            .delete()
            .lt("received_at", cutoff24h);
        }
      }

      return jsonResponse({
        ok: true,
        node: payload.node,
        received_at: nowIso,
        history_sampled: historySampled,
      }, 200);
    }

    return jsonResponse({ error: `Method ${req.method} not allowed` }, 405);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: "Internal Server Error", details: message }, 500);
  }
});
