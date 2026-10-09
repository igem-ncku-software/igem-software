// =========================================================
// CAPTURE-Screen firmware, 3D-printed build -- serves the LasReader website
//
// The 3D-printed reader: a 3D-printed optical core on a base plate, the
// electronics on a breadboard beside it (source, CAD and parts list in the
// team's capture-screen-hardware repository).
//   Excitation: Cree C503B-BCN 470 nm, 2N7000 low-side switch on GPIO 25
//               (R2 217 ohm to the gate, R3 9.9 kohm gate to ground),
//               R1 one 220-ohm resistor (217 ohm measured) since 2026-10-03
//   Detector:   DFRobot SEN0365 (AS7341, I2C 0x39), no emission filter
//   Controller: ESP32-WROOM-32 DOIT DevKit V1, 30-pin
//   No display and no button.
//
// It speaks exactly the protocol of firmware/capture_screen (the laser-cut
// build), so every page works with either reader; one is used at a time.
// This sketch is that one with the OLED and the button taken out, this
// build's sensor settings and identity, and two changes of its own:
//   - reads refuse until LED_CURRENT_MA holds a measured value (section 1);
//   - nothing is sent and the link isn't serviced during a read (section 4).
// The circuit is unchanged from the serial-command firmware this build ran
// before, which kept the radio off because a Wi-Fi transmit burst
// (200-300 mA) can pull on the VIN rail that also feeds the LED branch.
//
// Sections: 1 configuration, 2 sensor, 3 backend link, 4 controller (the only
// code that drives the LED), 5 Serial diagnostics, 6 setup / loop.
//
// Libraries: DFRobot_AS7341, ArduinoJson 7, WebSockets (Markus Sattler /
// Links2004). Wi-Fi credentials go in secrets.h (gitignored): copy
// secrets.h.example.
// =========================================================

// ---- Include order: networking first, sensor second ----
// DFRobot_AS7341.h has `#define ERR_OK 0`, and the ESP32's lwIP (err.h, via
// WiFi.h) has an enum member with the same name. If DFRobot's header came
// first it would turn `ERR_OK = 0,` into `0 = 0,` and the enum would fail to
// compile, so it goes last and its macro is removed right after.
#include <WiFi.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

#include <Wire.h>
#include <DFRobot_AS7341.h>

#ifdef ERR_OK
#undef ERR_OK
#endif

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h not found: copy firmware/capture_screen_3d/secrets.h.example to secrets.h and fill in your Wi-Fi credentials"
#endif
#if !defined(WIFI_SSID) || !defined(WIFI_PASSWORD)
  #error "secrets.h must define WIFI_SSID and WIFI_PASSWORD"
#endif

// =========================================================
// 1. Configuration
//
// BUILD_ID, LED_CURRENT_MA and the three sensor settings feed the website's
// config fingerprint: changing any of them makes every saved calibration
// curve stale. There is no firmware version number; when a change alters the
// reading path itself, stale the curves on purpose by changing BUILD_ID.
// BUILD_ID differs from the laser-cut build's, so a curve made on one reader
// never converts the other's readings.
// =========================================================

// ---- Backend: defaults to the production backend on Render; secrets.h can override ----
#ifndef BACKEND_HOST
#define BACKEND_HOST "igem-ncku-software.onrender.com"
#endif
#ifndef BACKEND_PORT
#define BACKEND_PORT 443
#endif
#ifndef BACKEND_USE_TLS
#define BACKEND_USE_TLS 1
#endif
#define BACKEND_PATH "/api/hardware/device"

// ---- Identity: sent unchanged in every status and measurement ----
#define DEVICE_ID        "capture-screen-3d"
#define BUILD_ID         "3D-V2-01"

// The LED current through R1, in mA, measured on the bench: the voltage across
// R1 while the LED is lit (switch Live on), divided by R1's resistance. The
// firmware can't read it back. 0 means "not measured yet": the status then
// reports 0.000 and every read is refused with led_current_unmeasured, so no
// calibration curve can be bound to a placeholder. Live still works, which is
// how the LED is kept lit for the measurement.
#define LED_CURRENT_MA   0.0f

// ---- Pins ----
const int LED_PIN = 25;             // the 2N7000's gate through R2; R3 holds it off during boot
const int I2C_SDA = 21;
const int I2C_SCL = 22;

const uint8_t AS7341_ADDR = 0x39;

