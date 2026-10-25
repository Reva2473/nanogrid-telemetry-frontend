/*
 * Dual Nanogrid — Hybrid PV/Battery Node Firmware (I2C/INA226 version — restored)
 * PV is primary, battery is secondary/backup, shared bus is last resort —
 * and the shared bus can now ALSO trickle-charge the battery via Relay D's
 * diode, not just power the local bus.
 *
 * Rolled back to this from the analog (voltage-divider + ACS712) variant
 * after the INA226 I2C hardware issue was tracked down and fixed (bad
 * connection on one board/position — see the diagnostic sketches from
 * earlier in this project if it recurs). This version carries your two
 * confirmed hardware changes forward:
 *   - Relay D now on GPIO33 (not GPIO14/13)
 *   - Battery INA226 at address 0x45 (both A0 and A1 pads bridged to VS
 *     on that board) — confirmed correct via the I2C scanner, not a typo
 *
 * Fixes applied vs earlier drafts:
 *   1) PV-healthy checked BEFORE battery-critical-voltage, so a perfectly
 *      good PV source can never be shadowed by a stale low-battery check.
 *   2) Minimum-closed-time logic lives in upstream want-latches, not in the
 *      hardware-write functions, so safety trips and lockouts always open
 *      relays immediately with no risk of stalling behind a timer.
 *   3) Explicit timed deadtime for the C<->D (export/import) handoff.
 *   4) Import (D) is now independent of the local-source choice (A/B) —
 *      see the relay-group note just below.
 *
 * Four relays per node, in TWO groups (no longer fully independent — see
 * the Relay C note below):
 *   Group 1 — local source, mutually exclusive (real conflict, no diode):
 *     A (PIN_RELAY_PV)   — PV rail (post-buck, ~12.4V) feeds local bus
 *     B (PIN_RELAY_BATT) — Battery feeds local bus directly
 *   Group 2 — tie point, mutually exclusive (shared tie point):
 *     C (PIN_RELAY_TX) — gates the TX converter's INPUT off the local bus
 *                        (moved here from TX's output — see below).
 *                        TX's output stays permanently wired through
 *                        D_TX's diode to the tie point, same pattern as
 *                        Relay D/D_RX on the import side.
 *     D (PIN_RELAY_RX) — Shared bus imports into local bus (buck + ballast + diode)
 *
 * RELAY C REWIRED (bench-test finding): TX's input used to be permanently
 * hot off the local bus with only Relay C gating its output. That meant
 * EVERY local-source close (Relay A for ordinary PV duty, nothing to do
 * with exporting) woke the TX converter up and let it fight whatever was
 * feeding the bus. Bench testing showed this is a constant-power-load
 * instability: a plain resistive/LED load of similar current only sagged
 * the PV rail a few volts, but the actively-regulating TX converter
 * collapsed it to ~2.6-2.9V every time, regardless of source strength
 * (confirmed with the real panel, a 9V-battery PV stand-in, and 3 panels
 * in parallel — all collapsed about the same). A plain capacitor and a
 * series inrush resistor at TX's input did NOT fix it, which ruled out a
 * simple startup-current-spike cause. The battery, by contrast, carried
 * the TX converter's startup fight with zero visible effect every time.
 * So: Relay C now gates TX's INPUT (matching Relay D's existing pattern
 * on RX's input) instead of its output, and desiredSource below FORCES
 * the local source to battery whenever export is eligible, so TX only
 * ever powers up from a battery-fed bus, never a PV-fed one. See the
 * TIE_TX guard in loop() for how this is sequenced safely.
 *
 * Group 2's import side (D) is still independent of Group 1. D can close
 * while B is also closed: D_RX is diode-isolated, so it sits safely in
 * parallel with the battery — it only conducts while its own ~12.6V
 * output is above the battery's current voltage, and stops on its own
 * once the battery rises to meet it. That's what lets the shared bus
 * charge the battery, not just power the local bus, with zero extra
 * wiring (D_RX already lands on the same local-bus node Relay B feeds)
 * and zero extra code in the SOC tracking (INA #1 already reads net
 * battery current, so this charging current shows up automatically).
 *
 * Three INA226s:
 *   0x45 = battery, at the terminal BEFORE the charge/discharge split —
 *          reads NET battery current (charge +, discharge -). Address is
 *          0x45 (both A0 and A1 bridged to VS) on this board, confirmed
 *          via I2C scanner. This only works if wired per the connections
 *          doc (INA #1 at the battery net junction, not only in the
 *          discharge leg).
 *   0x41 = PV rail, AFTER the buck stage (not raw panel)
 *   0x44 = shared bus / tie point (export negative, import positive)
 *
 * I2C bus: GPIO21 (SDA) / GPIO22 (SCL), with a 4.7kΩ pull-up pair
 * (SDA->3V3, SCL->3V3) — once for the whole bus, not per board. This was
 * part of the fix for the earlier flaky-bus symptoms; keep it even though
 * the root cause turned out to also include a bad physical connection.
 *
 * ASSUMPTIONS — adjust to your actual hardware:
 *   - INA226 shunts are confirmed R100 (0.1 ohm, stock) — clean reading
 *     range to ~0.8A. All fuses in this revision are 1A (plus a 2A fuse
 *     right at the battery terminal, ahead of the charge/discharge split —
 *     see the connections doc), sized to match.
 *   - PV rail buck setpoint assumed ~12.4V; thresholds below have margin
 *     around that, not measured on your actual hardware.
 *   - Export/import SOC thresholds (60/55 surplus, 20/25 deficit) are
 *     placeholders matching your stated 20% deficit point — tune freely.
 *
 * --- ADDED, NOTHING ELSE CHANGED ---
 * A second, Serial-Plotter-friendly print line was added at the end of
 * loop(), right after the existing human-readable log line. It uses the
 * Arduino IDE 2.x plotter's "label:value" format so you get a live legend
 * and curves for Vbat/Ibat/Vpv/Ipv/Vbus/Ibus/SOC, without touching any
 * existing variable, threshold, or control-logic line in this file.
 */

