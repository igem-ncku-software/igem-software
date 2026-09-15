// =========================================================
// CAPTURE-Screen 韌體（iGEM NCKU-Tainan 2026）
//
// 硬體：ESP32-WROOM-32（DOIT DevKit V1 30-pin）
//       AS7341 光譜感測器（DFRobot SEN0365），I2C 於 GPIO 21 / 22
//       SSD1306 OLED 128×64，I2C 位址 0x3C
//       470 nm 激發 LED，GPIO 2 經 2N7000 低側開關
//       按鈕 GPIO 13（INPUT_PULLUP）
//
// 架構：軟體發問、裝置回答。裝置只負責「讀」，不做任何運算——
// 暗值扣除、正規化、解混全部在軟體端（frontend/js/hardware_processing.js）。
//
//   GET  /health   存活檢查
//   GET  /status   身分、狀態、感測器設定
//   POST /read     三段式量測：dark_1 → light → dark_2
//   WS   /live     連續串流（LED 常亮），送 {"cmd":"live_start"} / {"cmd":"live_stop"}
//
// 狀態機：IDLE / LIVE / MEASURING，LIVE 與 MEASURING 絕不同時進行
// （LIVE 的 LED 常亮會污染 MEASURING 的暗讀）。
//
// 執行緒：HTTP / WebSocket 的 handler 跑在 AsyncTCP 的 task 裡，不能在那裡
// 阻塞或碰 I2C。handler 只登記請求，所有感測器、LED、OLED 操作都在 loop()
// 裡做；兩邊共用的旗標由 ctrlMutex 保護。
//
// Wi-Fi 認證放在 secrets.h（不進版控），請從 secrets.h.example 複製一份。
//
// 需要的函式庫：DFRobot_AS7341、Adafruit SSD1306、Adafruit GFX、ArduinoJson 7、
// ESP32Async 的 AsyncTCP 與 ESPAsyncWebServer（原本 me-no-dev 的版本不支援
// ESP32 Arduino core 3.x）。
// =========================================================

#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <mutex>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DFRobot_AS7341.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>

#include "secrets.h"

// --- 1. 裝置常數：所有 JSON 回應原樣回傳 ---
#define DEVICE_ID        "capture-screen-p1"
#define BUILD_ID         "P1-PROTO-01"
#define FIRMWARE_VERSION "0.2.0"
#define LED_CURRENT_MA   5.553f   // 以三用電表量測，韌體無法自行讀取
#define MDNS_HOSTNAME    "capture-screen"

// --- 2. 感測器設定：一定要明確設定，不能用函式庫預設值 ---
// gain / atime / astep 會進入軟體端的正規化與 config fingerprint，
// 改這裡的值，/status 與 /read 回傳的值會跟著變。
const uint8_t  AS7341_AGAIN = 16;   // 16×，回報給軟體端的倍率
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
const unsigned long DARK_SETTLE_MS   = 50;   // LED 關閉後等待
const unsigned long LIGHT_SETTLE_MS  = 100;  // LED 開啟後等待穩定
const unsigned long LIVE_INTERVAL_MS = 200;  // LIVE 推送間隔
const unsigned long DEBOUNCE_MS      = 50;
const unsigned long WS_CLEANUP_MS    = 1000;

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

DFRobot_AS7341 as7341;

AsyncWebServer server(80);
AsyncWebSocket ws("/live");

// --- 5. 狀態機 ---
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

// 以下變數 handler（AsyncTCP task）與 loop() 都會碰，一律在 ctrlMutex 內讀寫。
std::mutex ctrlMutex;
DeviceState state = STATE_IDLE;
bool readReserved = false;           // POST /read 已被接受，還沒量完
bool readReady = false;              // request 已 pause，loop 可以開始量
AsyncWebServerRequestPtr pendingRead; // 暫停中的 POST /read，量完由 loop 回應
bool liveStartRequested = false;
bool liveStopRequested = false;
uint32_t liveOwnerId = 0;            // 送出 live_start 的 WebSocket client