// ---- Sensor settings at boot (Serial g/t/s change them at runtime) ----
// The settings this build ran with under its serial-command firmware.
// Full scale = (ATIME+1)(ASTEP+1), capped at 65535; integration time = that
// x 2.78 us. These give full scale 65535 and ~200 ms; one ten-channel read
// (two SMUX cycles) takes ~0.5 s.
const uint8_t  DEFAULT_AGAIN_CODE = 10;   // register index 0..10 -> 0.5x .. 512x
const uint8_t  DEFAULT_ATIME      = 255;
const uint16_t DEFAULT_ASTEP      = 280;

// ---- Timing ----
const unsigned long DARK_SETTLE_MS      = 50;      // after switching the LED off
const unsigned long LIGHT_SETTLE_MS     = 100;     // after switching the LED on
// A measurement's MEASURING status is the last thing sent before its first
// dark read; this wait gives that transmission time to finish first.
const unsigned long TX_QUIET_MS         = 100;
const unsigned long LIVE_PERIOD_MS      = 500;     // minimum period between live frames
// Live switches itself off after this long: continuous excitation heats and
// bleaches the sample.
const unsigned long LIVE_AUTO_OFF_MS    = 10UL * 60UL * 1000UL;
const unsigned long STATUS_INTERVAL_MS  = 5000;    // the backend marks the device offline after 15 s of silence
const unsigned long SENSOR_CHECK_MS     = 2000;    // re-confirm the AS7341 still answers on the bus
const unsigned long WIFI_BOOT_WAIT_MS   = 10000;   // setup() waits this long, then loop() keeps trying
const unsigned long RECONNECT_MS        = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;   // catches a connection that died without a close
const unsigned long WS_PONG_TIMEOUT_MS  = 10000;
const uint8_t       WS_MISSED_PONGS     = 2;
const unsigned long WAITING_LOG_MS      = 10000;   // Serial reminder while the backend is unreachable

// ---- Types: must come before the first function definition ----
// Arduino generates a prototype for every function and inserts them above
// the first function definition in the file. A struct or enum defined after
// that point is invisible to those prototypes, and the whole sketch fails
// with "'Frame' was not declared in this scope".
struct Frame { uint16_t ch[10]; };        // F1..F8, CLR, NIR: raw ADC counts, never processed here
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

const char* const CH_NAME[10] = {"F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "CLR", "NIR"};
const uint8_t CH_F4 = 3;                  // the sfGFP band

bool ledCurrentMeasured() { return LED_CURRENT_MA > 0.0f; }

// =========================================================
// 2. Sensor: the AS7341 and the I2C bus
// =========================================================

static DFRobot_AS7341 as7341;
static bool sensorPresent = false;
static uint8_t  gainCode = DEFAULT_AGAIN_CODE;
static uint8_t  atime    = DEFAULT_ATIME;
static uint16_t astep    = DEFAULT_ASTEP;

// The SEN0365 board carries its own illumination LED, driven by the AS7341.
// It is switched off whenever the sensor is (re)configured: lit, it would add
// to every reading, dark ones included.
static void applySettings() {
  as7341.enableLed(false);
  as7341.setAtime(atime);
  as7341.setAstep(astep);
  as7341.setAGAIN(gainCode);
}

bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void i2cScan() {
  Serial.print("# I2C scan:");
  uint8_t n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    if (!i2cPresent(a)) continue;
    Serial.printf(" 0x%02X", a);
    if (a == AS7341_ADDR) Serial.print("(AS7341)");
    n++;
  }
  if (n == 0) Serial.print(" no device answered -- check SDA/SCL/VCC/GND");
  Serial.println();
}

// Presence is judged by the I2C ACK, never by the reading: with the LED off
// every channel reads 0, which is a normal dark.
bool sensorBegin() {
  int rc = -99;
  for (uint8_t i = 0; i < 3 && !sensorPresent; i++) {
    sensorPresent = i2cPresent(AS7341_ADDR);
    if (sensorPresent) { rc = as7341.begin(); applySettings(); }
    else delay(300);
  }
  Serial.printf("# AS7341 @0x%02X  %s   begin() rc=%d\n",
                AS7341_ADDR, sensorPresent ? "OK" : "not responding", rc);
  return sensorPresent;
}

bool sensorOk() { return sensorPresent; }

