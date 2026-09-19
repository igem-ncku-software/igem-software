// =========================================================
// CAPTURE-Screen firmware v6.0 -- only what the LasReader website needs
//
// This is P1-PROTO-01: a single-cuvette, 90-degree fluorescence reader.
//   Excitation: Cree C503B 470nm, 2N7000 low-side switch, 434-ohm current
//               limit, bench-measured 5.553 mA
//   Detector:   DFRobot SEN0365 (AS7341, I2C 0x39), 90-degree collection,
//               no emission filter fitted
//   Controller: ESP32-WROOM-32 DOIT DevKit V1
//   Display:    SSD1306 OLED (I2C 0x3C) -- local status only, not part of
//               any measurement
// There is no button. Every measurement is started by the website.
//
// There is exactly one workflow: boot -> connect Wi-Fi -> dial out to the
// backend's WebSocket
//   wss://<BACKEND_HOST>/api/hardware/device
// and keep that connection open (auto-reconnect on drop). The backend runs
// on Render, which cannot reach into a lab or home router, so the device
// must be the one that dials out. The website's live spectrum, on-demand
// reads, and calibration workflow all go through this one connection.
//
// ---- Protocol with the backend (field names are a contract across
//      backend/app/hardware/models.py, backend/app/live/models.py, and
//      frontend/js/hardware_processing.js -- change all three together or
//      none) ----
// Device -> backend
//   {"mode":"status", ...}       on connect, on every state change, and
//                                 every 5 s after that; carries sensor_ok, so
//                                 a page can tell "the AS7341 never answered"
//                                 apart from "the stream hasn't started yet"
//   {"mode":"live", ...}         one frame after another while someone is
//                                 watching the live spectrum
//   {"mode":"measurement", ...}  after a "read": one dark_1 -> light ->
//                                 dark_2 cycle (raw counts)
//   {"mode":"error", ...}        command could not run: busy / sensor_offline
// Backend -> device
//   {"cmd":"live_start"} / {"cmd":"live_stop"}   whether anyone is watching
//                                                 the live spectrum
//   {"cmd":"read","request_id":"..."}            take one reading
//
// The device only reads -- nothing is computed here. Dark subtraction,
// normalization, unmixing, and the 4PL fit all happen on the browser side
// (frontend/js/hardware_processing.js and hardware_local.js). What the
// firmware sends out is always unprocessed integer ADC counts.
//
// State machine: IDLE / LIVE / MEASURING. The LED is only on while someone
// is watching the live spectrum or a measurement is running: leaving it on
// continuously would heat and photobleach the sample in the cuvette. A
// measurement pauses streaming, and streaming resumes on its own afterward
// if someone is still watching. The LED is always off while disconnected
// from the backend.
//
// --- read this before changing anything ---
//
// 1. The include order cannot be reordered. DFRobot_AS7341.h has
//    `#define ERR_OK 0`, and the ESP32's lwIP (err.h) has an enum member
//    with the same name. If DFRobot's header comes before WiFi.h, it turns
//    `ERR_OK = 0,` into `0 = 0,` and the whole enum fails to compile.
//
// 2. The gain multiplier is computed from the register index, not kept as
//    a second constant that has to be updated by hand. Change one and
//    forget the other, and the website's config fingerprint silently stops
//    matching.
//
// 3. The config serialization format is part of the contract. The
//    website's fingerprint rule is `Number(led_current_mA).toFixed(3)` and
//    `String(gain)`, so the LED current must always go out as a fixed
//    3-decimal string, and gain must go out as an integer when it is one
//    (only 0.5x is the exception). Sending a raw float turns into
//    5.5529999..., the fingerprint stops matching, and every saved
//    calibration curve gets flagged stale.
//
// 4. During a measurement, pump() keeps the connection alive: it services
//    the WebSocket and still sends status on schedule. The WebSocket
//    callback only "records" a command (a read while measuring is
//    answered with busy right away); the actual measurement always runs
//    in loop(), so there is no concurrency and nothing needs a lock.
//
// 5. Sensor presence is judged by the I2C ACK, not by the reading. With
//    the lid closed and the LED off, every channel reads 0 -- that is a
//    normal dark state, not a disconnected sensor.
//
// 6. FIRMWARE_VERSION, BUILD_ID, gain, ATIME, ASTEP, and the LED current
//    all feed the website's config fingerprint. Changing any of them makes
//    every existing calibration curve stale -- that is intended whenever
//    the reading path itself changes.
//
// Wi-Fi credentials live in secrets.h (not in git): copy
// secrets.h.example to secrets.h and fill it in. To point at a local
// backend, override BACKEND_HOST / BACKEND_PORT / BACKEND_USE_TLS in
// secrets.h too. This connection is not authenticated yet: anyone who
// finds the URL can pose as the device.
//
// Libraries needed: DFRobot_AS7341, Adafruit SSD1306, Adafruit GFX,
// ArduinoJson 7, WebSockets (Markus Sattler / Links2004; search
// "WebSockets" in the Library Manager).
// The wiki hardware page names the Adafruit AS7341 library, but the board
// is a DFRobot SEN0365, so this sketch keeps using DFRobot's library
// (confirmed to compile). Switching to Adafruit's only requires changing
// readOnce().
// Serial Monitor (115200) prints [wifi] / [backend] connection events --
// check there first if the device won't come online.
// =========================================================

