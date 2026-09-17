// =========================================================
// CAPTURE-Screen firmware (iGEM NCKU-Tainan 2026)
//
// Hardware: ESP32-WROOM-32 (DOIT DevKit V1 30-pin)
//           AS7341 spectral sensor (DFRobot SEN0365), I2C on GPIO 21 / 22
//           SSD1306 OLED 128x64, I2C address 0x3C
//           470 nm excitation LED, GPIO 2 through a 2N7000 low-side switch
//           Button on GPIO 13 (INPUT_PULLUP)
//
// After power-on and joining Wi-Fi, the device dials out to the backend's WebSocket
//   wss://<BACKEND_HOST>/api/hardware/device
// and keeps that connection open (reconnecting automatically if it drops). The backend
// runs on Render and can't reach a router behind a home or lab network, so the device
// always has to be the one connecting out; the live spectrum, measurement, and
// calibration on the web pages all go through this one connection.
//
// The device only "reads" — it does no computation. Dark subtraction, normalization,
// and unmixing all happen on the web side (frontend/js/hardware_processing.js).
//
// Device -> backend
//   {"mode":"status", ...}       on connect, on any state change, then every 5 s
//   {"mode":"live", ...}         one frame after another while someone has the live
//                                spectrum open (about one frame per second)
//   {"mode":"measurement", ...}  the three-part dark_1 -> light -> dark_2 measurement
//                                after a read command (about 3 s)
//   {"mode":"error", ...}        the command couldn't run (busy)
// Backend -> device
//   {"cmd":"live_start"} / {"cmd":"live_stop"}   whether anyone is watching the live spectrum
//   {"cmd":"read","request_id":"..."}             take one measurement
//
// State machine: IDLE / LIVE / MEASURING. The LED is only lit while someone is watching
// the live spectrum or a measurement is running: leaving it on would heat and bleach the
// sample in the cuvette. A measurement pauses streaming (a lit LED would contaminate the
// dark reads) and resumes automatically afterward as long as someone is still watching.
// The LED is always turned off when disconnected from the backend.
//
// Everything runs inside loop(): WebSocketsClient's event callbacks also fire from within
// ws.loop(), so they never run concurrently with loop(), which means no mutex is needed.
// Callbacks only record commands; the actual measuring happens in loop().
//
// secrets.h (not committed, copied from secrets.h.example) holds the Wi-Fi credentials;
// to point at a local backend, also override BACKEND_HOST / BACKEND_PORT / BACKEND_USE_TLS
// there. This connection currently has no authentication: anyone who knows the URL can
// impersonate the device.
//
// Required libraries: DFRobot_AS7341, Adafruit SSD1306, Adafruit GFX, ArduinoJson 7,
// WebSockets (Markus Sattler / Links2004 — search "WebSockets" in the Library Manager).
// Verified to compile against ESP32 core 3.3.8, DFRobot_AS7341 1.0.0, Adafruit SSD1306 2.5.17,
// Adafruit GFX 1.12.6, ArduinoJson 7.4.3, WebSockets 2.7.2.
//
// The Serial Monitor (115200) prints [wifi] / [backend] connection status — check there first
// if the device won't connect.
// =========================================================

#include <Wire.h>
#include <WiFi.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DFRobot_AS7341.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

#include "secrets.h"

// --- 0. Backend location: defaults to the production backend on Render, secrets.h can override it ---
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

// --- 1. Device constants: dropped as-is into every status / measurement message ---
#define DEVICE_ID        "capture-screen-p1"
#define BUILD_ID         "P1-PROTO-01"
#define FIRMWARE_VERSION "0.3.0"
#define LED_CURRENT_MA   5.553f   // measured with a multimeter; firmware can't read this itself

