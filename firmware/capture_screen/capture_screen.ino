// =========================================================
// CAPTURE-Screen firmware -- serves the LasReader website
//
// P1-PROTO-01: a single-cuvette, 90-degree fluorescence reader.
//   Excitation: Cree C503B 470 nm, 2N7000 low-side switch on GPIO 25,
//               434-ohm limit, bench-measured 5.553 mA
//   Detector:   DFRobot SEN0365 (AS7341, I2C 0x39), no emission filter
//   Controller: ESP32-WROOM-32 DOIT DevKit V1
//   Display:    SSD1306 OLED (I2C 0x3C), live status and spectrum
//   Button:     GPIO 13 to GND -- the Live switch, same as the website's
//
// The website is the instrument's front end; this firmware only reads and
// reports. Boot -> Wi-Fi -> dial out to the backend's WebSocket and keep it
// open. Every measurement is requested by a page; Live is one switch shared
// by the button and every page. While Live is on, a page can also switch the
// LED off to stream dark / ambient counts.
//
// Sections: 1 configuration, 2 sensor, 3 button, 4 OLED, 5 backend link,
// 6 controller (the only code that drives the LED), 7 Serial diagnostics,
// 8 setup / loop.
//
// Libraries: DFRobot_AS7341, Adafruit SSD1306, Adafruit GFX, ArduinoJson 7,
// WebSockets (Markus Sattler / Links2004). Wi-Fi credentials go in
// secrets.h (gitignored): copy secrets.h.example.
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
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DFRobot_AS7341.h>

#ifdef ERR_OK
#undef ERR_OK
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
//
// BUILD_ID, LED_CURRENT_MA and the three sensor settings feed the website's
// config fingerprint: changing any of them makes every saved calibration
// curve stale. There is no firmware version number; when a change alters the
// reading path itself, stale the curves on purpose by changing BUILD_ID.
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
#define DEVICE_ID        "capture-screen-p1"
#define BUILD_ID         "P1-PROTO-01"
#define LED_CURRENT_MA   5.553f     // bench-measured 2026-08-25; the firmware can't read it back

// ---- Pins ----
// The iGEM reference design drives the LED from GPIO2. This unit uses 25:
// GPIO2 is a strapping pin with an onboard LED on most DevKits.
const int LED_PIN    = 25;
const int BUTTON_PIN = 13;          // to GND when pressed, INPUT_PULLUP
const int I2C_SDA    = 21;
const int I2C_SCL    = 22;

const uint8_t AS7341_ADDR = 0x39;
const uint8_t OLED_ADDR   = 0x3C;

// ---- Sensor settings at boot (Serial g/t/s change them at runtime) ----
// Full scale = (ATIME+1)(ASTEP+1), capped at 65535; integration time = that
// x 2.78 us. These give full scale 60000 and ~167 ms; one ten-channel read
// (two SMUX cycles) takes ~452 ms.
const uint8_t  DEFAULT_AGAIN_CODE = 10;   // register index 0..10 -> 0.5x .. 512x
const uint8_t  DEFAULT_ATIME      = 59;
const uint16_t DEFAULT_ASTEP      = 999;

// ---- Timing ----
const unsigned long DARK_SETTLE_MS      = 50;      // after switching the LED off
const unsigned long LIGHT_SETTLE_MS     = 100;     // after switching the LED on
const unsigned long LIVE_PERIOD_MS      = 500;     // minimum period between live frames
// Live switches itself off after this long. Continuous excitation heats and
// bleaches the sample, and the button makes it easy to switch Live on and walk away.
const unsigned long LIVE_AUTO_OFF_MS    = 10UL * 60UL * 1000UL;
const unsigned long STATUS_INTERVAL_MS  = 5000;    // the backend marks the device offline after 15 s of silence
const unsigned long SENSOR_CHECK_MS     = 2000;    // re-confirm the AS7341 still answers on the bus
const unsigned long WIFI_BOOT_WAIT_MS   = 10000;   // setup() waits this long, then loop() keeps trying
const unsigned long RECONNECT_MS        = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;   // catches a connection that died without a close
const unsigned long WS_PONG_TIMEOUT_MS  = 10000;
const uint8_t       WS_MISSED_PONGS     = 2;
const unsigned long WAITING_LOG_MS      = 10000;   // Serial reminder while the backend is unreachable