// ---- Include order: networking first, sensor second (see note 1 above) ----
#include <WiFi.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DFRobot_AS7341.h>

#ifdef ERR_OK
#undef ERR_OK            // remove DFRobot's macro so it can't clash with lwIP again
#endif

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "secrets.h not found: copy firmware/capture_screen/secrets.h.example to secrets.h and fill in your Wi-Fi credentials"
#endif
#if !defined(WIFI_SSID) || !defined(WIFI_PASSWORD)
  #error "secrets.h must define WIFI_SSID and WIFI_PASSWORD"
#endif

// =========================================================
// 1. Configuration
// =========================================================
// Backend location: defaults to the production backend on Render;
// secrets.h can override it
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

// Sent unchanged in every status / measurement (see note 6 above)
#define DEVICE_ID        "capture-screen-p1"
#define BUILD_ID         "P1-PROTO-01"
#define FIRMWARE_VERSION "6.0.0"
#define LED_CURRENT_MA   5.553f     // Bench-measured 2026-08-25; the firmware can't read this back

// ---- Pins ----
// The iGEM reference design is GPIO2 through a 2N7000 low-side switch.
// This unit is currently wired to 25 instead: GPIO2 is a strapping pin and
// most DevKits tie an onboard LED to it, which makes boot behavior messy.
// Switching back to 2 only needs the constant below changed; nothing else
// depends on it.
const int LED_PIN = 25;
const int I2C_SDA = 21;
const int I2C_SCL = 22;

const uint8_t AS7341_ADDR = 0x39;
const uint8_t OLED_ADDR   = 0x3C;

// ---- Sensor settings ----
// Full scale = (ATIME+1) x (ASTEP+1), capped at 65535; integration time =
// that value x 2.78us. The values below give full scale 60000 and an
// integration time of about 167ms. One full-channel read (two SMUX
// cycles) measures at 451.6ms, matching the 551-552ms LED-on window the
// wiki hardware page records once the 100ms settle is added.
uint8_t  AGAIN_CODE = 10;    // register index 0..10 -> 0.5x 1x 2x 4x 8x 16x 32x 64x 128x 256x 512x
uint8_t  ATIME_VAL  = 59;
uint16_t ASTEP_VAL  = 999;

// ---- Timing ----
const unsigned long DARK_SETTLE_MS      = 50;     // how long to wait after turning the LED off
const unsigned long LIGHT_SETTLE_MS     = 100;    // how long to wait after turning the LED on to settle
const unsigned long LIVE_PERIOD_MS      = 500;    // minimum time from one live frame to the next; a
                                                  // full read already takes ~452 ms, so this only bites
                                                  // once ATIME/ASTEP are lowered from Serial