// sensorPresent has to mean "answering now", not "answered at boot": a sensor
// knocked loose mid-session would otherwise leave every page saying it is fine
// while each read returns nonsense. A sensor that comes back is re-begun,
// because a power-cycled AS7341 wakes with its registers at defaults, not ours.
bool sensorCheck() {
  bool present = i2cPresent(AS7341_ADDR);
  if (present == sensorPresent) return false;
  sensorPresent = present;
  if (sensorPresent) {
    as7341.begin();
    applySettings();
    Serial.println("# AS7341 back on the bus, re-configured");
  } else {
    Serial.println("# AS7341 stopped responding");
  }
  return true;
}

// The AS7341 reads six channels per SMUX cycle, so ten take two. CLR and NIR
// appear in both; the first cycle's values are kept. Nothing else runs in
// between: on this build the link is left alone for the whole read (section 4).
void sensorRead(Frame &f) {
  as7341.startMeasure(DFRobot_AS7341::eF1F4ClearNIR);
  DFRobot_AS7341::sModeOneData_t d1 = as7341.readSpectralDataOne();
  f.ch[0] = d1.ADF1; f.ch[1] = d1.ADF2; f.ch[2] = d1.ADF3; f.ch[3] = d1.ADF4;
  f.ch[8] = d1.ADCLEAR; f.ch[9] = d1.ADNIR;

  as7341.startMeasure(DFRobot_AS7341::eF5F8ClearNIR);
  DFRobot_AS7341::sModeTwoData_t d2 = as7341.readSpectralDataTwo();
  f.ch[4] = d2.ADF5; f.ch[5] = d2.ADF6; f.ch[6] = d2.ADF7; f.ch[7] = d2.ADF8;
}

uint8_t  sensorGainCode() { return gainCode; }
uint8_t  sensorAtime()    { return atime; }
uint16_t sensorAstep()    { return astep; }

bool sensorSetGainCode(long code) {
  if (code < 0 || code > 10) return false;
  gainCode = code;
  if (sensorPresent) applySettings();
  return true;
}

bool sensorSetAtime(long value) {
  if (value < 0 || value > 255) return false;
  atime = value;
  if (sensorPresent) applySettings();
  return true;
}

bool sensorSetAstep(long value) {
  if (value < 1 || value > 65535) return false;
  astep = value;
  if (sensorPresent) applySettings();
  return true;
}

float sensorGainMultiplier() { return 0.5f * (1 << gainCode); }   // 0 -> 0.5x, 10 -> 512x

const char* sensorGainName() {
  static const char* const NAMES[] = {"0.5x", "1x", "2x", "4x", "8x", "16x", "32x", "64x", "128x", "256x", "512x"};
  return NAMES[gainCode <= 10 ? gainCode : 10];
}

uint32_t sensorFullScale() {
  uint32_t fs = (uint32_t)(atime + 1) * (uint32_t)(astep + 1);
  return fs > 65535UL ? 65535UL : fs;
}

float sensorIntegrationMs() { return (atime + 1.0f) * (astep + 1.0f) * 2.78e-3f; }

// =========================================================
// 3. Backend link: Wi-Fi and the WebSocket
//
// The device dials out to wss://<BACKEND_HOST>/api/hardware/device and keeps
// that connection open: the backend on Render cannot reach into a lab or
// home router. Every page reaches the device through the backend.
//
// ---- Protocol: the same as firmware/capture_screen (field names are a
//      contract across both firmwares, backend/app/hardware/models.py,
//      backend/app/live/models.py, and frontend/js/hardware_processing.js --
//      change all of them together or none) ----
// Device -> backend
//   {"mode":"status", ...}       on connect, on every change, and every 5 s;
//                                 carries sensor_ok, live_on, live_off_in_s, led_on
//   {"mode":"live", ...}         one frame after another while Live is on;
//                                 "led" says whether the LED was lit for it
//   {"mode":"measurement", ...}  after a "read": dark_1 -> light -> dark_2
//   {"mode":"error", ...}        a read could not run: busy / sensor_offline /
//                                 led_current_unmeasured (this build only)
// Backend -> device
//   {"cmd":"live_start"} / {"cmd":"live_stop"}   a page flipped its Live switch
//   {"cmd":"led_on"} / {"cmd":"led_off"}         a page flipped its LED switch
//   {"cmd":"read","request_id":"..."}            take one reading
//
// Everything sent is unprocessed integer ADC counts: dark subtraction,
// normalization, unmixing and the 4PL fit all happen in the browser.
//
// TLS skips certificate validation (WebSockets 2.7.2 calls setInsecure() on
// ESP32 when no CA is given). The connection is not authenticated yet.
// =========================================================

