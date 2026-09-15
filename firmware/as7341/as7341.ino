// =========================================================
// CAPTURE-Screen 韌體（iGEM NCKU-Tainan 2026）
//
// 硬體：ESP32-WROOM-32（DOIT DevKit V1 30-pin）
//       AS7341 光譜感測器（DFRobot SEN0365），I2C 於 GPIO 21 / 22
//       SSD1306 OLED 128×64，I2C 位址 0x3C
//       470 nm 激發 LED，GPIO 2 經 2N7000 低側開關
//       按鈕 GPIO 13（INPUT_PULLUP）
//
// 通電、連上 Wi-Fi 之後，裝置自己連出去後端的 WebSocket
//   wss://<BACKEND_HOST>/api/hardware/device
// 並一直保持連線（斷了會自動重連）。後端在 Render 上，連不進家用或實驗室的
// 路由器，所以一定是裝置主動連出去；網頁上的即時光譜、量測、校正都走這一條。
//
// 裝置只負責「讀」，不做任何運算——暗值扣除、正規化、解混都在網頁端
// （frontend/js/hardware_processing.js）。
//
// 裝置 → 後端
//   {"mode":"status", ...}       連上時、狀態改變時，之後每 5 秒一次
//   {"mode":"live", ...}         有人開著即時光譜時，每 200 ms 一幀
//   {"mode":"measurement", ...}  收到 read 後的三段式量測 dark_1 → light → dark_2
//   {"mode":"error", ...}        指令無法執行（busy）
// 後端 → 裝置
//   {"cmd":"live_start"} / {"cmd":"live_stop"}   有沒有人在看即時光譜
//   {"cmd":"read","request_id":"..."}             量一次
//
// 狀態機：IDLE / LIVE / MEASURING。LED 只在有人看即時光譜或量測的那一刻亮：
// 一直亮著會加熱、漂白 cuvette 裡的樣品。量測會暫停串流（LED 常亮會污染暗讀），
// 量完只要還有人在看就自動恢復。與後端斷線時一律關 LED。
//
// 全部工作都在 loop() 裡：WebSocketsClient 的事件回呼也是從 ws.loop() 裡呼叫，
// 不會跟 loop() 同時執行，所以不需要 mutex。回呼只登記指令，量測在 loop() 做。
//
// secrets.h（不進版控，從 secrets.h.example 複製）放 Wi-Fi 認證；要接本機後端時
// 也在那裡覆寫 BACKEND_HOST / BACKEND_PORT / BACKEND_USE_TLS。
// 目前這條連線沒有身份驗證：知道網址的人都能冒充裝置。
//
// 需要的函式庫：DFRobot_AS7341、Adafruit SSD1306、Adafruit GFX、ArduinoJson 7、
// WebSockets（Markus Sattler / Links2004，Library Manager 搜尋 "WebSockets"）。
// =========================================================

#include <Wire.h>
#include <WiFi.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DFRobot_AS7341.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

#include "secrets.h"

// --- 0. 後端位置：預設是 Render 上的正式後端，secrets.h 可以覆寫 ---
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

// --- 1. 裝置常數：原樣放進每一則 status / measurement ---
#define DEVICE_ID        "capture-screen-p1"
#define BUILD_ID         "P1-PROTO-01"
#define FIRMWARE_VERSION "0.3.0"
#define LED_CURRENT_MA   5.553f   // 以三用電表量測，韌體無法自行讀取

// --- 2. 感測器設定：一定要明確設定，不能用函式庫預設值 ---
// gain / atime / astep 會進入網頁端的正規化與 config fingerprint，
// 改這裡的值，status 與 measurement 回報的值會跟著變。
const uint8_t  AS7341_AGAIN = 16;   // 16×，回報給網頁端的倍率
// DFRobot 的 setAGAIN() 收的是暫存器索引不是倍率：
// 0..10 對應 0.5×, 1×, 2×, 4×, 8×, 16×, 32×, 64×, 128×, 256×, 512×。
// 改 AS7341_AGAIN 時這個索引要一起改。
const uint8_t  AS7341_AGAIN_REGISTER = 5;
const uint8_t  AS7341_ATIME = 29;
const uint16_t AS7341_ASTEP = 599;