const unsigned long STATUS_INTERVAL_MS  = 5000;   // the backend marks the device offline after 15 s of silence
const unsigned long WIFI_BOOT_WAIT_MS   = 10000;  // max time to wait for Wi-Fi at boot before continuing in loop()
const unsigned long RECONNECT_MS        = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;  // catches a connection that dropped without notice
const unsigned long WS_PONG_TIMEOUT_MS  = 10000;  // pump() runs during a measurement, so the longest gap is about one read
const uint8_t       WS_MISSED_PONGS     = 2;
const unsigned long WAITING_LOG_MS      = 10000;  // how often to log while stuck waiting for the backend
const unsigned long OLED_REFRESH_MS     = 1000;   // idle-screen redraw interval
const unsigned long SENSOR_CHECK_MS     = 2000;   // how often to re-confirm the AS7341 is still on the bus

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
DFRobot_AS7341 as7341;
WebSocketsClient ws;

const char* CH_NAME[10] = {"F1","F2","F3","F4","F5","F6","F7","F8","CLR","NIR"};

// ---- Types: must come before the first function definition ----
// Arduino auto-generates prototypes for every function and inserts them
// above the first function definition in the file. If a struct/enum is
// defined after that point, an inserted prototype (e.g.
// void readOnce(Frame&)) can't see the type, and the whole file fails to
// compile with a string of "'Frame' was not declared in this scope" errors.
struct Frame { uint16_t ch[10]; };       // F1..F8, CLR, NIR, raw ADC counts
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

// =========================================================
// 2. State
// =========================================================
DeviceState state = STATE_IDLE;

bool sensorOk = false;
bool oledOk = false;             // an OLED dropout must never stall a measurement, so every draw checks this flag first
bool wifiOk = false;
bool wsStarted = false;          // the WebSocket only starts once, but has to wait until Wi-Fi is actually up
bool backendConnected = false;
bool liveWanted = false;         // the backend says someone has the live spectrum open
bool readPending = false;        // a "read" arrived and hasn't been taken yet
char readRequestId[40] = "";

uint32_t liveSeq = 0;
unsigned long liveStartedMs = 0, lastLiveFrameMs = 0, lastStatusMs = 0, lastSensorCheckMs = 0;

// =========================================================
// 3. Sensor settings
// =========================================================
// Gain multiplier is derived from the index, so it can never drift out of
// sync with it (see note 2 above)
float gainMultiplier() {
  return 0.5f * (1 << AGAIN_CODE);          // code 0 -> 0.5x, 10 -> 512x
}
const char* gainName() {
  static const char* N[] = {"0.5x","1x","2x","4x","8x","16x","32x","64x","128x","256x","512x"};
  return N[AGAIN_CODE <= 10 ? AGAIN_CODE : 10];
}
uint32_t fullScale() {
  uint32_t fs = (uint32_t)(ATIME_VAL + 1) * (uint32_t)(ASTEP_VAL + 1);
  return fs > 65535UL ? 65535UL : fs;
}
float integrationMs() {
  return (ATIME_VAL + 1.0f) * (ASTEP_VAL + 1.0f) * 2.78e-3f;
}
void applySettings() {
  as7341.setAtime(ATIME_VAL);
  as7341.setAstep(ASTEP_VAL);
  as7341.setAGAIN(AGAIN_CODE);
}

const char* stateName() {
  switch (state) {
    case STATE_LIVE:      return "LIVE";
    case STATE_MEASURING: return "MEASURING";
    default:              return "IDLE";
  }
}

// forward declarations
void sendStatus();
void drawIdleScreen();

// =========================================================
// 4. I2C
// =========================================================
bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// sensorOk has to keep meaning "the AS7341 is answering now", not "it answered at boot":
// a cuvette holder knocked loose mid-session would otherwise leave every page saying the
// sensor is fine while each read returns nonsense. The ACK is cheap, so it runs on a timer
// and around every read. A sensor that comes back is re-begun and re-configured, because a
// power-cycled AS7341 wakes up with its registers at defaults, not with ours.
void checkSensor() {
  lastSensorCheckMs = millis();
  bool present = i2cPresent(AS7341_ADDR);
  if (present == sensorOk) return;

  sensorOk = present;
  if (sensorOk) {
    as7341.begin();
    applySettings();
    Serial.println("# AS7341 back on the bus, re-configured");
  } else {
    Serial.println("# AS7341 stopped responding");
  }
  if (!sensorOk && state != STATE_IDLE) {   // syncLive() can't light an LED for a sensor that isn't there
    digitalWrite(LED_PIN, LOW);
    setState(STATE_IDLE);
  } else {
    sendStatus();                           // setState() sends one itself; don't send two
  }
}