// --- 2. Sensor settings: must be set explicitly, never rely on the library defaults ---
// gain / atime / astep feed into the web side's normalization and config fingerprint,
// so changing the values here changes what status and measurement report.
const uint8_t  AS7341_AGAIN = 16;   // 16x, the multiplier reported to the web side
// DFRobot's setAGAIN() takes a register index, not the multiplier itself:
// 0..10 map to 0.5x, 1x, 2x, 4x, 8x, 16x, 32x, 64x, 128x, 256x, 512x.
// Update this index whenever AS7341_AGAIN changes.
const uint8_t  AS7341_AGAIN_REGISTER = 5;
const uint8_t  AS7341_ATIME = 29;
const uint16_t AS7341_ASTEP = 599;

// --- 3. Pins ---
const int LED_PIN    = 2;
const int BUTTON_PIN = 13;
const int I2C_SDA    = 21;
const int I2C_SCL    = 22;

// --- 4. Timing ---
// DFRobot_AS7341 waits ~60 ms per channel read: one ten-channel read takes ~1 s, and one
// measurement (three reads) takes ~3 s. loop() is blocked the whole time, so the intervals
// and timeouts below are all sized around that.
const unsigned long DARK_SETTLE_MS      = 50;     // wait after turning the LED off
const unsigned long LIGHT_SETTLE_MS     = 100;    // wait for the LED to stabilize after turning on
const unsigned long LIVE_INTERVAL_MS    = 200;    // leaves ws.loop() and the button time between frames
const unsigned long STATUS_INTERVAL_MS  = 5000;   // status heartbeat; backend treats 15 s silence as offline
const unsigned long RECONNECT_MS        = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;  // detects a connection that dropped without notice
const unsigned long WS_PONG_TIMEOUT_MS  = 10000;  // a pong during a measurement may be handled 3+ s late
const uint8_t       WS_MISSED_PONGS     = 2;
const unsigned long WAITING_LOG_MS      = 10000;  // how often to log to Serial while unable to reach the backend
const unsigned long DEBOUNCE_MS         = 50;

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

DFRobot_AS7341 as7341;
WebSocketsClient ws;

// --- 5. State ---
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

DeviceState state = STATE_IDLE;
bool backendConnected = false;
bool liveWanted = false;        // backend says someone has the live spectrum open
bool readPending = false;       // a read arrived and hasn't been taken yet
char readRequestId[40] = "";

uint32_t liveSeq = 0;
unsigned long liveStartedMs = 0;
unsigned long lastLiveFrameMs = 0;
unsigned long lastStatusMs = 0;

struct SpectralFrame {
  uint16_t f1, f2, f3, f4, f5, f6, f7, f8, clr, nir;
};

struct ClearNir {
  uint16_t clr, nir;
};

struct MeasurementResult {
  SpectralFrame dark1, light, dark2;
  ClearNir clearNirMode2;
  unsigned long readTimeMs;
};

const char* stateName(DeviceState s) {
  switch (s) {
    case STATE_LIVE:      return "LIVE";
    case STATE_MEASURING: return "MEASURING";
    default:              return "IDLE";
  }
}

// =========================================================
// Sensor
// =========================================================

// Reads one full set of ten channels: two SMUX passes (same read logic as before).
// The first pass gives F1-F4 plus Clear / NIR; the second gives F5-F8, whose own
// Clear / NIR is recorded as mode2 — the measurement sequence returns it as clear_nir_mode2.
void readTenChannels(SpectralFrame &frame, ClearNir &mode2) {
  as7341.startMeasure(as7341.eF1F4ClearNIR);
  DFRobot_AS7341::sModeOneData_t data1 = as7341.readSpectralDataOne();
  frame.f1 = data1.ADF1;
  frame.f2 = data1.ADF2;
  frame.f3 = data1.ADF3;
  frame.f4 = data1.ADF4;
  frame.clr = data1.ADCLEAR;
  frame.nir = data1.ADNIR;

  as7341.startMeasure(as7341.eF5F8ClearNIR);
  DFRobot_AS7341::sModeTwoData_t data2 = as7341.readSpectralDataTwo();
  frame.f5 = data2.ADF5;
  frame.f6 = data2.ADF6;
  frame.f7 = data2.ADF7;
  frame.f8 = data2.ADF8;
  mode2.clr = data2.ADCLEAR;
  mode2.nir = data2.ADNIR;
}

