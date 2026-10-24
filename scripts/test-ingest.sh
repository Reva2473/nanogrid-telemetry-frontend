#!/usr/bin/env bash
# ==============================================================================
# Nanogrid Telemetry Ingestion Verification Script (Bash / curl)
# Tests the ingest endpoint for compliance with authentication, validation,
# and rate limiting requirements.
#
# Usage:
#   chmod +x ./scripts/test-ingest.sh
#   ./scripts/test-ingest.sh
#
# Custom endpoint and secret via environment variables:
#   export INGEST_URL="https://your-project.supabase.co/functions/v1/ingest"
#   export DEVICE_KEY="your-actual-device-key"
#   ./scripts/test-ingest.sh
# ==============================================================================

set -u

INGEST_URL="${INGEST_URL:-http://localhost:8787/ingest}"
DEVICE_KEY="${DEVICE_KEY:-test-device-key-change-me}"

# Colors
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

echo -e "${CYAN}======================================================================${NC}"
echo -e "${CYAN}  Dual Nanogrid Telemetry Ingest Verification Test Suite (curl/Bash)  ${NC}"
echo -e "${CYAN}======================================================================${NC}"
echo -e "${YELLOW}Target URL : ${INGEST_URL}${NC}"
if [ ${#DEVICE_KEY} -gt 6 ]; then
  MASKED="${DEVICE_KEY:0:4}...${DEVICE_KEY: -2}"
else
  MASKED="***"
fi
echo -e "${YELLOW}Device Key : ${MASKED}${NC}"
echo ""

PASSED=0
FAILED=0

# Helper function to send POST and extract status code + body
# Usage: test_request "Description" "TestNum" "X-Device-Key" "JSON_BODY" EXPECTED_STATUS
run_test() {
  local TEST_NUM="$1"
  local DESC="$2"
  local KEY_HEADER="$3"
  local PAYLOAD="$4"
  local EXPECTED_CODE="$5"

  echo -n -e "[Test ${TEST_NUM}] ${DESC}... "

  # Run curl and output body followed by HTTP status marker
  local RESPONSE
  RESPONSE=$(curl -s -S -w "\nHTTP_STATUS:%{http_code}" \
    -X POST "${INGEST_URL}" \
    -H "Content-Type: application/json" \
    -H "X-Device-Key: ${KEY_HEADER}" \
    -d "${PAYLOAD}" 2>&1)

  local STATUS
  STATUS=$(echo "${RESPONSE}" | grep "HTTP_STATUS:" | sed 's/HTTP_STATUS://' | tr -d '\r\n')
  local BODY
  BODY=$(echo "${RESPONSE}" | sed '/HTTP_STATUS:/d')

  if [ "${STATUS}" = "${EXPECTED_CODE}" ]; then
    echo -e "${GREEN}[PASS]${NC}"
    echo -e "       ${GRAY}Received HTTP ${STATUS} (Expected ${EXPECTED_CODE})${NC}"
    if [ -n "${BODY}" ]; then
      local SHORT_BODY
      SHORT_BODY=$(echo "${BODY}" | tr '\n' ' ' | cut -c 1-120)
      echo -e "       ${GRAY}Response: ${SHORT_BODY}${NC}"
    fi
    PASSED=$((PASSED + 1))
    return 0
  else
    echo -e "${RED}[FAIL]${NC}"
    echo -e "       ${RED}Expected HTTP ${EXPECTED_CODE}, but received HTTP ${STATUS}${NC}"
    echo -e "       ${YELLOW}Response: ${BODY}${NC}"
    FAILED=$((FAILED + 1))
    return 1
  fi
}

# ------------------------------------------------------------------------------
# Test 1: Valid POST for Node 2 (Exact sample JSON from requirements)
# ------------------------------------------------------------------------------
PAYLOAD_NODE2='{
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

run_test "1" "Valid Ingest POST for Node 2" "${DEVICE_KEY}" "${PAYLOAD_NODE2}" "200"

# ------------------------------------------------------------------------------
# Test 2: Valid POST for Node 1
# ------------------------------------------------------------------------------
PAYLOAD_NODE1='{
  "node": 1,
  "uptime_s": 2450,
  "src": "PV",
  "tie": "IMPORT",
  "soc": 85.5,
  "vbat": 12.85,
  "ibat": 0.450,
  "vpv": 12.42,
  "ipv": 0.620,
  "vbus": 15.00,
  "ibus": 0.205,
  "pv_ok": true,
  "lockout": false,
  "import_bus_ok": true,
  "rssi": -58,
  "fw": "telemetry-1"
}'

sleep 0.2
run_test "2" "Valid Ingest POST for Node 1" "${DEVICE_KEY}" "${PAYLOAD_NODE1}" "200"

# ------------------------------------------------------------------------------
# Test 3: Wrong X-Device-Key -> HTTP 401 Unauthorized
# ------------------------------------------------------------------------------
run_test "3" "Reject wrong X-Device-Key with 401" "invalid-secret-key-12345" "${PAYLOAD_NODE2}" "401"

# ------------------------------------------------------------------------------
# Test 4: Malformed body -> HTTP 400 Bad Request
# ------------------------------------------------------------------------------
PAYLOAD_MALFORMED='{
  "node": 99,
  "uptime_s": -50,
  "soc": 150.0
}'