// ---- Button ----
const unsigned long BUTTON_SAMPLE_MS    = 5;       // the button task samples the pin this often
const unsigned long BUTTON_DEBOUNCE_MS  = 30;      // a level must hold this long to count

// ---- OLED ----
const unsigned long OLED_MIN_REDRAW_MS  = 100;     // never redraw faster than this
const unsigned long OLED_IDLE_REDRAW_MS = 1000;    // countdowns and Wi-Fi strength still tick
const unsigned long OLED_NOTICE_MS      = 2000;    // how long a one-off notice stays up
// The OLED bar chart follows the website's y axis rule: fixed at this top,
// stepping up to the next 1/2/5 x 10^n when a bar exceeds it, never past
// full scale, reset when Live starts again.
const uint32_t      LIVE_Y_BASE_COUNTS  = 5000;

// ---- Types: must come before the first function definition ----
// Arduino generates a prototype for every function and inserts them above
// the first function definition in the file. A struct or enum defined after
// that point is invisible to those prototypes, and the whole sketch fails
// with "'Frame' was not declared in this scope".
struct Frame { uint16_t ch[10]; };        // F1..F8, CLR, NIR: raw ADC counts, never processed here
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

const char* const CH_NAME[10] = {"F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "CLR", "NIR"};
const uint8_t CH_F4 = 3;                  // the sfGFP band

// =========================================================
// 2. Sensor: the AS7341 and the I2C bus
// =========================================================

static DFRobot_AS7341 as7341;
static bool sensorPresent = false;
static uint8_t  gainCode = DEFAULT_AGAIN_CODE;
static uint8_t  atime    = DEFAULT_ATIME;
static uint16_t astep    = DEFAULT_ASTEP;

static void applySettings() {
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
    if (a == OLED_ADDR)   Serial.print("(OLED)");
    n++;
  }
  if (n == 0) Serial.print(" no device answered -- check SDA/SCL/VCC/GND");
  Serial.println();
}

// Presence is judged by the I2C ACK, never by the reading: with the lid
// closed and the LED off every channel reads 0, which is a normal dark.
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

// sensorPresent has to mean "answering now", not "answered at boot": a sensor knocked
// loose mid-session would otherwise leave every page saying it is fine while
// each read returns nonsense. A sensor that comes back is re-begun, because a
// power-cycled AS7341 wakes with its registers at defaults, not ours.
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
// appear in both; the first cycle's values are kept.
void sensorRead(Frame &f, void (*between)()) {
  as7341.startMeasure(DFRobot_AS7341::eF1F4ClearNIR);
  DFRobot_AS7341::sModeOneData_t d1 = as7341.readSpectralDataOne();
  f.ch[0] = d1.ADF1; f.ch[1] = d1.ADF2; f.ch[2] = d1.ADF3; f.ch[3] = d1.ADF4;
  f.ch[8] = d1.ADCLEAR; f.ch[9] = d1.ADNIR;

  if (between) between();

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
// 3. Button: the Live button on GPIO 13
//
// A small FreeRTOS task samples the pin every BUTTON_SAMPLE_MS and counts
// debounced presses. It has to be a task, not a poll in loop(): a live frame
// or a measurement blocks loop() for 0.5-1.6 s, long enough to miss a press
// entirely. The task touches nothing but its own counter; what a press does
// is decided in loop() by the controller, one press at a time.
// =========================================================

// Written only by the task, read only by loop(); a 32-bit aligned word is
// read and written atomically on the ESP32, so no lock is needed.
static volatile uint32_t pressCount = 0;
static volatile bool held = false;
static uint32_t taken = 0;

static void buttonTask(void *) {
  bool raw = digitalRead(BUTTON_PIN) == LOW;
  // A button already held at boot is not a press: only a release followed by
  // a new press counts.
  bool stable = raw;
  held = stable;
  uint32_t changedAt = millis();

  for (;;) {
    bool now = digitalRead(BUTTON_PIN) == LOW;
    uint32_t t = millis();
    if (now != raw) {
      raw = now;
      changedAt = t;
    } else if (raw != stable && t - changedAt >= BUTTON_DEBOUNCE_MS) {
      stable = raw;
      held = stable;
      if (stable) pressCount = pressCount + 1;   // counted on press, not release
    }
    vTaskDelay(pdMS_TO_TICKS(BUTTON_SAMPLE_MS));
  }
}

void buttonBegin() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  // Core 0, beside the Wi-Fi stack; loop() runs on core 1.
  xTaskCreatePinnedToCore(buttonTask, "button", 2048, nullptr, 1, nullptr, 0);
}