static WebSocketsClient ws;
static bool wifiUp = false;
static bool wsStarted = false;           // started once, but only after Wi-Fi is actually up
static bool backendUp = false;
static unsigned long lastStatusMs = 0, lastWaitLogMs = 0;

// ---- Outgoing ---------------------------------------------------------

static void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
}

// The format is part of the fingerprint contract: the website hashes
// Number(led_current_mA).toFixed(3) and String(gain), so the current goes out
// as a fixed 3-decimal string (a raw float would become 9.9989999...) and the
// gain as an integer whenever it is one (only 0.5x isn't).
static void addConfig(JsonObject c) {
  c["led_current_mA"] = serialized(String(LED_CURRENT_MA, 3));
  if (sensorGainCode() == 0) c["gain"] = serialized(String("0.5"));
  else                       c["gain"] = (uint16_t)sensorGainMultiplier();
  c["atime"] = sensorAtime();
  c["astep"] = sensorAstep();
}

static void addFrame(JsonObject o, const Frame &f) {
  for (uint8_t c = 0; c < 10; c++) o[CH_NAME[c]] = f.ch[c];
}

static void sendJson(JsonDocument &doc) {
  if (!backendUp) return;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

void linkSendStatus() {
  lastStatusMs = millis();
  JsonDocument doc;
  doc["mode"] = "status";
  addIdentity(doc);
  doc["state"]     = ctrlStateName();
  doc["uptime_ms"] = millis();
  doc["wifi_rssi"] = WiFi.RSSI();
  // Without it a dead sensor is silent: Live just never streams.
  doc["sensor_ok"] = sensorOk();
  // The one Live switch every page shares (section 4).
  doc["live_on"]   = ctrlLiveOn();
  long offIn = ctrlLiveOffInS();
  if (offIn >= 0) doc["live_off_in_s"] = offIn;
  else            doc["live_off_in_s"] = nullptr;
  // The LED switch within Live (section 4); only meaningful while live_on.
  doc["led_on"]    = ctrlLedWanted();
  addConfig(doc["config"].to<JsonObject>());
  sendJson(doc);
}

void linkSendLive(const Frame &f, uint32_t seq, uint32_t tMs, bool lit) {
  JsonDocument doc;
  doc["mode"] = "live";
  doc["seq"] = seq;
  doc["t_ms"] = tMs;
  doc["led"] = lit;                      // false: a dark / ambient frame
  addFrame(doc["raw"].to<JsonObject>(), f);
  sendJson(doc);
}

void linkSendMeasurement(const char *requestId, uint32_t readMs,
                         const Frame &dark1, const Frame &light, const Frame &dark2) {
  JsonDocument doc;
  doc["mode"] = "measurement";
  doc["request_id"] = requestId;
  addIdentity(doc);
  doc["uptime_ms"] = millis();
  doc["read_time_ms"] = readMs;
  addConfig(doc["config"].to<JsonObject>());
  addFrame(doc["dark_1"].to<JsonObject>(), dark1);
  addFrame(doc["light"].to<JsonObject>(), light);
  addFrame(doc["dark_2"].to<JsonObject>(), dark2);
  sendJson(doc);
}

void linkSendError(const char *requestId, const char *error) {
  JsonDocument doc;
  doc["mode"] = "error";
  doc["request_id"] = requestId;
  doc["error"] = error;
  sendJson(doc);
}

// ---- Incoming (inside ws.loop(): hand to the controller, never act here) ----

static void handleCommand(uint8_t *payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  const char *cmd = doc["cmd"] | "";

  if (strcmp(cmd, "live_start") == 0)     ctrlWebLive(true);
  else if (strcmp(cmd, "live_stop") == 0) ctrlWebLive(false);
  else if (strcmp(cmd, "led_on") == 0)    ctrlWebLed(true);
  else if (strcmp(cmd, "led_off") == 0)   ctrlWebLed(false);
  else if (strcmp(cmd, "read") == 0)      ctrlWebRead(doc["request_id"] | "");
}

static void onBackendEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      backendUp = true;
      Serial.printf("[backend] connected to %s:%d%s\n", BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
      linkSendStatus();
      break;
    case WStype_DISCONNECTED:
      if (backendUp) Serial.println("[backend] disconnected, reconnecting");
      backendUp = false;
      ctrlBackendLost();
      break;
    case WStype_ERROR:
      Serial.print("[backend] error ");
      if (length) Serial.write(payload, length);
      Serial.println();
      break;
    case WStype_TEXT:
      handleCommand(payload, length);
      break;
    default:
      break;
  }
}