// 只有 loop() 會碰。
uint32_t liveSeq = 0;
unsigned long lastLiveFrameMs = 0;
unsigned long lastWsCleanupMs = 0;

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

DeviceState currentState() {
  std::lock_guard<std::mutex> lock(ctrlMutex);
  return state;
}

// =========================================================
// 感測器
// =========================================================

// 讀一次完整十通道：兩段 SMUX（沿用原本的讀取邏輯）。
// 第一段給 F1–F4 與 Clear / NIR；第二段給 F5–F8，它另外附的 Clear / NIR
// 記在 mode2，量測序列會把它回傳為 clear_nir_mode2。
void readTenChannels(SpectralFrame &frame, ClearNir &mode2) {
  // 1. 讀取模式一：F1 ~ F4, Clear, NIR
  as7341.startMeasure(as7341.eF1F4ClearNIR);
  DFRobot_AS7341::sModeOneData_t data1 = as7341.readSpectralDataOne();
  frame.f1 = data1.ADF1;
  frame.f2 = data1.ADF2;
  frame.f3 = data1.ADF3;
  frame.f4 = data1.ADF4;
  frame.clr = data1.ADCLEAR;
  frame.nir = data1.ADNIR;

  // 2. 讀取模式二：F5 ~ F8
  as7341.startMeasure(as7341.eF5F8ClearNIR);
  DFRobot_AS7341::sModeTwoData_t data2 = as7341.readSpectralDataTwo();
  frame.f5 = data2.ADF5;
  frame.f6 = data2.ADF6;
  frame.f7 = data2.ADF7;
  frame.f8 = data2.ADF8;
  mode2.clr = data2.ADCLEAR;
  mode2.nir = data2.ADNIR;
}

// 三段式量測。delay() 會讓出 CPU，量測期間 HTTP 仍能回 409。
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

// Serial Plotter 格式（沿用原本的輸出）。
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

// 待機畫面：IP 與 mDNS 主機名稱。
void showIdleScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("CAPTURE-Screen");
  display.println("State: IDLE");
  display.print("IP: ");
  display.println(WiFi.localIP());
  display.println(MDNS_HOSTNAME ".local");
  display.println();
  display.println("Press button to read");
  display.display();
}

// =========================================================
// JSON
// =========================================================

void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
  doc["firmware_version"] = FIRMWARE_VERSION;
}