uint32_t buttonTakePresses() {
  uint32_t count = pressCount;
  uint32_t n = count - taken;
  taken = count;
  return n;
}

bool buttonHeld() { return held; }

// =========================================================
// 4. OLED (128x64)
//
// Status only: the OLED never gates a measurement. oledOk is set from an
// I2C ACK plus oled.begin(), and every draw returns early without it, so a
// loose display wire can't stall the read path.
//
// Layout: a status bar on top (Wi-Fi, backend, state), and below it one body
// chosen by priority: a notice, a measurement in progress, a sensor fault,
// the live spectrum, or the idle summary.
//
// Only displayService(), displayMessage() and displayMeasureStep() draw. The
// rest just record, so they are safe to call from inside ws.loop().
// =========================================================

// The driver raises the bus to 400 kHz for its own transfers (a full redraw
// takes ~25 ms instead of ~95 ms) and puts it back to 100 kHz for the sensor.
static Adafruit_SSD1306 oled(128, 64, &Wire, -1);
static bool oledOk = false;
static bool dirty = true;
static unsigned long lastDrawMs = 0;

static char noticeLine1[22] = "", noticeLine2[22] = "";
static unsigned long noticeUntil = 0;

static Frame liveFrame;
static bool hasLiveFrame = false;
static bool liveFrameLit = true;         // whether the frame on screen was read with the LED on
static uint32_t liveTop = LIVE_Y_BASE_COUNTS;

static bool hasLastReading = false;
static uint16_t lastReadingF4 = 0;

// ---- Small helpers --------------------------------------------------------

static void textAt(int16_t x, int16_t y, const char *s) {
  oled.setCursor(x, y);
  oled.print(s);
}

static void centered(int16_t y, const char *s) {
  int16_t w = strlen(s) * 6;
  textAt(w >= 128 ? 0 : (128 - w) / 2, y, s);
}

// The smallest 1, 2 or 5 x 10^n at or above value: the website's axis rule.
static uint32_t niceCeil(uint32_t value) {
  uint32_t power = 1;
  while (power * 10 <= value) power *= 10;
  const uint32_t steps[] = {1, 2, 5, 10};
  for (uint32_t m : steps) if (m * power >= value) return m * power;
  return 10 * power;
}

// ---- Screens ------------------------------------------------------------