#include <Wire.h>
#include <Preferences.h>
#include "telemetry.h"

// ---------------------------------------------------------------------
// Configuration — edit per node
// ---------------------------------------------------------------------
#define NODE_ID              2
#define PIN_RELAY_PV         25   // Relay A
#define PIN_RELAY_BATT       26   // Relay B
#define PIN_RELAY_TX         27   // Relay C
#define PIN_RELAY_RX         33   // Relay D (confirmed hardware pin)
#define I2C_SDA              21
#define I2C_SCL              22

#define BATTERY_CAPACITY_AH  15.0f

// INA226 addresses — ADDR_BATTERY confirmed as 0x45 via I2C scanner
// (both A0 and A1 pads bridged to VS on that board)
#define ADDR_BATTERY  0x45
#define ADDR_PV       0x41   // post-buck PV rail, at relay A's input
#define ADDR_BUS      0x44

// Calibration — confirmed R100 (0.1 ohm) stock shunts (clean range to ~0.8A)
#define CURRENT_LSB_A     0.000025f   // 25 uA/bit
#define INA226_CAL_VALUE  2048

// --- PV rail health (post-buck, setpoint assumed ~12.4V) ---
#define PV_INSUFFICIENT_V     7.0f
#define PV_INSUFFICIENT_HOLD_MS  3000UL
#define PV_RECOVERED_V        12.2f
#define PV_RECOVERED_HOLD_MS  10000UL

// --- Deficit / surplus SOC bands ---
#define DEFICIT_ENTER_PCT   20.0f
#define DEFICIT_EXIT_PCT    25.0f
#define SURPLUS_ENTER_PCT   60.0f
#define SURPLUS_EXIT_PCT    55.0f

// --- Import (Relay D) bus thresholds ---
#define IMPORT_BUS_OK_V      12.8f
#define IMPORT_BUS_OK_HOLD_MS   3000UL
#define IMPORT_BUS_LOW_V     12.0f
#define IMPORT_BUS_LOW_HOLD_MS  5000UL

// --- Export (Relay C) ---
#define TX_MIN_CLOSED_MS     20000UL

