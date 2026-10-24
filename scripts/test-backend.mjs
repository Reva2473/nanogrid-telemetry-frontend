import http from "node:http";
import { spawn } from "node:child_process";

const TEST_PORT = 8789;
const TEST_KEY = "test-device-key-change-me";

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request({ method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: TEST_PORT,
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_e) {
            json = data;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("Starting mock backend on port", TEST_PORT);
  const serverProc = spawn("node", ["scripts/mock-backend.mjs"], {
    cwd: "c:\\Users\\Ranja\\Desktop\\PV_research",
    env: { ...process.env, PORT: String(TEST_PORT), DEVICE_KEY: TEST_KEY },
    stdio: "pipe",
  });

  serverProc.stdout.on("data", (d) => process.stdout.write(`[SERVER] ${d}`));
  serverProc.stderr.on("data", (d) => process.stderr.write(`[SERVER ERR] ${d}`));

  await wait(1000);

  const samplePayloadNode1 = {
    node: 1,
    uptime_s: 120,
    src: "PV",
    tie: "EXPORT",
    soc: 85.5,
    vbat: 13.8,
    ibat: -2.4,
    vpv: 18.6,
    ipv: 4.1,
    vbus: 14.1,
    ibus: 1.7,
    pv_ok: true,
    lockout: false,
    import_bus_ok: true,
    rssi: -65,
    fw: "v1.0.0-node1",
  };

  try {
    // Test 1: OPTIONS CORS preflight
    console.log("--- Test 1: OPTIONS CORS ---");
    const resOpt = await request({ method: "OPTIONS", path: "/ingest" });
    console.log("OPTIONS status:", resOpt.status);
    if (resOpt.status !== 204 && resOpt.status !== 200) throw new Error("OPTIONS failed");

    // Test 2: Missing X-Device-Key -> 401
    console.log("--- Test 2: Missing auth header ---");
    const resNoKey = await request({
      method: "POST",
      path: "/ingest",
      headers: { "Content-Type": "application/json" },
      body: samplePayloadNode1,
    });
    console.log("No key status:", resNoKey.status, resNoKey.body);
    if (resNoKey.status !== 401) throw new Error("Expected 401 for missing key");

    // Test 3: Wrong X-Device-Key -> 401
    console.log("--- Test 3: Wrong auth header ---");
    const resWrongKey = await request({
      method: "POST",
      path: "/ingest",
      headers: { "Content-Type": "application/json", "X-Device-Key": "wrong-key" },
      body: samplePayloadNode1,
    });
    console.log("Wrong key status:", resWrongKey.status, resWrongKey.body);
    if (resWrongKey.status !== 401) throw new Error("Expected 401 for wrong key");

    // Test 4: Malformed JSON -> 400
    console.log("--- Test 4: Malformed JSON ---");
    const resBadJson = await request({
      method: "POST",
      path: "/ingest",
      headers: { "Content-Type": "application/json", "X-Device-Key": TEST_KEY },
      body: "{not-json",
    });
    console.log("Bad json status:", resBadJson.status, resBadJson.body);
    if (resBadJson.status !== 400) throw new Error("Expected 400 for bad json");

    // Test 5: Validation Failure (invalid soc) -> 400
    console.log("--- Test 5: Validation error (soc > 100) ---");
    const resBadSoc = await request({
      method: "POST",
      path: "/ingest",
      headers: { "Content-Type": "application/json", "X-Device-Key": TEST_KEY },
      body: { ...samplePayloadNode1, soc: 150 },
    });
    console.log("Bad SOC status:", resBadSoc.status, resBadSoc.body);
    if (resBadSoc.status !== 400 || resBadSoc.body.field !== "soc") {
      throw new Error("Expected 400 field soc");
    }

    // Test 6: Valid POST Node 1 -> 200
    console.log("--- Test 6: Valid Node 1 POST ---");
    const resValid1 = await request({
      method: "POST",
      path: "/ingest",
      headers: { "Content-Type": "application/json", "X-Device-Key": TEST_KEY },
      body: samplePayloadNode1,
    });
    console.log("Valid POST 1 status:", resValid1.status, resValid1.body);
    if (resValid1.status !== 200 || !resValid1.body.ok) throw new Error("Expected 200 ok for valid post");

    // Test 7: Immediate second POST on Node 1 (<1s) -> 429
    console.log("--- Test 7: Rate limit test (<1000ms) ---");
    const resRateLimit = await request({
      method: "POST",
      path: "/ingest",
      headers: { "Content-Type": "application/json", "X-Device-Key": TEST_KEY },
      body: samplePayloadNode1,
    });
    console.log("Rate limit status:", resRateLimit.status, resRateLimit.body);
    if (resRateLimit.status !== 429) throw new Error("Expected 429 rate limit");

    // Test 8: Valid Node 2 POST -> 200
    console.log("--- Test 8: Valid Node 2 POST ---");
    const samplePayloadNode2 = {
      ...samplePayloadNode1,
      node: 2,
      src: "BATTERY",
      tie: "IMPORT",
      soc: 42.1,
      vbat: 12.2,
      ibat: 3.5,
      vpv: 0.0,
      ipv: 0.0,
      vbus: 12.0,
      ibus: -1.7,
      pv_ok: false,
      lockout: false,
      import_bus_ok: true,
      rssi: -72,
      fw: "v1.0.0-node2",
    };
    const resValid2 = await request({
      method: "POST",
      path: "/ingest",
      headers: { "Content-Type": "application/json", "X-Device-Key": TEST_KEY },
      body: samplePayloadNode2,
    });
    console.log("Valid POST 2 status:", resValid2.status, resValid2.body);
    if (resValid2.status !== 200 || resValid2.body.node !== 2) throw new Error("Expected 200 for node 2");

    // Test 9: GET /ingest read endpoint -> 200
    console.log("--- Test 9: GET /ingest read endpoint ---");
    const resGet = await request({
      method: "GET",
      path: "/ingest?range=1h",
    });
    console.log("GET status:", resGet.status, "latest count:", resGet.body.latest.length, "history count:", resGet.body.history.length);
    if (resGet.status !== 200 || resGet.body.latest.length !== 2) {
      throw new Error("Expected GET to return 2 latest node records");
    }

    console.log("\nALL VERIFICATION TESTS PASSED SUCCESSFULLY! ✓");
  } finally {
    serverProc.kill();
  }
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