void runMeasurementSequence(MeasurementResult &result) {
  ClearNir unused;
  unsigned long start = millis();

  digitalWrite(LED_PIN, LOW);
  delay(DARK_SETTLE_MS);
  readTenChannels(result.dark1, unused);

  digitalWrite(LED_PIN, HIGH);
  delay(LIGHT_SETTLE_MS);
  readTenChannels(result.light, result.clearNirMode2);

  digitalWrite(LED_PIN, LOW);
  delay(DARK_SETTLE_MS);
  readTenChannels(result.dark2, unused);

  result.readTimeMs = millis() - start;
}

// Serial Plotter format (same output as before), handy for debugging over USB.
void printFrameSerial(const SpectralFrame &f) {
  Serial.print("F1:"); Serial.print(f.f1); Serial.print(",");
  Serial.print("F2:"); Serial.print(f.f2); Serial.print(",");
  Serial.print("F3:"); Serial.print(f.f3); Serial.print(",");
  Serial.print("F4:"); Serial.print(f.f4); Serial.print(",");
  Serial.print("F5:"); Serial.print(f.f5); Serial.print(",");
  Serial.print("F6:"); Serial.print(f.f6); Serial.print(",");
  Serial.print("F7:"); Serial.print(f.f7); Serial.print(",");
  Serial.print("F8:"); Serial.print(f.f8); Serial.print(",");
  Serial.print("CLR:"); Serial.print(f.clr); Serial.print(",");
  Serial.print("NIR:"); Serial.println(f.nir);
}

// =========================================================
// OLED
// =========================================================

// Reading screen: two-column layout (same layout as before).
void showFrame(const SpectralFrame &f) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);  display.print("F1:"); display.print(f.f1);
  display.setCursor(0, 13); display.print("F2:"); display.print(f.f2);
  display.setCursor(0, 26); display.print("F3:"); display.print(f.f3);
  display.setCursor(0, 39); display.print("F4:"); display.print(f.f4);
  display.setCursor(0, 52); display.print("F5:"); display.print(f.f5);

  display.setCursor(66, 0);  display.print("F6:"); display.print(f.f6);
  display.setCursor(66, 13); display.print("F7:"); display.print(f.f7);
  display.setCursor(66, 26); display.print("F8:"); display.print(f.f8);
  display.setCursor(66, 39); display.print("C :"); display.print(f.clr);
  display.setCursor(66, 52); display.print("N :"); display.print(f.nir);

  display.display();
}

void showMessage(const char* line1, const char* line2) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  if (line2) display.println(line2);
  display.display();
}

// Idle screen: Wi-Fi and backend connection status — check here first if the device
// doesn't show up on the web page.
void showIdleScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("CAPTURE-Screen");
  if (WiFi.status() == WL_CONNECTED) {
    display.print("IP ");
    display.println(WiFi.localIP());
  } else {
    display.println("Wi-Fi: reconnecting");
  }
  display.println(backendConnected ? "Backend: online" : "Backend: connecting");
  display.print("State: ");
  display.println(stateName(state));
  display.println();
  display.println("Button: local read");
  display.display();
}

// Only redraws the idle screen when connection status changes, so a button measurement's
// result isn't immediately overwritten.
void refreshIdleScreen() {
  static bool shownWifi = false;
  static bool shownBackend = false;
  bool wifiNow = WiFi.status() == WL_CONNECTED;
  if (state != STATE_IDLE || (wifiNow == shownWifi && backendConnected == shownBackend)) return;
  shownWifi = wifiNow;
  shownBackend = backendConnected;
  showIdleScreen();
}