// --- Relay interlocks ---
#define RELAY_DEADTIME_MS    2000UL   // A/B group, and also the C<->D handoff

// --- Safety ---
#define SAFETY_CURRENT_A     0.6f   // margin below the R100 shunt's ~0.8A clean-reading ceiling
#define SAFETY_HOLD_MS       1000UL
#define SAFETY_LOCKOUT_MS    60000UL
#define BATTERY_CRITICAL_V   10.5f  // battery relay never selected below this, no exceptions

// --- Full-charge detection ---
#define FULL_CHARGE_V         14.3f
#define FULL_CHARGE_I_A        0.05f
#define FULL_CHARGE_HOLD_MS   60000UL

#define INITIAL_SOC            98.0f

// ---------------------------------------------------------------------
// Minimal INA226 driver
// ---------------------------------------------------------------------
class INA226 {
  public:
    INA226(uint8_t addr) : _addr(addr) {}
    bool begin() {
      if (!writeReg(0x00, 0x4527)) return false;
      if (!writeReg(0x05, INA226_CAL_VALUE)) return false;
      return true;
    }
    float readBusVoltage() {
      uint16_t raw;
      if (!readReg(0x02, raw)) return NAN;
      return raw * 0.00125f;
    }
    float readCurrent() {
      int16_t raw;
      if (!readReg(0x04, (uint16_t&)raw)) return NAN;
      return raw * CURRENT_LSB_A;
    }
  private:
    uint8_t _addr;
    bool writeReg(uint8_t reg, uint16_t val) {
      Wire.beginTransmission(_addr);
      Wire.write(reg);
      Wire.write((val >> 8) & 0xFF);
      Wire.write(val & 0xFF);
      return Wire.endTransmission() == 0;
    }
    bool readReg(uint8_t reg, uint16_t &val) {
      Wire.beginTransmission(_addr);
      Wire.write(reg);
      if (Wire.endTransmission(false) != 0) return false;
      if (Wire.requestFrom((int)_addr, 2) != 2) return false;
      val = (Wire.read() << 8) | Wire.read();
      return true;
    }
};

INA226 inaBattery(ADDR_BATTERY);
INA226 inaPV(ADDR_PV);
INA226 inaBus(ADDR_BUS);

// ---------------------------------------------------------------------
// SOC (hand-entered)
// ---------------------------------------------------------------------
Preferences prefs;
float soc_pct = INITIAL_SOC;
void loadSOC() { prefs.begin("nanogrid", false); soc_pct = prefs.getFloat("soc", 50.0f); }
void saveSOC() { prefs.putFloat("soc", soc_pct); }

unsigned long lastDriftMs = 0;
void updateSOCDrift(float batteryCurrentA) {
  unsigned long now = millis();
  if (lastDriftMs == 0) { lastDriftMs = now; return; }
  float dt_h = (now - lastDriftMs) / 3600000.0f;
  lastDriftMs = now;
  soc_pct += (batteryCurrentA * dt_h / BATTERY_CAPACITY_AH) * 100.0f;
  soc_pct = constrain(soc_pct, 0.0f, 100.0f);
}

String serialBuf = "";
void handleSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      serialBuf.trim();
      if (serialBuf.startsWith("SOC ")) {
        soc_pct = constrain(serialBuf.substring(4).toFloat(), 0.0f, 100.0f);
        saveSOC();
        Serial.printf("[Node %d] SOC manually set to %.1f%%\n", NODE_ID, soc_pct);
      }
      serialBuf = "";
    } else serialBuf += c;
  }
}