void addConfig(JsonObject config) {
  // 固定 3 位小數：float 直接序列化會變成 5.5529999…，軟體端算 fingerprint 會對不上。
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

String stateMessage(DeviceState s) {
  JsonDocument doc;
  doc["mode"] = "state";
  doc["state"] = stateName(s);
  String out;
  serializeJson(doc, out);
  return out;
}

String busyMessage() {
  JsonDocument doc;
  doc["error"] = "busy";
  doc["state"] = "MEASURING";
  String out;
  serializeJson(doc, out);
  return out;
}

// =========================================================
// HTTP / WebSocket handler（跑在 AsyncTCP task，不可阻塞、不可碰 I2C）
// =========================================================

void handleStatus(AsyncWebServerRequest *request) {
  JsonDocument doc;
  addIdentity(doc);
  doc["state"] = stateName(currentState());
  doc["uptime_ms"] = millis();
  doc["wifi_rssi"] = WiFi.RSSI();
  addConfig(doc["config"].to<JsonObject>());

  String body;
  serializeJson(doc, body);
  request->send(200, "application/json", body);
}

// 請求主體可以帶 {"note": "..."}，裝置不需要它，所以不讀。
void handleRead(AsyncWebServerRequest *request) {
  {
    std::lock_guard<std::mutex> lock(ctrlMutex);
    if (state == STATE_MEASURING || readReserved) {
      request->send(409, "application/json", busyMessage());
      return;
    }
    readReserved = true;
  }

  // 量測要 ~500 ms，不能在這裡做：先暫停 request，交給 loop() 量完再回應。
  AsyncWebServerRequestPtr paused = request->pause();
  std::lock_guard<std::mutex> lock(ctrlMutex);
  pendingRead = paused;
  readReady = true;
}

void onWsEvent(AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type,
               void *arg, uint8_t *data, size_t len) {
  switch (type) {
    case WS_EVT_CONNECT:
      client->text(stateMessage(currentState()));
      break;

    case WS_EVT_DISCONNECT: {
      // 瀏覽器分頁關掉也會走到這裡：LED 不能因此一直亮著。
      std::lock_guard<std::mutex> lock(ctrlMutex);
      if (client->id() == liveOwnerId) liveStopRequested = true;
      break;
    }

    case WS_EVT_DATA: {
      AwsFrameInfo *info = (AwsFrameInfo *)arg;
      if (!(info->final && info->index == 0 && info->len == len && info->opcode == WS_TEXT)) return;

      JsonDocument doc;
      if (deserializeJson(doc, data, len)) {
        client->text("{\"error\":\"bad_json\"}");
        return;
      }
      const char *cmd = doc["cmd"] | "";

      if (strcmp(cmd, "live_start") == 0) {
        bool busy = false;
        {
          std::lock_guard<std::mutex> lock(ctrlMutex);
          if (state == STATE_MEASURING || readReserved) {
            busy = true;
          } else {
            liveStartRequested = true;
            liveStopRequested = false;
            liveOwnerId = client->id();
          }
        }
        if (busy) client->text(busyMessage());
      } else if (strcmp(cmd, "live_stop") == 0) {
        std::lock_guard<std::mutex> lock(ctrlMutex);
        liveStopRequested = true;
        liveStartRequested = false;
      } else {
        client->text("{\"error\":\"unknown_cmd\"}");
      }
      break;
    }

    default:
      break;
  }
}

void setupServer() {
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Private-Network", "true");

  server.on("/health", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->send(200, "application/json", "{\"ok\":true}");
  });
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/read", HTTP_POST, handleRead);

  ws.onEvent(onWsEvent);
  server.addHandler(&ws);

  // CORS preflight：任何路徑的 OPTIONS 都回 204（標頭由 DefaultHeaders 附上）。
  server.onNotFound([](AsyncWebServerRequest *request) {
    if (request->method() == HTTP_OPTIONS) {
      request->send(204);
    } else {
      request->send(404, "application/json", "{\"error\":\"not_found\"}");
    }
  });

  server.begin();
}

// =========================================================
// loop() 端的狀態轉移
// =========================================================

void handleLiveRequests() {
  bool noClients = ws.count() == 0;
  bool started = false;
  bool stopped = false;
  {
    std::lock_guard<std::mutex> lock(ctrlMutex);
    if (liveStopRequested) {
      liveStopRequested = false;
      liveStartRequested = false;
      if (state == STATE_LIVE) {
        state = STATE_IDLE;
        stopped = true;
      }
    } else if (liveStartRequested) {
      liveStartRequested = false;
      if (state == STATE_IDLE) {
        state = STATE_LIVE;
        started = true;
      }
    }
    // 保險：所有 client 都斷了還在 LIVE，一樣收掉。
    if (state == STATE_LIVE && noClients && !started) {
      state = STATE_IDLE;
      stopped = true;
    }
  }

  if (started) {
    digitalWrite(LED_PIN, HIGH);
    lastLiveFrameMs = 0;
    ws.textAll(stateMessage(STATE_LIVE));
  }
  if (stopped) {
    digitalWrite(LED_PIN, LOW);
    ws.textAll(stateMessage(STATE_IDLE));
    showIdleScreen();
  }
}