// =========================================================
// Messages to the backend
// =========================================================

void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
  doc["firmware_version"] = FIRMWARE_VERSION;
}

void addConfig(JsonObject config) {
  // Fixed at 3 decimal places: serializing the float directly gives 5.5529999...,
  // which would make the web side's fingerprint calculation mismatch.
  config["led_current_mA"] = serialized(String(LED_CURRENT_MA, 3));
  config["gain"] = AS7341_AGAIN;
  config["atime"] = AS7341_ATIME;
  config["astep"] = AS7341_ASTEP;
}

void addFrame(JsonObject obj, const SpectralFrame &f) {
  obj["F1"] = f.f1;
  obj["F2"] = f.f2;
  obj["F3"] = f.f3;
  obj["F4"] = f.f4;
  obj["F5"] = f.f5;
  obj["F6"] = f.f6;
  obj["F7"] = f.f7;
  obj["F8"] = f.f8;
  obj["CLR"] = f.clr;
  obj["NIR"] = f.nir;
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
  doc["state"] = stateName(state);
  doc["uptime_ms"] = millis();
  doc["wifi_rssi"] = WiFi.RSSI();
  addConfig(doc["config"].to<JsonObject>());
  sendJson(doc);
}

void sendError(const char *requestId, const char *error) {
  JsonDocument doc;
  doc["mode"] = "error";
  doc["request_id"] = requestId;
  doc["error"] = error;
  sendJson(doc);
}

void setState(DeviceState next) {
  if (state == next) return;
  state = next;
  sendStatus();
  if (state == STATE_IDLE) showIdleScreen();
}

// =========================================================
// Commands from the backend (called from within ws.loop(): only record, never measure here)
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
    const char *requestId = doc["request_id"] | "";
    if (readPending) {
      sendError(requestId, "busy");
    } else {
      strlcpy(readRequestId, requestId, sizeof(readRequestId));
      readPending = true;
    }
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
      liveWanted = false;   // no backend means no one is watching: the LED can't stay on for that
      readPending = false;  // the backend has already given up on this read
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

// Logs to Serial periodically while stuck unable to reach the backend
// (Wi-Fi password, URL, TLS, or the backend being asleep).
void logWhileWaitingForBackend() {
  static unsigned long lastLogMs = 0;
  if (backendConnected || millis() - lastLogMs < WAITING_LOG_MS) return;
  lastLogMs = millis();
  Serial.printf("[backend] still connecting to %s:%d (Wi-Fi %s, RSSI %d dBm)\n",
                BACKEND_HOST, BACKEND_PORT, WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.RSSI());
}

// =========================================================
// Work done in loop()
// =========================================================

// Takes one measurement. requestId is nullptr for a button trigger, whose result is only shown on the OLED.
void measure(const char *requestId) {
  digitalWrite(LED_PIN, LOW);
  setState(STATE_MEASURING);
  showMessage("Measuring...", requestId ? "requested online" : "(button)");

  MeasurementResult result;
  runMeasurementSequence(result);

  if (requestId) {
    JsonDocument doc;
    doc["mode"] = "measurement";
    doc["request_id"] = requestId;
    addIdentity(doc);
    doc["uptime_ms"] = millis();
    doc["read_time_ms"] = result.readTimeMs;
    addConfig(doc["config"].to<JsonObject>());
    addFrame(doc["dark_1"].to<JsonObject>(), result.dark1);
    addFrame(doc["light"].to<JsonObject>(), result.light);
    addFrame(doc["dark_2"].to<JsonObject>(), result.dark2);
    JsonObject mode2 = doc["clear_nir_mode2"].to<JsonObject>();
    mode2["CLR"] = result.clearNirMode2.clr;
    mode2["NIR"] = result.clearNirMode2.nir;
    sendJson(doc);
  }

  printFrameSerial(result.light);
  setState(STATE_IDLE);  // if someone is still watching, the next syncLive() resumes streaming
  if (!requestId) showFrame(result.light);
}