// ---------------------------------------------------------------------
// Relay groups — TWO independent groups, not one three-way group.
// Plain uint8_t + #defines instead of an enum — Arduino's IDE auto-generates
// function prototypes and inserts them near the TOP of the file, before any
// enum defined later in the sketch, which breaks compilation ("was not
// declared in this scope"). uint8_t is a built-in type, so this sidesteps
// that entirely.
//
//   Group 1 (A vs B): PV vs battery as the LOCAL SOURCE. Hard mutual
//     exclusion — both are bare relay connections with no diode, so two
//     closed together really would be two regulated sources fighting.
//   Group 2 (C vs D): export vs import at the TIE POINT. Hard mutual
//     exclusion with EACH OTHER — they share the tie point. Fully
//     independent of Group 1: D can close while B is also closed.
//     D_RX is diode-isolated, so it can sit in parallel with the battery
//     safely — it only conducts while its own ~12.6V output is above the
//     battery's current voltage, and stops on its own once the battery
//     rises to meet it. That's what lets the shared bus trickle-charge the
//     battery (via INA #1, which already reads net current and will show
//     this as charging current with no code changes needed there).
// ---------------------------------------------------------------------
#define SRC_NONE   0
#define SRC_PV     1
#define SRC_BATT   2
typedef uint8_t LocalSource;

#define TIE_NONE 0
#define TIE_TX   1
#define TIE_RX   2
typedef uint8_t TieRelay;

LocalSource activeSource = SRC_NONE;
unsigned long sourceOpenedAt = 0;

TieRelay activeTie = TIE_NONE;
unsigned long tieOpenedAt = 0;
unsigned long tieClosedSince = 0;   // when activeTie last went NONE->(TX or RX), for TX's min-closed check

void hwSet(int pin, bool closed) { digitalWrite(pin, closed ? LOW : HIGH); }

void applyLocalSourceCoordinator(uint8_t desired) {
  unsigned long now = millis();
  if (desired == activeSource) return;

  if (activeSource != SRC_NONE) {
    if (activeSource == SRC_PV)   { hwSet(PIN_RELAY_PV, false);   Serial.printf("[Node %d] Relay A (PV) open\n", NODE_ID); }
    if (activeSource == SRC_BATT) { hwSet(PIN_RELAY_BATT, false); Serial.printf("[Node %d] Relay B (battery) open\n", NODE_ID); }
    activeSource = SRC_NONE;
    sourceOpenedAt = now;
    return;
  }

  if (desired == SRC_NONE) return;

  if ((now - sourceOpenedAt) >= RELAY_DEADTIME_MS) {
    if (desired == SRC_PV)   { hwSet(PIN_RELAY_PV, true);   Serial.printf("[Node %d] Relay A (PV) closed\n", NODE_ID); }
    if (desired == SRC_BATT) { hwSet(PIN_RELAY_BATT, true); Serial.printf("[Node %d] Relay B (battery) closed\n", NODE_ID); }
    activeSource = desired;
  }
}

void applyTieCoordinator(uint8_t desired) {
  unsigned long now = millis();
  if (desired == activeTie) return;

  if (activeTie != TIE_NONE) {
    if (activeTie == TIE_TX) { hwSet(PIN_RELAY_TX, false); Serial.printf("[Node %d] Relay C (export) open\n", NODE_ID); }
    if (activeTie == TIE_RX) { hwSet(PIN_RELAY_RX, false); Serial.printf("[Node %d] Relay D (import) open\n", NODE_ID); }
    activeTie = TIE_NONE;
    tieOpenedAt = now;
    return;
  }

  if (desired == TIE_NONE) return;

  if ((now - tieOpenedAt) >= RELAY_DEADTIME_MS) {
    if (desired == TIE_TX) { hwSet(PIN_RELAY_TX, true); Serial.printf("[Node %d] Relay C (export) closed\n", NODE_ID); }
    if (desired == TIE_RX) { hwSet(PIN_RELAY_RX, true); Serial.printf("[Node %d] Relay D (import) closed\n", NODE_ID); }
    activeTie = desired;
    tieClosedSince = now;
  }
}

// ---------------------------------------------------------------------
// Want-latches: timing decided here, coordinator above just obeys.
// ---------------------------------------------------------------------
bool txWantsClosed = false;
bool rxWantsClosed = false;

void updateTXWant(bool eligible, bool forceImmediateOpen) {
  unsigned long now = millis();
  if (forceImmediateOpen) { txWantsClosed = false; return; }
  if (eligible) {
    txWantsClosed = true;
  } else if (txWantsClosed && activeTie == TIE_TX && (now - tieClosedSince) >= TX_MIN_CLOSED_MS) {
    txWantsClosed = false;
  } else if (txWantsClosed && activeTie != TIE_TX) {
    txWantsClosed = false;   // not actually closed yet — no reason to hold the want
  }
}