static void drawStatusBar() {
  char buf[12];
  if (linkWifiUp()) snprintf(buf, sizeof(buf), "WiFi%d", linkRssi());
  else              snprintf(buf, sizeof(buf), "WiFi --");
  textAt(0, 1, buf);
  textAt(52, 1, linkBackendUp() ? "Web ok" : "Web --");

  const char *label = ctrlState() == STATE_LIVE ? "LIVE" : ctrlState() == STATE_MEASURING ? "MEAS" : "IDLE";
  oled.fillRect(101, 0, 27, 10, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  textAt(103, 1, label);
  oled.setTextColor(SSD1306_WHITE);
  oled.drawFastHLine(0, 11, 128, SSD1306_WHITE);
}

static void drawNotice() {
  oled.drawRect(0, 16, 128, 46, SSD1306_WHITE);
  centered(26, noticeLine1);
  centered(44, noticeLine2);
}

static uint8_t measureStep = 0;
static char measureWhat[22] = "";

static void drawMeasuring() {
  textAt(0, 15, measureWhat);
  if (measureStep == 0) { textAt(0, 33, "Please wait"); return; }
  const char *names[3] = {"Dark 1", "Light", "Dark 2"};
  for (uint8_t i = 0; i < 3; i++) {
    uint8_t step = i + 1;
    const char *mark = step < measureStep ? "ok" : step == measureStep ? ">>" : "  ";
    char line[22];
    snprintf(line, sizeof(line), "%s %s", mark, names[i]);
    textAt(0, 29 + i * 11, line);
  }
}

static void drawSensorFault() {
  centered(18, "Sensor fault");
  centered(32, "AS7341 not responding");
  centered(46, "Check I2C wiring");
}

static void drawLive() {
  if (!hasLiveFrame) { centered(32, "Starting Live..."); return; }

  char buf[22];
  snprintf(buf, sizeof(buf), "F4 %u", liveFrame.ch[CH_F4]);
  textAt(0, 14, buf);
  // Labelled from the frame itself, not the switch: the frame on screen may
  // predate the last LED change by one read.
  if (!liveFrameLit) textAt(54, 14, "dark");
  long offIn = ctrlLiveOffInS();
  if (offIn >= 0) {
    snprintf(buf, sizeof(buf), "off %ld:%02ld", offIn / 60, offIn % 60);
    textAt(128 - strlen(buf) * 6, 14, buf);
  }

  // Ten bars, F4 filled and the rest outlined, so the sfGFP band stands out
  // the way it does on the website's chart.
  const int16_t top = 24, bottom = 54, height = bottom - top;
  for (int16_t x = 0; x < 128; x += 4) oled.drawPixel(x, top - 1, SSD1306_WHITE);   // the axis top
  const char labels[10] = {'1', '2', '3', '4', '5', '6', '7', '8', 'C', 'N'};
  for (uint8_t i = 0; i < 10; i++) {
    int16_t x = 4 + i * 12;
    uint32_t v = liveFrame.ch[i];
    int16_t h = (int16_t)((v >= liveTop ? liveTop : v) * height / liveTop);
    if (i == CH_F4)  oled.fillRect(x + 1, bottom - h, 10, h + 1, SSD1306_WHITE);
    else if (h >= 2) oled.drawRect(x + 1, bottom - h, 10, h + 1, SSD1306_WHITE);
    else             oled.drawFastHLine(x + 1, bottom, 10, SSD1306_WHITE);
    oled.drawChar(x + 3, 57, labels[i], SSD1306_WHITE, SSD1306_BLACK, 1);
  }
}

static void drawIdle() {
  const char *headline = !linkWifiUp()    ? "Connecting Wi-Fi"
                       : !linkBackendUp() ? "Connecting backend"
                       :                    "Ready";
  textAt(0, 14, headline);
  textAt(0, 24, "Button: Live on/off");

  char buf[32];
  if (linkWifiUp()) snprintf(buf, sizeof(buf), "IP %s", linkIp().c_str());
  else              snprintf(buf, sizeof(buf), "SSID %s", WIFI_SSID);
  buf[21] = '\0';
  textAt(0, 34, buf);

  snprintf(buf, sizeof(buf), "Gain %s  %.0f ms", sensorGainName(), sensorIntegrationMs());
  textAt(0, 44, buf);

  if (hasLastReading) {
    snprintf(buf, sizeof(buf), "Last read F4 %u", lastReadingF4);
    textAt(0, 54, buf);
  }
}

static void draw() {
  lastDrawMs = millis();
  dirty = false;
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  drawStatusBar();

  if (noticeUntil)                           drawNotice();
  else if (ctrlState() == STATE_MEASURING)   drawMeasuring();
  else if (!sensorOk())                      drawSensorFault();
  else if (ctrlState() == STATE_LIVE)        drawLive();
  else                                       drawIdle();

  oled.display();
}

// ---- Public -------------------------------------------------------------

void displayBegin() {
  oledOk = i2cPresent(OLED_ADDR) && oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!oledOk) Serial.printf("# OLED @0x%02X not responding; measurements are unaffected\n", OLED_ADDR);
}