// Whether streaming runs depends on just two things: whether anyone is watching, and
// whether a measurement is in progress.
void syncLive() {
  bool shouldStream = backendConnected && liveWanted && state != STATE_MEASURING;
  if (shouldStream && state == STATE_IDLE) {
    digitalWrite(LED_PIN, HIGH);
    liveStartedMs = millis();
    lastLiveFrameMs = 0;
    setState(STATE_LIVE);
  } else if (!shouldStream && state == STATE_LIVE) {
    digitalWrite(LED_PIN, LOW);
    setState(STATE_IDLE);
  }
}

void streamLiveFrame() {
  unsigned long now = millis();
  if (now - liveStartedMs < LIGHT_SETTLE_MS || now - lastLiveFrameMs < LIVE_INTERVAL_MS) return;
  lastLiveFrameMs = now;

  SpectralFrame frame;
  ClearNir unused;
  readTenChannels(frame, unused);

  JsonDocument doc;
  doc["mode"] = "live";
  doc["seq"] = ++liveSeq;
  doc["t_ms"] = now;
  addFrame(doc["raw"].to<JsonObject>(), frame);
  sendJson(doc);

  printFrameSerial(frame);
  showFrame(frame);
}

// Button tap: takes one measurement on the device, result shown only on the OLED, never sent out.
void onButtonPress() {
  if (state == STATE_MEASURING || readPending) return;
  measure(nullptr);
}

// Non-blocking debounce: fires once on the press edge.
void handleButton() {
  static bool lastRaw = false;
  static bool stablePressed = false;
  static unsigned long lastChangeMs = 0;

  bool raw = digitalRead(BUTTON_PIN) == LOW;
  if (raw != lastRaw) {
    lastRaw = raw;
    lastChangeMs = millis();
  }
  if (millis() - lastChangeMs >= DEBOUNCE_MS && raw != stablePressed) {
    stablePressed = raw;
    if (stablePressed) onButtonPress();
  }
}

// =========================================================

void setup() {
  // Boot safety: turn off the excitation LED as early as possible.
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);

  while (as7341.begin() != 0) {
    showMessage("AS7341 not found", "Check I2C wiring");
    Serial.println("AS7341 init failed");
    delay(1000);
  }
  as7341.setAtime(AS7341_ATIME);
  as7341.setAstep(AS7341_ASTEP);
  as7341.setAGAIN(AS7341_AGAIN_REGISTER);

  showMessage("Connecting Wi-Fi...", WIFI_SSID);
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // power-save mode would add streaming latency and lower the update rate
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
  Serial.print("[wifi] connected, IP ");
  Serial.println(WiFi.localIP());

  // TLS has no pinned certificate: WebSockets 2.7.2 on ESP32 calls setInsecure() to skip
  // validation when no CA is given. To validate the certificate later, switch to
  // ws.beginSslWithCA() with Render's root certificate.
#if BACKEND_USE_TLS
  ws.beginSSL(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
#else
  ws.begin(BACKEND_HOST, BACKEND_PORT, BACKEND_PATH);
#endif
  ws.onEvent(onBackendEvent);
  ws.setReconnectInterval(RECONNECT_MS);
  ws.enableHeartbeat(WS_PING_INTERVAL_MS, WS_PONG_TIMEOUT_MS, WS_MISSED_PONGS);

  showIdleScreen();
}

void loop() {
  ws.loop();
  handleButton();

  if (readPending) {
    readPending = false;
    measure(readRequestId);
  }

  syncLive();
  if (state == STATE_LIVE) streamLiveFrame();

  if (backendConnected && millis() - lastStatusMs >= STATUS_INTERVAL_MS) sendStatus();

  logWhileWaitingForBackend();
  refreshIdleScreen();
  delay(1);
}