void updateRXWant(bool eligible, bool forceImmediateOpen) {
  // importBusOk already carries its own close/open hysteresis (below),
  // so no extra minimum-time logic needed here.
  if (forceImmediateOpen) { rxWantsClosed = false; return; }
  rxWantsClosed = eligible;
}

// ---------------------------------------------------------------------
// PV health latch
// ---------------------------------------------------------------------
bool pvHealthy = true;
bool pvBadCondLatched = false; unsigned long pvBadCondSince = 0;
bool pvGoodCondLatched = false; unsigned long pvGoodCondSince = 0;

void updatePVHealth(float pvRailV) {
  unsigned long now = millis();
  if (pvRailV < PV_INSUFFICIENT_V) {
    if (!pvBadCondLatched) { pvBadCondSince = now; pvBadCondLatched = true; }
    if (now - pvBadCondSince >= PV_INSUFFICIENT_HOLD_MS) pvHealthy = false;
  } else pvBadCondLatched = false;

  if (pvRailV >= PV_RECOVERED_V) {
    if (!pvGoodCondLatched) { pvGoodCondSince = now; pvGoodCondLatched = true; }
    if (now - pvGoodCondSince >= PV_RECOVERED_HOLD_MS) pvHealthy = true;
  } else pvGoodCondLatched = false;
}

// ---------------------------------------------------------------------
// Import bus-availability latch
// ---------------------------------------------------------------------
bool importBusOk = false;
bool busOkCondLatched = false; unsigned long busOkCondSince = 0;
bool busLowCondLatched = false; unsigned long busLowCondSince = 0;

void updateImportBusOk(float busV) {
  unsigned long now = millis();
  if (busV >= IMPORT_BUS_OK_V) {
    if (!busOkCondLatched) { busOkCondSince = now; busOkCondLatched = true; }
    if (now - busOkCondSince >= IMPORT_BUS_OK_HOLD_MS) importBusOk = true;
  } else busOkCondLatched = false;

  if (busV < IMPORT_BUS_LOW_V) {
    if (!busLowCondLatched) { busLowCondSince = now; busLowCondLatched = true; }
    if (now - busLowCondSince >= IMPORT_BUS_LOW_HOLD_MS) importBusOk = false;
  } else busLowCondLatched = false;
}

// ---------------------------------------------------------------------
// SOC hysteresis latches
// ---------------------------------------------------------------------
bool deficitLatched = false;
bool surplusLatched = false;
void updateSOCLatches(float soc) {
  if (soc <= DEFICIT_ENTER_PCT) deficitLatched = true;
  if (soc >= DEFICIT_EXIT_PCT)  deficitLatched = false;
  if (soc >= SURPLUS_ENTER_PCT) surplusLatched = true;
  if (soc <= SURPLUS_EXIT_PCT)  surplusLatched = false;
}

// ---------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------
bool safetyCondLatched = false; unsigned long safetyCondSince = 0;
unsigned long globalLockoutUntil = 0;
bool checkSafetyTrip(float iBattery, float iPV, float iBus) {
  unsigned long now = millis();
  bool over = fabs(iBattery) > SAFETY_CURRENT_A || fabs(iPV) > SAFETY_CURRENT_A || fabs(iBus) > SAFETY_CURRENT_A;
  if (over) {
    if (!safetyCondLatched) { safetyCondSince = now; safetyCondLatched = true; }
    if (now - safetyCondSince >= SAFETY_HOLD_MS) return true;
  } else safetyCondLatched = false;
  return false;
}