void i2cScan() {
  Serial.print("# I2C scan:");
  uint8_t n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    if (i2cPresent(a)) {
      Serial.printf(" 0x%02X", a);
      if (a == AS7341_ADDR) Serial.print("(AS7341)");
      if (a == OLED_ADDR)   Serial.print("(OLED)");
      n++;
    }
  }
  if (n == 0) Serial.print(" no device responded -- check SDA/SCL/VCC/GND");
  Serial.println();
}

// =========================================================
// 5. Reading
// =========================================================

// Keeps the connection alive during a measurement (see note 4 above). Only
// ever called from the loop() side, never from a callback.
void pump() {
  if (wsStarted) ws.loop();
  if (backendConnected && millis() - lastStatusMs >= STATUS_INTERVAL_MS) sendStatus();
  yield();
}

// Reads all ten channels once. The AS7341 can only cycle through six
// channels per SMUX pass, so this runs two passes; CLR / NIR appear in
// both, and this keeps the first pass's values (the website doesn't use
// the second pass's copy).
void readOnce(Frame &f) {
  as7341.startMeasure(as7341.eF1F4ClearNIR);
  DFRobot_AS7341::sModeOneData_t d1 = as7341.readSpectralDataOne();
  f.ch[0] = d1.ADF1; f.ch[1] = d1.ADF2; f.ch[2] = d1.ADF3; f.ch[3] = d1.ADF4;
  f.ch[8] = d1.ADCLEAR; f.ch[9] = d1.ADNIR;

  as7341.startMeasure(as7341.eF5F8ClearNIR);
  DFRobot_AS7341::sModeTwoData_t d2 = as7341.readSpectralDataTwo();
  f.ch[4] = d2.ADF5; f.ch[5] = d2.ADF6; f.ch[6] = d2.ADF7; f.ch[7] = d2.ADF8;

  pump();                        // one full read takes about 452ms; feed the connection partway through
}

// =========================================================
// 6. OLED (status only -- never part of a measurement)
// =========================================================
void showMessage(const char* l1, const char* l2) {
  if (!oledOk) return;
  display.clearDisplay();
  display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(l1);
  if (l2) display.println(l2);
  display.display();
}

// Idle screen: if the device doesn't show up on the website, check here
// first to see whether it's stuck on Wi-Fi or on the backend
void drawIdleScreen() {
  if (!oledOk) return;
  display.clearDisplay();
  display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("CAPTURE-Screen P1");
  display.print("WiFi ");
  display.println(wifiOk ? WiFi.localIP().toString() : String("connecting"));
  display.print("Web  ");
  display.println(backendConnected ? "online" : "connecting");
  display.print("Gain "); display.print(gainName());
  display.print("  "); display.print(integrationMs(), 0); display.println("ms");
  display.println(sensorOk ? "AS7341 ready" : "AS7341 NOT FOUND");
  display.setCursor(0, 56);
  display.print("Idle - waiting for web");
  display.display();
}

// Redraws the idle screen periodically: the Wi-Fi IP and backend status
// can change, and there's no button to trigger a manual refresh
void refreshIdleScreen() {
  static unsigned long last = 0;
  if (state != STATE_IDLE) return;
  if (millis() - last < OLED_REFRESH_MS) return;
  last = millis();
  drawIdleScreen();
}

// Ten channels in two columns (shown after a live frame or a web measurement)
void showFrame(const Frame &f) {
  if (!oledOk) return;
  display.clearDisplay();
  display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
  const uint8_t yy[5] = {0, 13, 26, 39, 52};
  for (uint8_t r = 0; r < 5; r++) {
    display.setCursor(0, yy[r]);
    display.print(CH_NAME[r]); display.print(":"); display.print(f.ch[r]);
    display.setCursor(66, yy[r]);
    display.print(CH_NAME[r + 5]); display.print(":"); display.print(f.ch[r + 5]);
  }
  display.display();
}