void displayMessage(const char *line1, const char *line2) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_WHITE);
  centered(20, line1);
  if (line2) centered(36, line2);
  oled.display();
}

void displayNotice(const char *line1, const char *line2) {
  strlcpy(noticeLine1, line1, sizeof(noticeLine1));
  strlcpy(noticeLine2, line2, sizeof(noticeLine2));
  noticeUntil = millis() + OLED_NOTICE_MS;
  if (noticeUntil == 0) noticeUntil = 1;   // 0 means "no notice"
  dirty = true;
}

void displayInvalidate() { dirty = true; }

void displayService() {
  if (!oledOk) return;
  unsigned long now = millis();
  if (noticeUntil && (long)(now - noticeUntil) >= 0) { noticeUntil = 0; dirty = true; }
  unsigned long since = now - lastDrawMs;
  if ((dirty && since >= OLED_MIN_REDRAW_MS) || since >= OLED_IDLE_REDRAW_MS) draw();
}

void displayLiveStarted() {
  hasLiveFrame = false;
  liveTop = LIVE_Y_BASE_COUNTS;
  dirty = true;
}

void displayLiveFrame(const Frame &f, bool lit) {
  liveFrame = f;
  liveFrameLit = lit;
  hasLiveFrame = true;
  uint32_t peak = 0;
  for (uint8_t i = 0; i < 10; i++) if (f.ch[i] > peak) peak = f.ch[i];
  if (peak > liveTop) liveTop = niceCeil(peak);   // steps up, never back down this session
  uint32_t fs = sensorFullScale();
  if (liveTop > fs) liveTop = fs;
  if (liveTop == 0) liveTop = 1;
  dirty = true;
}

void displayMeasureStep(const char *what, uint8_t step) {
  strlcpy(measureWhat, what, sizeof(measureWhat));
  measureStep = step;
  if (step <= 1) noticeUntil = 0;        // a notice from before must not hide the progress
  if (oledOk) draw();
}

void displayLastReading(uint16_t lightF4) {
  hasLastReading = true;
  lastReadingF4 = lightF4;
  dirty = true;
}

// =========================================================
// 5. Backend link: Wi-Fi and the WebSocket
//
// The device dials out to wss://<BACKEND_HOST>/api/hardware/device and keeps
// that connection open: the backend on Render cannot reach into a lab or
// home router. Every page reaches the device through the backend.
//
// ---- Protocol (field names are a contract across backend/app/hardware/
//      models.py, backend/app/live/models.py, and frontend/js/
//      hardware_processing.js -- change all of them together or none) ----
// Device -> backend
//   {"mode":"status", ...}       on connect, on every change, and every 5 s;
//                                 carries sensor_ok, live_on, live_off_in_s, led_on
//   {"mode":"live", ...}         one frame after another while Live is on;
//                                 "led" says whether the LED was lit for it
//   {"mode":"measurement", ...}  after a "read": dark_1 -> light -> dark_2
//   {"mode":"error", ...}        a read could not run: busy / sensor_offline
// Backend -> device
//   {"cmd":"live_start"} / {"cmd":"live_stop"}   a page flipped its Live switch
//   {"cmd":"led_on"} / {"cmd":"led_off"}         a page flipped its LED switch
//   {"cmd":"read","request_id":"..."}            take one reading
//
// Everything sent is unprocessed integer ADC counts: dark subtraction,
// normalization, unmixing and the 4PL fit all happen in the browser.
//
// TLS skips certificate validation (WebSockets 2.7.2 calls setInsecure() on
// ESP32 when no CA is given); ws.beginSslWithCA() is how to pin Render's root
// certificate later. The connection is not authenticated yet.
// =========================================================

static WebSocketsClient ws;
static bool wifiUp = false;
static bool wsStarted = false;           // started once, but only after Wi-Fi is actually up
static bool backendUp = false;
static unsigned long lastStatusMs = 0, lastWaitLogMs = 0;