void handleReadRequest() {
  AsyncWebServerRequestPtr requestPtr;
  bool wasLive = false;
  {
    std::lock_guard<std::mutex> lock(ctrlMutex);
    if (!readReady) return;
    requestPtr = pendingRead;
    pendingRead.reset();
    readReady = false;
    wasLive = state == STATE_LIVE;
    state = STATE_MEASURING;
    liveStartRequested = false;
  }

  // LIVE 中收到 /read：先停串流（LED 關），量完回 IDLE，不自動恢復 LIVE。
  if (wasLive) digitalWrite(LED_PIN, LOW);
  ws.textAll(stateMessage(STATE_MEASURING));
  showMessage("Measuring...", "dark / light / dark");

  MeasurementResult result;
  runMeasurementSequence(result);

  JsonDocument doc;
  doc["mode"] = "measurement";
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

  String body;
  serializeJson(doc, body);

  // 先回 IDLE 再回應：client 收到結果後立刻再送 /read 不該拿到 409。
  {
    std::lock_guard<std::mutex> lock(ctrlMutex);
    state = STATE_IDLE;
    readReserved = false;
  }

  // client 在量測途中斷線時 lock() 會拿到空指標，結果直接丟掉。
  if (auto request = requestPtr.lock()) {
    request->send(200, "application/json", body);
  }

  printFrameSerial(result.light);
  ws.textAll(stateMessage(STATE_IDLE));
  showIdleScreen();
}

// 按鈕短按：只在 IDLE 時執行一次本機量測，結果只顯示在 OLED。
void onButtonPress() {
  {
    std::lock_guard<std::mutex> lock(ctrlMutex);
    if (state != STATE_IDLE || readReserved) return;
    state = STATE_MEASURING;
  }

  showMessage("Measuring...", "(button)");
  MeasurementResult result;
  runMeasurementSequence(result);

  {
    std::lock_guard<std::mutex> lock(ctrlMutex);
    state = STATE_IDLE;
  }

  printFrameSerial(result.light);
  showFrame(result.light);
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

void streamLiveFrame() {
  lastLiveFrameMs = millis();

  SpectralFrame frame;
  ClearNir unused;
  readTenChannels(frame, unused);

  // 讀這一幀的期間可能收到 live_stop 或 /read：狀態已經不是 LIVE 就不推送。
  if (currentState() != STATE_LIVE) return;

  JsonDocument doc;
  doc["mode"] = "live";
  doc["seq"] = ++liveSeq;
  doc["t_ms"] = lastLiveFrameMs;
  addFrame(doc["raw"].to<JsonObject>(), frame);

  String out;
  serializeJson(doc, out);
  ws.textAll(out);

  printFrameSerial(frame);
  showFrame(frame);
}

// =========================================================

void setup() {
  // 開機安全：最早就把激發 LED 關掉，Wi-Fi 連線期間不能亮。
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL);

  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  showMessage("Connecting Wi-Fi...", nullptr);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // 省電模式會讓 WebSocket 推送延遲、更新率掉下來
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("Wi-Fi Connected!");
  display.print("IP: ");
  display.println(WiFi.localIP());
  display.display();
  delay(1500);

  while (as7341.begin() != 0) {
    showMessage("AS7341 not found", "Check I2C wiring");
    Serial.println("AS7341 init failed");
    delay(1000);
  }
  as7341.setAtime(AS7341_ATIME);
  as7341.setAstep(AS7341_ASTEP);
  as7341.setAGAIN(AS7341_AGAIN_REGISTER);

  if (MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
  } else {
    Serial.println("mDNS start failed; use the IP address instead");
  }

  setupServer();
  showIdleScreen();
}

void loop() {
  handleLiveRequests();
  handleReadRequest();
  handleButton();

  if (currentState() == STATE_LIVE && millis() - lastLiveFrameMs >= LIVE_INTERVAL_MS) {
    streamLiveFrame();
  }

  if (millis() - lastWsCleanupMs >= WS_CLEANUP_MS) {
    lastWsCleanupMs = millis();
    ws.cleanupClients();
  }

  delay(1);
}