// =========================================================
// 7. Messages to the backend
// =========================================================
void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
  doc["firmware_version"] = FIRMWARE_VERSION;
}

// Serialization format is part of the contract (see note 3 above)
void addConfig(JsonObject c) {
  c["led_current_mA"] = serialized(String(LED_CURRENT_MA, 3));
  if (AGAIN_CODE == 0) c["gain"] = serialized(String("0.5"));   // only 0.5x is not an integer
  else                 c["gain"] = (uint16_t)gainMultiplier();
  c["atime"] = ATIME_VAL;
  c["astep"] = ASTEP_VAL;
}

// The contract requires raw ADC counts as non-negative integers
void addFrame(JsonObject o, const Frame &f) {
  for (uint8_t c = 0; c < 10; c++) o[CH_NAME[c]] = f.ch[c];
}

void sendJson(JsonDocument &doc) {
  if (!backendConnected) return;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

void sendStatus() {
  lastStatusMs = millis();
  JsonDocument doc;
  doc["mode"] = "status";
  addIdentity(doc);
  doc["state"]      = stateName();
  doc["uptime_ms"]  = millis();
  doc["wifi_rssi"]  = WiFi.RSSI();
  // Without this a dead sensor is silent: syncLive() just never streams, and the page
  // waits for a first frame that can't come.
  doc["sensor_ok"]  = sensorOk;
  addConfig(doc["config"].to<JsonObject>());
  sendJson(doc);
}

void sendError(const char *requestId, const char *err) {
  JsonDocument doc;
  doc["mode"] = "error";
  doc["request_id"] = requestId;
  doc["error"] = err;
  sendJson(doc);
}

void setState(DeviceState next) {
  if (state == next) return;
  state = next;
  sendStatus();
  if (state == STATE_IDLE) drawIdleScreen();
}

// =========================================================
// 8. Web measurement: dark_1 -> light -> dark_2, raw counts sent to the backend
// =========================================================
// The website (hardware_processing.js) averages the two dark frames to
// subtract, and their difference also serves as its read-noise estimate,
// so the light frame needs a dark frame on each side -- one alone isn't enough.
void measureForWeb(const char *requestId) {
  digitalWrite(LED_PIN, LOW);
  setState(STATE_MEASURING);
  showMessage("Measuring...", "requested from web");

  Frame dark1, light, dark2;
  unsigned long t0 = millis();

  delay(DARK_SETTLE_MS);
  readOnce(dark1);

  digitalWrite(LED_PIN, HIGH);
  delay(LIGHT_SETTLE_MS);
  readOnce(light);

  digitalWrite(LED_PIN, LOW);
  delay(DARK_SETTLE_MS);
  readOnce(dark2);

  JsonDocument doc;
  doc["mode"] = "measurement";
  doc["request_id"] = requestId;
  addIdentity(doc);
  doc["uptime_ms"] = millis();
  doc["read_time_ms"] = millis() - t0;
  addConfig(doc["config"].to<JsonObject>());
  addFrame(doc["dark_1"].to<JsonObject>(), dark1);
  addFrame(doc["light"].to<JsonObject>(), light);
  addFrame(doc["dark_2"].to<JsonObject>(), dark2);
  sendJson(doc);

  Serial.printf("# web measurement %lums  light F3=%u F4=%u  dark F4=%u/%u\n",
                (unsigned long)(millis() - t0), light.ch[2], light.ch[3],
                dark1.ch[3], dark2.ch[3]);

  setState(STATE_IDLE);     // if anyone is still watching, the next syncLive() call resumes streaming
  showFrame(light);
}

// =========================================================
// 9. Live streaming
// =========================================================
// Whether to stream depends on exactly two things: is anyone watching,
// and is a measurement running. The LED is only on while someone is
// watching -- continuous excitation would heat and photobleach the sample
// in the cuvette.
void syncLive() {
  bool should = backendConnected && liveWanted && sensorOk && state != STATE_MEASURING;
  if (should && state == STATE_IDLE) {
    digitalWrite(LED_PIN, HIGH);
    liveStartedMs = millis();
    lastLiveFrameMs = 0;
    setState(STATE_LIVE);
  } else if (!should && state == STATE_LIVE) {
    digitalWrite(LED_PIN, LOW);
    setState(STATE_IDLE);
  }
}

void streamLiveFrame() {
  unsigned long now = millis();
  if (now - liveStartedMs < LIGHT_SETTLE_MS) return;
  if (now - lastLiveFrameMs < LIVE_PERIOD_MS) return;
  lastLiveFrameMs = now;   // stamped before the read, so the constant is a period, not a gap

  Frame f;
  readOnce(f);
  if (state != STATE_LIVE) return;       // disconnected or someone stopped watching mid-read

  JsonDocument doc;
  doc["mode"] = "live";
  doc["seq"] = ++liveSeq;
  doc["t_ms"] = now;
  addFrame(doc["raw"].to<JsonObject>(), f);
  sendJson(doc);

  showFrame(f);
}

// =========================================================
// 10. Backend commands (called from within ws.loop(): only recorded, never measured here)
// =========================================================
void handleCommand(uint8_t *payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  const char *cmd = doc["cmd"] | "";

  if (strcmp(cmd, "live_start") == 0) {
    liveWanted = true;
  } else if (strcmp(cmd, "live_stop") == 0) {
    liveWanted = false;
  } else if (strcmp(cmd, "read") == 0) {
    const char *rid = doc["request_id"] | "";
    if (!sensorOk)                                        sendError(rid, "sensor_offline");
    else if (state == STATE_MEASURING || readPending)     sendError(rid, "busy");
    else { strlcpy(readRequestId, rid, sizeof(readRequestId)); readPending = true; }
  }
}

void onBackendEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      backendConnected = true;
      Serial.printf("[backend] connected to %s:%d%s\n", BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
      sendStatus();
      break;
    case WStype_DISCONNECTED:
      if (backendConnected) Serial.println("[backend] disconnected, reconnecting");
      backendConnected = false;
      liveWanted = false;     // no backend means no one is watching, so the LED can't stay on because of this
      readPending = false;    // the backend has already given up on this measurement
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

// Wi-Fi may come up later than setup()'s wait window, so its status has to
// be tracked continuously in loop(), and the WebSocket must not start
// until Wi-Fi is actually connected.
void serviceWifi() {
  bool now = (WiFi.status() == WL_CONNECTED);
  if (now != wifiOk) {
    wifiOk = now;
    if (wifiOk) { Serial.print("[wifi] connected, IP "); Serial.println(WiFi.localIP()); }
    else        Serial.println("[wifi] disconnected, reconnecting");
  }

  if (wifiOk && !wsStarted) {
    wsStarted = true;
    Serial.printf("[backend] connecting to %s:%d%s\n", BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
    // No pinned certificate for TLS: WebSockets 2.7.2 calls setInsecure()
    // on ESP32 when no CA is given. Use ws.beginSslWithCA() to pin
    // Render's root certificate later.
#if BACKEND_USE_TLS
    ws.beginSSL(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
#else
    ws.begin(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
#endif
    ws.onEvent(onBackendEvent);
    ws.setReconnectInterval(RECONNECT_MS);
    ws.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, WS_MISSED_PONGS);
  }
}

// Logs periodically while stuck connecting to the backend (bad Wi-Fi
// password, wrong host, wrong TLS setting, or a sleeping backend)
void logWhileWaitingForBackend() {
  static unsigned long last = 0;
  if (backendConnected || millis() - last < WAITING_LOG_MS) return;
  last = millis();
  Serial.printf("[backend] still connecting to %s:%d (Wi-Fi %s, RSSI %d dBm)\n",
                BACKEND_HOST, BACKEND_PORT, wifiOk ? "up" : "down", WiFi.RSSI());
}

// =========================================================
// 11. Serial diagnostic commands
// =========================================================
// All measurements are started by the website; Serial only keeps the
// tools needed when something won't come online or a reading looks wrong:
//   ?  current settings   i  I2C scan     l  toggle LED manually    d  dark/light table
//   g<0-10> gain     t<0-255> ATIME   s<1-65535> ASTEP
// g/t/s feed the fingerprint, so a status is sent right away after any of them.
const uint8_t DIAG_AVG = 8;     // how many times the 'd' command averages

void printSettings() {
  uint32_t fs = fullScale();
  Serial.printf("# gain=%s atime=%u astep=%u  full scale=%lu  integration=%.1fms\n",
                gainName(), ATIME_VAL, ASTEP_VAL, (unsigned long)fs, integrationMs());
  // A too-small full scale collapses every reading afterward with no other
  // symptom, so warn about it directly
  if (fs < 10000)
    Serial.printf("# ** warning: full scale is only %lu, integration time %.1fms is too short,\n"
                  "#    readings will be buried in quantization error. Normal settings are\n"
                  "#    t59 s999 (full scale 60000, integration 167ms). **\n",
                  (unsigned long)fs, integrationMs());
}

void printHelp() {
  Serial.println("# commands: ? settings  i I2C scan  l toggle LED  d dark/light table");
  Serial.println("#           g<0-10> gain   t<0-255> atime   s<1-65535> astep");
  Serial.println("# measurements and the live spectrum are started by the website; there is no command for them here.");
}

// Shape is locked down: a single lowercase letter, or a lowercase letter
// plus digits only. Anything else is treated as a typo.
// The old version only looked at the first letter, so typing "test1" made
// the 't' get read as an ATIME command and "est1".toInt() come out 0,
// dropping the integration time from 167ms to 2.8ms and collapsing every
// reading with no error message at all.
bool parseCommand(const String &s, char &c, long &v, bool &hasArg) {
  if (s.length() == 0) return false;
  c = s.charAt(0);
  String rest = s.substring(1);
  hasArg = false;

  if (c == '?') return rest.length() == 0;
  if (!(c >= 'a' && c <= 'z')) return false;

  switch (c) {
    case 'i': case 'l': case 'd':
      return rest.length() == 0;                 // no-argument commands: one extra character and it's not a command
    case 'g': case 't': case 's': {
      if (rest.length() == 0) return false;      // a bare g/t/s doesn't count, to avoid accidentally setting 0
      for (unsigned int i = 0; i < rest.length(); i++)
        if (!isDigit(rest.charAt(i))) return false;
      v = rest.toInt();
      hasArg = true;
      return true;
    }
    default:
      return false;
  }
}

void diagnoseDarkLight() {
  Frame dk, lt;
  double sd[10] = {0}, sl[10] = {0};

  digitalWrite(LED_PIN, LOW);  delay(DARK_SETTLE_MS);
  for (uint8_t i = 0; i < DIAG_AVG; i++) { readOnce(dk); for (uint8_t c = 0; c < 10; c++) sd[c] += dk.ch[c]; }
  digitalWrite(LED_PIN, HIGH); delay(LIGHT_SETTLE_MS);
  for (uint8_t i = 0; i < DIAG_AVG; i++) { readOnce(lt); for (uint8_t c = 0; c < 10; c++) sl[c] += lt.ch[c]; }
  digitalWrite(LED_PIN, LOW);

  Serial.println("# channel  dark      light     diff");
  for (uint8_t i = 0; i < 10; i++) {
    double d = sd[i] / DIAG_AVG, l = sl[i] / DIAG_AVG;
    Serial.printf("#  %-4s %8.1f  %8.1f  %8.1f\n", CH_NAME[i], d, l, l - d);
  }
  Serial.println("#   both near 0        -> LED not lit (or the light path is blocked)");
  Serial.println("#   both large and close -> LED is stuck on, not controlled by the GPIO");
  Serial.println("#   dark low, light high -> normal");
}

void handleSerial() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.length() == 0) return;

  char c; long v = 0; bool hasArg = false;
  if (!parseCommand(cmd, c, v, hasArg)) { printHelp(); return; }

  switch (c) {
    case 'i': i2cScan(); return;
    case 'l': {
      // toggling the LED manually during streaming or a measurement would taint the reading
      if (state != STATE_IDLE) { Serial.printf("# state is %s, cannot toggle the LED manually\n", stateName()); return; }
      static bool on = false;
      on = !on;
      digitalWrite(LED_PIN, on ? HIGH : LOW);
      Serial.printf("# LED (GPIO%d) -> %s\n", LED_PIN, on ? "ON" : "OFF");
      return;
    }
    case 'd':
      if (!sensorOk) { Serial.println("# sensor not responding"); return; }
      if (state != STATE_IDLE) { Serial.printf("# state is %s, try diagnostics again later\n", stateName()); return; }
      setState(STATE_MEASURING);      // claim the device so a web "read" can't grab the LED at the same time
      showMessage("Diagnostics...", "dark / light");
      diagnoseDarkLight();
      setState(STATE_IDLE);
      return;
    case 'g': if (v <= 10)  AGAIN_CODE = v; else { Serial.println("# gain must be 0..10"); return; } break;
    case 't': if (v <= 255) ATIME_VAL  = v; else { Serial.println("# atime must be 0..255"); return; } break;
    case 's': if (v >= 1 && v <= 65535) ASTEP_VAL = v; else { Serial.println("# astep must be 1..65535"); return; } break;
    case '?': break;
    default:  return;
  }

  applySettings();
  printSettings();
  sendStatus();             // settings feed the fingerprint, so the website needs to know right away
}

// =========================================================
// 12. setup / loop
// =========================================================
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);            // safe at boot: turn off excitation light as early as possible

  Serial.begin(115200);
  Serial.printf("# CAPTURE-Screen %s (%s)  LED %.3f mA\n",
                FIRMWARE_VERSION, BUILD_ID, LED_CURRENT_MA);

  Wire.begin(I2C_SDA, I2C_SCL);
  i2cScan();

  oledOk = i2cPresent(OLED_ADDR) && display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (oledOk) {
    display.setTextColor(SSD1306_WHITE);
    showMessage("CAPTURE-Screen P1", "starting...");
  } else {
    Serial.printf("# OLED @0x%02X not responding, falling back to Serial (measurements unaffected)\n", OLED_ADDR);
  }

  // Sensor detection uses the I2C ACK, not the reading (see note 5 above)
  int rc = -99;
  for (uint8_t i = 0; i < 3 && !sensorOk; i++) {
    sensorOk = i2cPresent(AS7341_ADDR);
    if (sensorOk) { rc = as7341.begin(); applySettings(); }
    else delay(300);
  }
  Serial.printf("# AS7341 @0x%02X  %s   begin() rc=%d\n",
                AS7341_ADDR, sensorOk ? "OK" : "not responding", rc);
  if (!sensorOk) { showMessage("AS7341 not found", "check I2C wiring"); delay(2000); }

  // If Wi-Fi never connects the device shouldn't sit doing nothing, and it
  // also shouldn't block inside setup(): wait briefly here, then hand off
  // to serviceWifi() in loop() to keep trying.
  showMessage("Connecting Wi-Fi...", WIFI_SSID);
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // power-save mode adds latency and lowers the streaming rate
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_BOOT_WAIT_MS) delay(200);
  if (WiFi.status() != WL_CONNECTED)
    Serial.println("[wifi] not connected yet, still trying; the backend link starts once it connects");

  printSettings();
  printHelp();
  serviceWifi();
  drawIdleScreen();
}

void loop() {
  serviceWifi();
  if (wsStarted) ws.loop();

  // callback only records; the actual measurement happens here. Serial
  // comes after, so it never competes with a measurement.
  if (readPending) {
    readPending = false;
    // measureForWeb() doesn't check the sensor itself, and the command handler's check is as
    // old as the command: confirm here, or a sensor lost since then yields a frame of nonsense.
    checkSensor();
    if (sensorOk) measureForWeb(readRequestId);
    else          sendError(readRequestId, "sensor_offline");
  }

  handleSerial();

  // Between whole reads, never inside one: loop() is sequential, so no I2C is in flight here.
  if (state != STATE_MEASURING && millis() - lastSensorCheckMs >= SENSOR_CHECK_MS) checkSensor();

  syncLive();
  if (state == STATE_LIVE) streamLiveFrame();

  if (backendConnected && millis() - lastStatusMs >= STATUS_INTERVAL_MS) sendStatus();

  logWhileWaitingForBackend();
  refreshIdleScreen();
  delay(1);
}