bool   linkWifiUp()    { return wifiUp; }
bool   linkBackendUp() { return backendUp; }
int    linkRssi()      { return wifiUp ? WiFi.RSSI() : 0; }
String linkIp()        { return wifiUp ? WiFi.localIP().toString() : String(""); }

// ---- Outgoing ---------------------------------------------------------

static void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
}

// The format is part of the fingerprint contract: the website hashes
// Number(led_current_mA).toFixed(3) and String(gain), so the current goes out
// as a fixed 3-decimal string (a raw float would become 5.5529999...) and the
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
  // The one Live switch the button and every page share (section 6).
  doc["live_on"]   = ctrlLiveOn();
  long offIn = ctrlLiveOffInS();
  if (offIn >= 0) doc["live_off_in_s"] = offIn;
  else            doc["live_off_in_s"] = nullptr;
  // The LED switch within Live (section 6); only meaningful while live_on.
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
// 6. Controller: the one place that decides what the device does
//
// There are two ways to ask for something -- the website (via the backend)
// and the button -- and only this section acts on either. Neither input
// touches the LED or the sensor itself: web commands arrive inside
// ws.loop() and are only recorded, button presses are only counted by the
// button task, and loop() applies both in order. Nothing runs concurrently,
// so the two can never both drive the LED.
//
// Live is ONE switch, owned here, shared by the button and every web page:
//   - the button toggles it; the web's live_start / live_stop set it
//   - every change is reported at once in the status (live_on), which the
//     backend relays to every page, so all switches show the same state
//   - it switches itself off after LIVE_AUTO_OFF_MS
//   - it stays on across a backend disconnect (the OLED is a viewer too);
//     the auto-off bounds how long the LED can be left on
//   - it cannot be switched on during a measurement or without the sensor;
//     a refused request still sends a status, so a page's switch flips back
//
// Within Live, the LED is a second switch (led_on / led_off, web only; the
// button still toggles Live alone). Off, Live keeps streaming dark / ambient
// counts. It is refused unless Live is on, and every Live start resets it to
// on, so nobody finds Live dark because of a choice made earlier. It is
// applied between reads, never during one, so no frame mixes lit and dark,
// and every frame carries the LED state it was read with.
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

// The only writes to LED_PIN in the whole firmware.
static void ledSet(bool on) { digitalWrite(LED_PIN, on ? HIGH : LOW); }