// ---------------------------------------------------------------------
// setup / loop
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n[Node %d] booting (I2C/INA226 firmware, restored)\n", NODE_ID);

  digitalWrite(PIN_RELAY_PV, HIGH);
  digitalWrite(PIN_RELAY_BATT, HIGH);
  digitalWrite(PIN_RELAY_TX, HIGH);
  digitalWrite(PIN_RELAY_RX, HIGH);
  pinMode(PIN_RELAY_PV, OUTPUT);
  pinMode(PIN_RELAY_BATT, OUTPUT);
  pinMode(PIN_RELAY_TX, OUTPUT);
  pinMode(PIN_RELAY_RX, OUTPUT);
  digitalWrite(PIN_RELAY_PV, HIGH);
  digitalWrite(PIN_RELAY_BATT, HIGH);
  digitalWrite(PIN_RELAY_TX, HIGH);
  digitalWrite(PIN_RELAY_RX, HIGH);
  activeSource = SRC_NONE;
  sourceOpenedAt = millis();
  activeTie = TIE_NONE;
  tieOpenedAt = millis();

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);
  bool ok = true;
  ok &= inaBattery.begin();
  ok &= inaPV.begin();
  ok &= inaBus.begin();
  if (!ok) Serial.println("WARNING: one or more INA226 failed to initialize");

  loadSOC();
  Serial.printf("[Node %d] Loaded SOC = %.1f%% (enter a fresh value with: SOC <percent>)\n", NODE_ID, soc_pct);

  telemetryInit();
}