// ---- Connection ---------------------------------------------------------

// A bad password must not brick the sketch: setup() waits briefly, then
// linkService() keeps trying from loop(), and the Serial diagnostics still run.
void linkBegin() {
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // power saving adds latency and slows the stream
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_BOOT_WAIT_MS) delay(200);
  if (WiFi.status() != WL_CONNECTED)
    Serial.println("[wifi] not connected yet, still trying; the backend link starts once it connects");
  linkService();
}

void linkService() {
  bool now = WiFi.status() == WL_CONNECTED;
  if (now != wifiUp) {
    wifiUp = now;
    if (wifiUp) { Serial.print("[wifi] connected, IP "); Serial.println(WiFi.localIP()); }
    else        Serial.println("[wifi] disconnected, reconnecting");
  }

  if (wifiUp && !wsStarted) {
    wsStarted = true;
    Serial.printf("[backend] connecting to %s:%d%s\n", BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
#if BACKEND_USE_TLS
    ws.beginSSL(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
#else
    ws.begin(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
#endif
    ws.onEvent(onBackendEvent);
    ws.setReconnectInterval(RECONNECT_MS);
    ws.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, WS_MISSED_PONGS);
  }
  if (wsStarted) ws.loop();

  if (backendUp && millis() - lastStatusMs >= STATUS_INTERVAL_MS) linkSendStatus();

  // Bad Wi-Fi password, wrong host, wrong TLS setting, or a sleeping backend.
  if (!backendUp && millis() - lastWaitLogMs >= WAITING_LOG_MS) {
    lastWaitLogMs = millis();
    Serial.printf("[backend] still connecting to %s:%d (Wi-Fi %s, RSSI %d dBm)\n",
                  BACKEND_HOST, BACKEND_PORT, wifiUp ? "up" : "down", WiFi.RSSI());
  }
}

// =========================================================
// 4. Controller: the one place that decides what the device does
//
// Web commands arrive inside ws.loop() and are only recorded; loop() applies
// them in order, and this section alone touches the LED.
//
// Live is ONE switch, owned here, shared by every web page:
//   - the web's live_start / live_stop set it (this build has no button)
//   - every change is reported at once in the status (live_on), which the
//     backend relays to every page, so all switches show the same state
//   - it switches itself off after LIVE_AUTO_OFF_MS
//   - it stays on across a backend disconnect; the auto-off bounds how long
//     the LED can be left on
//   - it cannot be switched on during a measurement or without the sensor;
//     a refused request still sends a status, so a page's switch flips back
//
// Within Live, the LED is a second switch (led_on / led_off). Off, Live keeps
// streaming dark / ambient counts. It is refused unless Live is on, and every
// Live start resets it to on. It is applied between reads, never during one,
// so no frame mixes lit and dark, and every frame carries the LED state it
// was read with.
//
// The radio stays on (the website needs it), so on this build the firmware
// keeps its own traffic out of the reads: a read doesn't service the link,
// and a measurement waits TX_QUIET_MS after its last send before the first
// dark read. The Wi-Fi stack can still answer the network by itself; whether
// that shows in the readings is checked on the bench (self-check's dark
// stability, repeated reads of one cuvette), not assumed.
//
// State (reported to the backend): IDLE / LIVE / MEASURING. LIVE follows the
// switch whenever no measurement runs, so a web read preempts streaming and
// streaming resumes afterwards on its own.
// =========================================================

static DeviceState state = STATE_IDLE;
static bool liveOn = false;
static unsigned long liveOnSince = 0;
static bool ledWanted = true;            // the LED switch within Live
static bool liveLit = false;             // what the LED is actually doing while LIVE
static unsigned long liveSettleMs = LIGHT_SETTLE_MS;
static bool statusDirty = false;

static bool readPending = false;         // a web "read" arrived and hasn't run yet
static char readRequestId[40] = "";

static uint32_t liveSeq = 0;
static unsigned long liveStartedMs = 0, lastLiveFrameMs = 0, lastSensorCheckMs = 0;

// The only writes to LED_PIN after setup().
static void ledSet(bool on) { digitalWrite(LED_PIN, on ? HIGH : LOW); }

static void setState(DeviceState next) {
  if (state == next) return;
  state = next;
  statusDirty = true;
}

static void flushStatus() {
  if (!statusDirty) return;
  statusDirty = false;
  linkSendStatus();                      // no-op while the backend is down; it gets one on connect
}

void ctrlMarkStatusDirty() { statusDirty = true; }

DeviceState ctrlState() { return state; }

const char* ctrlStateName() {
  switch (state) {
    case STATE_LIVE:      return "LIVE";
    case STATE_MEASURING: return "MEASURING";
    default:              return "IDLE";
  }
}

bool ctrlLiveOn() { return liveOn; }

bool ctrlLedWanted() { return ledWanted; }

long ctrlLiveOffInS() {
  if (!liveOn) return -1;
  unsigned long used = millis() - liveOnSince;
  return used >= LIVE_AUTO_OFF_MS ? 0 : (long)((LIVE_AUTO_OFF_MS - used + 999) / 1000);
}

// ---- The Live switch ----------------------------------------------------

// Always marks the status dirty, even when nothing changes or the request is
// refused: the page that asked has already flipped its switch and needs the
// device's answer to settle it.
void ctrlWebLive(bool on) {
  statusDirty = true;
  if (on == liveOn) return;
  if (on && state == STATE_MEASURING) { Serial.println("# Live refused: measurement running"); return; }
  if (on && !sensorOk())              { Serial.println("# Live refused: sensor not responding"); return; }
  liveOn = on;
  if (on) {
    liveOnSince = millis();
    ledWanted = true;                    // every Live starts lit
  }
  Serial.printf("# Live %s (web)\n", on ? "on" : "off");
}

// Answered like the Live switch: always a status, even when refused.
void ctrlWebLed(bool on) {
  statusDirty = true;
  if (!liveOn || on == ledWanted) return;
  ledWanted = on;
  Serial.printf("# Live LED %s (web)\n", on ? "on" : "off");
}

static void checkAutoOff() {
  if (!liveOn || millis() - liveOnSince < LIVE_AUTO_OFF_MS) return;
  liveOn = false;
  statusDirty = true;
  Serial.println("# Live off (auto-off)");
}

// Sets the LED for Live and restarts the settle wait, so the next frame is a
// clean one under the new state.
static void applyLiveLed() {
  liveLit = ledWanted;
  ledSet(liveLit);
  liveSettleMs = liveLit ? LIGHT_SETTLE_MS : DARK_SETTLE_MS;
  liveStartedMs = millis();
  lastLiveFrameMs = 0;
}

// Whether the LED streams depends on exactly three things: the switch, the
// sensor, and whether a measurement holds the LED.
static void syncLive() {
  bool should = liveOn && sensorOk() && state != STATE_MEASURING;
  if (should && state == STATE_IDLE) {
    applyLiveLed();
    setState(STATE_LIVE);
  } else if (should && state == STATE_LIVE && liveLit != ledWanted) {
    applyLiveLed();                      // between reads: loop() never gets here mid-read
  } else if (!should && state == STATE_LIVE) {
    ledSet(false);
    setState(STATE_IDLE);
  }
}

// Live is display-only: its frame goes out right after its read, so the next
// frame's read can overlap that transmission. Measurements are kept clear of it.
static void streamLiveFrame() {
  unsigned long now = millis();
  if (now - liveStartedMs < liveSettleMs) return;
  if (lastLiveFrameMs && now - lastLiveFrameMs < LIVE_PERIOD_MS) return;
  lastLiveFrameMs = now;                 // stamped before the read: the constant is a period, not a gap

  Frame f;
  sensorRead(f);
  // liveLit is what the LED did for this whole read: a web command arriving
  // meanwhile waits in the link until loop() services it.
  linkSendLive(f, ++liveSeq, now, liveLit);
}

// ---- Web measurement: dark_1 -> light -> dark_2 ---------------------------

void ctrlWebRead(const char *requestId) {
  if (!ledCurrentMeasured())                        linkSendError(requestId, "led_current_unmeasured");
  else if (!sensorOk())                             linkSendError(requestId, "sensor_offline");
  else if (state == STATE_MEASURING || readPending) linkSendError(requestId, "busy");
  else { strlcpy(readRequestId, requestId, sizeof(readRequestId)); readPending = true; }
}

void ctrlBackendLost() {
  readPending = false;                   // the backend has already given up on it
}

// The website averages the two darks to subtract and takes their difference
// as its read-noise estimate, so the light frame needs a dark on each side.
// The link isn't serviced from here to the end of dark_2: nothing the firmware
// sends can land inside a read. A command arriving meanwhile waits in the link.
static void measureForWeb(const char *requestId) {
  ledSet(false);
  setState(STATE_MEASURING);
  flushStatus();                         // pages should see MEASURING before the ~1.7 s it takes

  Frame dark1, light, dark2;
  unsigned long t0 = millis();

  delay(TX_QUIET_MS > DARK_SETTLE_MS ? TX_QUIET_MS : DARK_SETTLE_MS);
  sensorRead(dark1);

  ledSet(true);
  delay(LIGHT_SETTLE_MS);
  sensorRead(light);
  ledSet(false);

  delay(DARK_SETTLE_MS);
  sensorRead(dark2);

  unsigned long elapsed = millis() - t0;
  linkSendMeasurement(requestId, elapsed, dark1, light, dark2);
  Serial.printf("# web read %lums  light F3=%u F4=%u  dark F4=%u/%u\n",
                elapsed, light.ch[2], light.ch[CH_F4], dark1.ch[CH_F4], dark2.ch[CH_F4]);

  setState(STATE_IDLE);                  // syncLive() resumes streaming if Live is still on
}

// ---- Serial diagnostics -----------------------------------------------------

bool ctrlClaim() {
  if (state != STATE_IDLE || liveOn) return false;
  setState(STATE_MEASURING);             // a web read now gets "busy" instead of grabbing the LED
  flushStatus();
  return true;
}

void ctrlRelease() {
  ledSet(false);
  setState(STATE_IDLE);
}

void ctrlLed(bool on) {
  if (state == STATE_MEASURING) ledSet(on);
}

bool ctrlLedManual(bool on) {
  if (state != STATE_IDLE || liveOn) return false;
  ledSet(on);
  return true;
}

// ---- setup / loop -------------------------------------------------------

void ctrlBegin() {
  ledSet(false);
  lastSensorCheckMs = millis();
  statusDirty = true;
}

void ctrlLoop() {
  linkService();

  if (readPending) {
    readPending = false;
    // The command handler's sensor check is as old as the command: confirm now,
    // or a sensor lost since then yields a frame of nonsense.
    lastSensorCheckMs = millis();
    if (sensorCheck()) {
      statusDirty = true;
      if (!sensorOk()) liveOn = false;
    }
    if (sensorOk()) measureForWeb(readRequestId);
    else            linkSendError(readRequestId, "sensor_offline");
  }

  // Between whole reads, never inside one: loop() is sequential, so the bus is idle here.
  if (state != STATE_MEASURING && millis() - lastSensorCheckMs >= SENSOR_CHECK_MS) {
    lastSensorCheckMs = millis();
    if (sensorCheck()) {
      statusDirty = true;
      if (!sensorOk() && liveOn) {
        liveOn = false;                  // don't restart the LED by surprise when the wire is reseated
        Serial.println("# Live switched off: sensor not responding");
      }
    }
  }

  checkAutoOff();
  syncLive();
  flushStatus();

  if (state == STATE_LIVE) streamLiveFrame();
  flushStatus();
}

// =========================================================
// 5. Serial diagnostics (115200 baud)
//
// Troubleshooting only; every measurement is started by the website.
//   ?  current settings      i  I2C scan
//   l  toggle the LED        d  dark/light table
//   g<0-10> gain   t<0-255> ATIME   s<1-65535> ASTEP
// g/t/s feed the config fingerprint, so a status goes out right after each.
// =========================================================

const uint8_t DIAG_AVG = 8;     // reads averaged per column by 'd'

static void printSettings() {
  uint32_t fs = sensorFullScale();
  Serial.printf("# gain=%s atime=%u astep=%u  full scale=%lu  integration=%.1fms\n",
                sensorGainName(), sensorAtime(), sensorAstep(), (unsigned long)fs, sensorIntegrationMs());
  // A too-small full scale collapses every reading with no other symptom.
  if (fs < 10000)
    Serial.printf("# ** warning: full scale is only %lu; readings will be buried in quantization.\n"
                  "#    Normal settings are t255 s280 (full scale 65535, integration 200ms). **\n",
                  (unsigned long)fs);
  if (!ledCurrentMeasured())
    Serial.println("# ** LED current not measured: reads are refused until LED_CURRENT_MA is set. **");
}

static void printHelp() {
  Serial.println("# commands: ? settings  i I2C scan  l toggle LED  d dark/light table");
  Serial.println("#           g<0-10> gain   t<0-255> atime   s<1-65535> astep");
  Serial.println("# measurements and Live come from the website.");
}

// Shape is locked down: one lowercase letter, or a letter plus digits only.
// Reading just the first letter once turned "test1" into an ATIME of 0,
// dropping integration to 2.8 ms with no error at all.
static bool parseCommand(const String &s, char &c, long &v) {
  if (s.length() == 0) return false;
  c = s.charAt(0);
  String rest = s.substring(1);

  if (c == '?') return rest.length() == 0;
  switch (c) {
    case 'i': case 'l': case 'd':
      return rest.length() == 0;
    case 'g': case 't': case 's':
      if (rest.length() == 0) return false;   // a bare g/t/s must not silently set 0
      for (unsigned int i = 0; i < rest.length(); i++)
        if (!isDigit(rest.charAt(i))) return false;
      v = rest.toInt();
      return true;
    default:
      return false;
  }
}

static void darkLightTable() {
  Frame dk, lt;
  double sd[10] = {0}, sl[10] = {0};

  ctrlLed(false); delay(DARK_SETTLE_MS);
  for (uint8_t i = 0; i < DIAG_AVG; i++) { sensorRead(dk); for (uint8_t c = 0; c < 10; c++) sd[c] += dk.ch[c]; }
  ctrlLed(true);  delay(LIGHT_SETTLE_MS);
  for (uint8_t i = 0; i < DIAG_AVG; i++) { sensorRead(lt); for (uint8_t c = 0; c < 10; c++) sl[c] += lt.ch[c]; }
  ctrlLed(false);

  Serial.println("# channel  dark      light     diff");
  for (uint8_t i = 0; i < 10; i++) {
    double d = sd[i] / DIAG_AVG, l = sl[i] / DIAG_AVG;
    Serial.printf("#  %-4s %8.1f  %8.1f  %8.1f\n", CH_NAME[i], d, l, l - d);
  }
  Serial.println("#   both near 0          -> LED not lit (or the light path is blocked)");
  Serial.println("#   both large and close -> LED stuck on, not controlled by the GPIO");
  Serial.println("#   dark low, light high -> normal");
}

void diagBegin() {
  printSettings();
  printHelp();
}

void diagService() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  char c; long v = 0;
  if (!parseCommand(line, c, v)) { printHelp(); return; }

  switch (c) {
    case '?': printSettings(); return;
    case 'i': i2cScan(); return;
    case 'l': {
      static bool on = false;
      if (!ctrlLedManual(!on)) { Serial.printf("# state is %s%s; the LED is in use\n", ctrlStateName(), ctrlLiveOn() ? " with Live on" : ""); return; }
      on = !on;
      Serial.printf("# LED (GPIO%d) -> %s\n", LED_PIN, on ? "ON" : "OFF");
      return;
    }
    case 'd':
      if (!sensorOk()) { Serial.println("# sensor not responding"); return; }
      // Holds MEASURING, so a web read or a Live request can't take the LED meanwhile.
      if (!ctrlClaim()) { Serial.printf("# state is %s%s; switch Live off and try again\n", ctrlStateName(), ctrlLiveOn() ? " with Live on" : ""); return; }
      darkLightTable();
      ctrlRelease();
      return;
    case 'g': if (!sensorSetGainCode(v)) { Serial.println("# gain must be 0..10");      return; } break;
    case 't': if (!sensorSetAtime(v))    { Serial.println("# atime must be 0..255");    return; } break;
    case 's': if (!sensorSetAstep(v))    { Serial.println("# astep must be 1..65535");  return; } break;
    default: return;
  }
  printSettings();
  ctrlMarkStatusDirty();          // the settings feed the fingerprint: tell the website at once
}

// =========================================================
// 6. setup / loop
// =========================================================
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);            // excitation off before anything else

  Serial.begin(115200);
  Serial.printf("# CAPTURE-Screen %s (3D-printed build)  LED %.3f mA%s\n",
                BUILD_ID, LED_CURRENT_MA, ledCurrentMeasured() ? "" : " (not measured)");

  Wire.begin(I2C_SDA, I2C_SCL);
  i2cScan();
  sensorBegin();
  ctrlBegin();

  linkBegin();
  diagBegin();
}

void loop() {
  ctrlLoop();
  diagService();
  delay(1);
}