static void setState(DeviceState next) {
  if (state == next) return;
  state = next;
  statusDirty = true;
  displayInvalidate();
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

// Both the button and the web end up here. Always marks the status dirty,
// even when nothing changes or the request is refused: the page that asked
// has already flipped its switch and needs the device's answer to settle it.
static void setLiveOn(bool on, const char *source) {
  statusDirty = true;
  if (on == liveOn) return;
  if (on && state == STATE_MEASURING) {
    displayNotice("Busy", "Measurement running");
    return;
  }
  if (on && !sensorOk()) {
    displayNotice("Sensor fault", "Live unavailable");
    return;
  }
  liveOn = on;
  if (on) {
    liveOnSince = millis();
    ledWanted = true;                    // every Live starts lit
  }
  Serial.printf("# Live %s (%s)\n", on ? "on" : "off", source);
  displayInvalidate();
}

void ctrlWebLive(bool on) { setLiveOn(on, "web"); }

// Answered like the Live switch: always a status, even when refused.
void ctrlWebLed(bool on) {
  statusDirty = true;
  if (!liveOn || on == ledWanted) return;
  ledWanted = on;
  Serial.printf("# Live LED %s (web)\n", on ? "on" : "off");
  displayInvalidate();
}

// Presses that land during a measurement are dropped with a notice rather
// than queued: toggling Live a second after the button was pressed would
// look like the device acting on its own.
static void handleButton() {
  uint32_t presses = buttonTakePresses();
  if (presses == 0) return;
  if (state == STATE_MEASURING) {
    displayNotice("Busy", "Measurement running");
    return;
  }
  for (uint32_t i = 0; i < presses; i++) setLiveOn(!liveOn, "button");
}

static void checkAutoOff() {
  if (!liveOn || millis() - liveOnSince < LIVE_AUTO_OFF_MS) return;
  liveOn = false;
  statusDirty = true;
  Serial.println("# Live off (auto-off)");
  displayNotice("Live off", "10 min auto-off");
}

// Whether the LED streams depends on exactly three things: the switch, the
// sensor, and whether a measurement holds the LED.
// Sets the LED for Live and restarts the settle wait, so the next frame is a
// clean one under the new state.
static void applyLiveLed() {
  liveLit = ledWanted;
  ledSet(liveLit);
  liveSettleMs = liveLit ? LIGHT_SETTLE_MS : DARK_SETTLE_MS;
  liveStartedMs = millis();
  lastLiveFrameMs = 0;
}

static void syncLive() {
  bool should = liveOn && sensorOk() && state != STATE_MEASURING;
  if (should && state == STATE_IDLE) {
    applyLiveLed();
    displayLiveStarted();
    setState(STATE_LIVE);
  } else if (should && state == STATE_LIVE && liveLit != ledWanted) {
    applyLiveLed();                      // between reads: loop() never gets here mid-read
  } else if (!should && state == STATE_LIVE) {
    ledSet(false);
    setState(STATE_IDLE);
  }
}

static void streamLiveFrame() {
  unsigned long now = millis();
  if (now - liveStartedMs < liveSettleMs) return;
  if (lastLiveFrameMs && now - lastLiveFrameMs < LIVE_PERIOD_MS) return;
  lastLiveFrameMs = now;                 // stamped before the read: the constant is a period, not a gap

  Frame f;
  sensorRead(f, ctrlPump);
  // Switched off, or a read request arrived, during the read: the LED may
  // already be off, so this frame is not a clean one to show.
  if (!liveOn || state != STATE_LIVE) return;

  // liveLit is what the LED did for this whole read: a web command during the
  // read only records ledWanted, and syncLive() applies it afterwards.
  linkSendLive(f, ++liveSeq, now, liveLit);
  displayLiveFrame(f, liveLit);
}

// ---- Web measurement: dark_1 -> light -> dark_2 ---------------------------

void ctrlWebRead(const char *requestId) {
  if (!sensorOk())                                  linkSendError(requestId, "sensor_offline");
  else if (state == STATE_MEASURING || readPending) linkSendError(requestId, "busy");
  else { strlcpy(readRequestId, requestId, sizeof(readRequestId)); readPending = true; }
}

void ctrlBackendLost() {
  readPending = false;                   // the backend has already given up on it
}

// The website averages the two darks to subtract and takes their difference
// as its read-noise estimate, so the light frame needs a dark on each side.
static void measureForWeb(const char *requestId) {
  ledSet(false);
  setState(STATE_MEASURING);
  flushStatus();                         // pages should see MEASURING before the 1.6 s it takes

  Frame dark1, light, dark2;
  unsigned long t0 = millis();

  displayMeasureStep("Web read", 1);
  delay(DARK_SETTLE_MS);
  sensorRead(dark1, ctrlPump);

  displayMeasureStep("Web read", 2);     // drawn before the LED goes on, so it adds no LED-on time
  ledSet(true);
  delay(LIGHT_SETTLE_MS);
  sensorRead(light, ctrlPump);
  ledSet(false);

  displayMeasureStep("Web read", 3);
  delay(DARK_SETTLE_MS);
  sensorRead(dark2, ctrlPump);

  unsigned long elapsed = millis() - t0;
  linkSendMeasurement(requestId, elapsed, dark1, light, dark2);
  Serial.printf("# web read %lums  light F3=%u F4=%u  dark F4=%u/%u\n",
                elapsed, light.ch[2], light.ch[CH_F4], dark1.ch[CH_F4], dark2.ch[CH_F4]);

  displayLastReading(light.ch[CH_F4]);
  setState(STATE_IDLE);                  // syncLive() resumes streaming if Live is still on
}

// ---- Blocking-work support --------------------------------------------------

void ctrlPump() {
  linkService();
  if (state == STATE_MEASURING) handleButton();   // outside a measurement, loop() handles it
  flushStatus();
  yield();
}

// ---- Serial diagnostics -----------------------------------------------------

bool ctrlClaim(const char *what) {
  if (state != STATE_IDLE || liveOn) return false;
  setState(STATE_MEASURING);             // a web read now gets "busy" instead of grabbing the LED
  flushStatus();
  displayMeasureStep(what, 0);
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

  handleButton();

  // Between whole reads, never inside one: loop() is sequential, so the bus is idle here.
  if (state != STATE_MEASURING && millis() - lastSensorCheckMs >= SENSOR_CHECK_MS) {
    lastSensorCheckMs = millis();
    if (sensorCheck()) {
      statusDirty = true;
      displayInvalidate();
      if (!sensorOk() && liveOn) {
        liveOn = false;                  // don't restart the LED by surprise when the wire is reseated
        displayNotice("Sensor fault", "Live switched off");
      }
    }
  }

  checkAutoOff();
  syncLive();
  flushStatus();

  if (state == STATE_LIVE) streamLiveFrame();
  flushStatus();

  displayService();
}

// =========================================================
// 7. Serial diagnostics (115200 baud)
//
// Troubleshooting only; every measurement is started by the website.
//   ?  current settings      i  I2C scan          b  button level
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
                  "#    Normal settings are t59 s999 (full scale 60000, integration 167ms). **\n",
                  (unsigned long)fs);
}