// --- 3. 腳位 ---
const int LED_PIN    = 2;
const int BUTTON_PIN = 13;
const int I2C_SDA    = 21;
const int I2C_SCL    = 22;

// --- 4. 時序 ---
const unsigned long DARK_SETTLE_MS      = 50;     // LED 關閉後等待
const unsigned long LIGHT_SETTLE_MS     = 100;    // LED 開啟後等待穩定
const unsigned long LIVE_INTERVAL_MS    = 200;    // 即時串流一幀的間隔
const unsigned long STATUS_INTERVAL_MS  = 5000;   // 狀態心跳；後端 15 秒沒收到就當離線
const unsigned long RECONNECT_MS        = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;  // 偵測「斷了卻沒收到通知」的連線
const unsigned long WS_PONG_TIMEOUT_MS  = 5000;
const uint8_t       WS_MISSED_PONGS     = 2;
const unsigned long DEBOUNCE_MS         = 50;

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

DFRobot_AS7341 as7341;
WebSocketsClient ws;

// --- 5. 狀態 ---
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

DeviceState state = STATE_IDLE;
bool backendConnected = false;
bool liveWanted = false;        // 後端說有人開著即時光譜
bool readPending = false;       // 收到 read，還沒量
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
// 感測器
// =========================================================

// 讀一次完整十通道：兩段 SMUX（沿用原本的讀取邏輯）。
// 第一段給 F1–F4 與 Clear / NIR；第二段給 F5–F8，它另外附的 Clear / NIR
// 記在 mode2，量測序列會把它回傳為 clear_nir_mode2。
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

// Serial Plotter 格式（沿用原本的輸出），USB 接電腦時方便除錯。
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

// 讀值畫面：左右雙欄排版（沿用原本的排版）。
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

// 待機畫面：Wi-Fi 與後端連線狀態，裝置沒出現在網頁上時先看這裡。
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

// 連線狀態改變時才重畫待機畫面，按鈕量測的結果才不會一下就被蓋掉。
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
// 對後端的訊息
// =========================================================

void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
  doc["firmware_version"] = FIRMWARE_VERSION;
}

void addConfig(JsonObject config) {
  // 固定 3 位小數：float 直接序列化會變成 5.5529999…，網頁端算 fingerprint 會對不上。
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
// 後端的指令（在 ws.loop() 裡被呼叫：只登記，不量測）
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
      sendStatus();
      break;
    case WStype_DISCONNECTED:
      backendConnected = false;
      liveWanted = false;   // 沒有後端就沒有人在看：LED 不能因此一直亮著
      readPending = false;  // 後端已經放棄這次讀取
      break;
    case WStype_TEXT:
      handleCommand(payload, length);
      break;
    default:
      break;
  }
}

// =========================================================
// loop() 端的工作
// =========================================================

// 量一次。requestId 為 nullptr 表示按鈕觸發，結果只顯示在 OLED。
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
  setState(STATE_IDLE);  // 還有人在看的話，下一輪 syncLive() 會恢復串流
  if (!requestId) showFrame(result.light);
}

// 串流開不開只看兩件事：有沒有人在看、現在是不是在量測。
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

// 按鈕短按：在裝置上量一次，結果只顯示在 OLED，不送出去。
void onButtonPress() {
  if (state == STATE_MEASURING || readPending) return;
  measure(nullptr);
}

// 非阻塞防彈跳：按下的邊緣觸發一次。
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
  // 開機安全：最早就把激發 LED 關掉。
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
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // 省電模式會讓串流延遲、更新率掉下來
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }

  // TLS 沒有釘憑證：library 在 ESP32 上沒給 CA 時略過驗證。若握手失敗，改用
  // ws.beginSslWithCA() 帶入 Render 憑證鏈的根憑證。
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

  refreshIdleScreen();
  delay(1);
}