void loop() {
  static unsigned long lastLog = 0, lastSave = 0;
  static bool fullChargeCondLatched = false;
  static unsigned long fullChargeCondSince = 0;
  unsigned long now = millis();

  handleSerialCommands();

  float vBattery = inaBattery.readBusVoltage();
  float iBattery = inaBattery.readCurrent();     // NET current: + charging, - discharging
  float vPV      = inaPV.readBusVoltage();       // post-buck PV rail
  float iPV      = inaPV.readCurrent();
  float vBus     = inaBus.readBusVoltage();
  float iBus     = inaBus.readCurrent();

  if (isnan(vBattery) || isnan(iBattery) || isnan(vPV) || isnan(iPV) || isnan(vBus) || isnan(iBus)) {
    Serial.println("I2C read failure — opening all relays as a precaution");
    updateTXWant(false, true);
    updateRXWant(false, true);
    applyTieCoordinator(TIE_NONE);
    applyLocalSourceCoordinator(SRC_NONE);
    delay(200);
    return;
  }

  updateSOCDrift(iBattery);
  updateSOCLatches(soc_pct);
  updatePVHealth(vPV);
  updateImportBusOk(vBus);

  // Full-charge detection
  if (vBattery >= FULL_CHARGE_V && iBattery > 0 && iBattery < FULL_CHARGE_I_A) {
    if (!fullChargeCondLatched) { fullChargeCondSince = now; fullChargeCondLatched = true; }
    if (now - fullChargeCondSince >= FULL_CHARGE_HOLD_MS && soc_pct < 100.0f) {
      soc_pct = 100.0f;
      Serial.printf("[Node %d] Full charge detected -> SOC = 100%%\n", NODE_ID);
    }
  } else fullChargeCondLatched = false;

  // Safety trip
  if (checkSafetyTrip(iBattery, iPV, iBus)) {
    if (now >= globalLockoutUntil) Serial.printf("[Node %d] SAFETY TRIP — opening all relays for 60s\n", NODE_ID);
    globalLockoutUntil = now + SAFETY_LOCKOUT_MS;
  }
  bool inLockout = (now < globalLockoutUntil);

  bool deficit = deficitLatched;   // SOC <=20%, hysteresis release at 25%
  bool battOk = vBattery > BATTERY_CRITICAL_V;   // hardware-truth guard, independent of hand-entered SOC

  // --- Group 2 eligibility computed first now, because Group 1's choice
  // depends on it: export forces the local source to BATTERY. ---
  bool importEligible = !inLockout && !pvHealthy && deficit && importBusOk;
  bool exportEligible = !inLockout && surplusLatched;

  // --- Group 1: local source, PV vs battery only. ---
  // Export FORCES battery as the local source (and takes priority over PV
  // health) — Relay C is now wired before the TX converter (TX's input is
  // no longer permanently hot off the local bus), so whatever is live on
  // the local bus at the moment Relay C closes is what feeds TX's startup
  // surge. Bench testing showed PV alone collapses under that surge while
  // the battery handles it without even a blip, so exporting must always
  // be battery-fed, never PV-fed. This only engages while battOk is true —
  // if the battery's own voltage doesn't back up a claimed-surplus SOC,
  // we do NOT force it onto the bus; see the TIE_TX guard below, which
  // then correctly withholds export entirely rather than risk a bad cell.
  LocalSource desiredSource;
  if (inLockout) {
    desiredSource = SRC_NONE;
  } else if (exportEligible && battOk) {
    desiredSource = SRC_BATT;
  } else if (pvHealthy) {
    desiredSource = SRC_PV;
  } else if (battOk) {
    desiredSource = SRC_BATT;
  } else {
    // PV insufficient AND battery at/below critical voltage — nothing safe
    // to select locally. Import (below) can still charge the battery even
    // while no local source is selected, via D_RX's diode.
    desiredSource = SRC_NONE;
  }

  updateRXWant(importEligible, inLockout);
  updateTXWant(exportEligible, inLockout);

  uint8_t desiredTie = TIE_NONE;
  if (rxWantsClosed) desiredTie = TIE_RX;
  else if (txWantsClosed) {
    // Don't actually close Relay C until the local-source coordinator has
    // CONFIRMED the switch to battery (activeSource, not just desiredSource).
    // This is what sequences things correctly: open A (if it was closed) ->
    // Group 1's own 2s deadtime -> close B -> only then is TX's input (now
    // behind Relay C) allowed to power up from a battery-fed bus. If the
    // battery can't be confirmed (battOk false despite a high hand-entered
    // SOC), activeSource never becomes SRC_BATT, so export is withheld
    // entirely instead of forcing a questionable battery onto the bus.
    desiredTie = (activeSource == SRC_BATT) ? TIE_TX : TIE_NONE;
  }

  applyLocalSourceCoordinator(desiredSource);
  applyTieCoordinator(desiredTie);

  if (now - lastSave > 30000UL) { saveSOC(); lastSave = now; }

  if (now - lastLog > 2000UL) {
    const char *srcName = activeSource == SRC_PV ? "PV" : activeSource == SRC_BATT ? "BATTERY" : "NONE";
    const char *tieName = activeTie == TIE_TX ? "EXPORT" : activeTie == TIE_RX ? "IMPORT" : "none";
    Serial.printf(
      "[Node %d] Src=%s Tie=%s SOC=%.1f%% Vbat=%.2fV Ibat=%.3fA Vpv=%.2fV Ipv=%.3fA Vbus=%.2fV Ibus=%.3fA PVok=%s Lockout=%s\n",
      NODE_ID, srcName, tieName, soc_pct, vBattery, iBattery, vPV, iPV, vBus, iBus,
      pvHealthy ? "Y" : "N", inLockout ? "Y" : "N"
    );
    lastLog = now;
  }

  // --- ADDED: Serial-Plotter-friendly line (Arduino IDE 2.x "label:value"
  // format, comma-separated). Printed every loop (~10Hz, matching the
  // existing delay(100) below) for smooth curves. Purely additive — does
  // not read, write, or affect any existing variable or control decision.
  Serial.print("Vbat:");  Serial.print(vBattery, 2);
  Serial.print(",Ibat:"); Serial.print(iBattery, 3);
  Serial.print(",Vpv:");  Serial.print(vPV, 2);
  Serial.print(",Ipv:");  Serial.print(iPV, 3);
  Serial.print(",Vbus:"); Serial.print(vBus, 2);
  Serial.print(",Ibus:"); Serial.print(iBus, 3);
  Serial.print(",SOC:");  Serial.print(soc_pct, 1);
  Serial.println();

  // --- ADDED: Non-blocking telemetry update (4 lines from telemetry.h) ---
  const char *telSrc = activeSource == SRC_PV ? "PV" : activeSource == SRC_BATT ? "BATTERY" : "NONE";
  const char *telTie = activeTie == TIE_TX ? "EXPORT" : activeTie == TIE_RX ? "IMPORT" : "NONE";
  telemetryUpdate(NODE_ID, telSrc, telTie, soc_pct, vBattery, iBattery, vPV, iPV, vBus, iBus, pvHealthy, inLockout, importBusOk);

  delay(100);
}