static void printHelp() {
  Serial.println("# commands: ? settings  i I2C scan  b button  l toggle LED  d dark/light table");
  Serial.println("#           g<0-10> gain   t<0-255> atime   s<1-65535> astep");
  Serial.println("# measurements come from the website; Live from the website or the button.");
}

// Shape is locked down: one lowercase letter, or a letter plus digits only.
// Reading just the first letter once turned "test1" into an ATIME of 0,
// dropping integration from 167 ms to 2.8 ms with no error at all.
static bool parseCommand(const String &s, char &c, long &v) {
  if (s.length() == 0) return false;
  c = s.charAt(0);
  String rest = s.substring(1);

  if (c == '?') return rest.length() == 0;
  switch (c) {
    case 'i': case 'b': case 'l': case 'd':
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
  for (uint8_t i = 0; i < DIAG_AVG; i++) { sensorRead(dk, ctrlPump); for (uint8_t c = 0; c < 10; c++) sd[c] += dk.ch[c]; }
  ctrlLed(true);  delay(LIGHT_SETTLE_MS);
  for (uint8_t i = 0; i < DIAG_AVG; i++) { sensorRead(lt, ctrlPump); for (uint8_t c = 0; c < 10; c++) sl[c] += lt.ch[c]; }
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
    case 'b':
      Serial.printf("# button (GPIO%d) %s\n", BUTTON_PIN, buttonHeld() ? "pressed" : "released");
      return;
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
      if (!ctrlClaim("Diagnostics")) { Serial.printf("# state is %s%s; switch Live off and try again\n", ctrlStateName(), ctrlLiveOn() ? " with Live on" : ""); return; }
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
// 8. setup / loop
// =========================================================
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);            // excitation off as early as possible

  Serial.begin(115200);
  Serial.printf("# CAPTURE-Screen %s  LED %.3f mA\n", BUILD_ID, LED_CURRENT_MA);

  Wire.begin(I2C_SDA, I2C_SCL);
  i2cScan();

  displayBegin();
  displayMessage("CAPTURE-Screen", BUILD_ID);

  if (!sensorBegin()) { displayMessage("AS7341 not found", "Check I2C wiring"); delay(2000); }

  buttonBegin();
  ctrlBegin();

  displayMessage("Connecting Wi-Fi", WIFI_SSID);
  linkBegin();
  diagBegin();
}

void loop() {
  ctrlLoop();
  diagService();
  delay(1);
}