run_test "4" "Reject malformed body with 400" "${DEVICE_KEY}" "${PAYLOAD_MALFORMED}" "400"

# ------------------------------------------------------------------------------
# Test 5: Rapid Duplicate POST -> HTTP 429 Rate Limit
# ------------------------------------------------------------------------------
echo -n -e "[Test 5] Rapid duplicate POST (< 1500ms) for Node 2 rate limit... "

# Send both requests in a single curl invocation to reuse the exact same TLS/HTTP2 connection
# with 0ms handshake overhead between the first and second POST
RAPID_RESP=$(curl -s -S -w "\nHTTP_STATUS:%{http_code}\n" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: ${DEVICE_KEY}" \
  -d "${PAYLOAD_NODE2}" \
  "${INGEST_URL}" "${INGEST_URL}" 2>&1)

if echo "${RAPID_RESP}" | grep -q "HTTP_STATUS:429"; then
  echo -e "${GREEN}[PASS]${NC}"
  echo -e "       ${GRAY}Received HTTP 429 Too Many Requests (Rate limit active)${NC}"
  RAPID_BODY=$(echo "${RAPID_RESP}" | grep -B 1 "HTTP_STATUS:429" | head -n 1)
  SHORT_BODY=$(echo "${RAPID_BODY}" | tr '\n' ' ' | cut -c 1-120)
  echo -e "       ${GRAY}Response: ${SHORT_BODY}${NC}"
  PASSED=$((PASSED + 1))
else
  STATUSES=$(echo "${RAPID_RESP}" | grep "HTTP_STATUS:" | tr '\n' ' ')
  echo -e "${RED}[FAIL]${NC}"
  echo -e "       ${RED}Expected HTTP 429 in rapid duplicate POST, but received: ${STATUSES}${NC}"
  echo -e "       ${YELLOW}Response: ${RAPID_RESP}${NC}"
  FAILED=$((FAILED + 1))
fi

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
echo ""
echo -e "${CYAN}----------------------------------------------------------------------${NC}"
if [ ${FAILED} -eq 0 ]; then
  echo -e "${GREEN}Test Results: ${PASSED} Passed, ${FAILED} Failed (Total 5)${NC}"
else
  echo -e "${RED}Test Results: ${PASSED} Passed, ${FAILED} Failed (Total 5)${NC}"
fi
echo -e "${CYAN}----------------------------------------------------------------------${NC}"

if [ ${FAILED} -gt 0 ]; then
  exit 1
else
  exit 0
fi
