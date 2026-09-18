// =========================================================
// CAPTURE-Screen 韌體 v6.0 —— 只跑 LasReader 網站要的工作流
//
// 這台機器是 P1-PROTO-01:單一比色皿、90° 螢光讀取器。
//   激發:Cree C503B 470nm,2N7000 低側開關,434Ω 限流,實測 5.553 mA
//   偵測:DFRobot SEN0365(AS7341,I2C 0x39),90° 收光,目前沒裝發射濾片
//   控制:ESP32-WROOM-32 DOIT DevKit V1
//   顯示:SSD1306 OLED(I2C 0x3C)—— 只做本機狀態顯示,不參與量測
// 沒有按鈕。所有量測都由網站發動。
//
// 工作流只有一條:開機 -> 連 Wi-Fi -> 主動連出去到後端的 WebSocket
//   wss://<BACKEND_HOST>/api/hardware/device
// 並一直保持連線(斷線自動重連)。後端在 Render 上,連不進實驗室或家裡的
// 路由器,所以一定是裝置往外連。網頁的即時光譜、量測、校正全部經過這條連線。
//
// ---- 和後端的協定(欄位名稱是合約:backend/app/hardware/models.py、
//      backend/app/live/models.py、frontend/js/hardware_processing.js 三邊要一起改)----
// 裝置 -> 後端
//   {"mode":"status", ...}       連上時、狀態改變時、之後每 5 秒
//   {"mode":"live", ...}         有人開著即時光譜時一張接一張
//   {"mode":"measurement", ...}  收到 read 後量一次 dark_1 -> light -> dark_2(原始 counts)
//   {"mode":"error", ...}        指令無法執行:busy / sensor_offline
// 後端 -> 裝置
//   {"cmd":"live_start"} / {"cmd":"live_stop"}   有沒有人在看即時光譜
//   {"cmd":"read","request_id":"..."}            量一次
//
// 裝置只「讀」不算:扣暗態、正規化、解混、4PL 擬合全都在網頁端做
// (frontend/js/hardware_processing.js 與 hardware_local.js)。韌體送出去的
// 永遠是未經處理的整數 ADC counts。
//
// 狀態機:IDLE / LIVE / MEASURING。LED 只在有人看即時光譜或量測中才亮:
// 一直亮會讓比色皿裡的樣品發熱、光漂白。量測會暫停串流,量完若還有人在看
// 會自動恢復。和後端斷線時 LED 一律關掉。
//
// --- 改之前先看 ---
//
// 1. include 順序不可調動。DFRobot_AS7341.h 有 `#define ERR_OK 0`,
//    ESP32 的 lwIP (err.h) 有同名 enum 成員。DFRobot 排在 WiFi.h 前面會把
//    `ERR_OK = 0,` 換成 `0 = 0,`,整個 enum 編不過。
//
// 2. gain 的倍率由暫存器索引算出來,不是兩個要手動同步的常數。
//    改一個忘了改另一個,網頁端的 config fingerprint 會安靜地對不上。
//
// 3. config 的序列化格式是合約的一部分。網頁端的 fingerprint 規則是
//    `Number(led_current_mA).toFixed(3)` 與 `String(gain)`,所以 LED 電流
//    一定要送固定 3 位小數的字串,gain 是整數就要送整數(只有 0.5× 例外)。
//    直接丟 float 會變成 5.5529999…,fingerprint 就對不上,已存的校正曲線
//    會全部被判成 stale。
//
// 4. 量測期間會呼叫 pump():餵 WebSocket 並照常送 status。
//    WebSocket 回呼只「登記」指令(量測中收到 read 直接回 busy),
//    實際量測永遠在 loop() 裡做,所以不會有並行,也不需要鎖。
//
// 5. 感測器是否存在用 I2C ACK 判斷,不看讀值。
//    盒子蓋上且 LED 關閉時所有通道本來就讀 0,那是正常暗態不是失聯。
//
// 6. FIRMWARE_VERSION、BUILD_ID、gain、ATIME、ASTEP、LED 電流都算進網頁的
//    config fingerprint。改了任何一個,網頁上用舊設定做的校正曲線就會變成
//    stale —— 讀值路徑變了本來就該如此。
//
// Wi-Fi 帳密放在 secrets.h(不進 git):把 secrets.h.example 複製成 secrets.h 再填。
// 要連本機後端,也在 secrets.h 裡覆寫 BACKEND_HOST / BACKEND_PORT / BACKEND_USE_TLS。
// 這條連線目前沒有驗證:知道網址的人都能假冒裝置。
//
// 需要的函式庫:DFRobot_AS7341、Adafruit SSD1306、Adafruit GFX、ArduinoJson 7、
// WebSockets(Markus Sattler / Links2004,程式庫管理員搜 "WebSockets")。
// 硬體頁寫的是 Adafruit AS7341,但板子是 DFRobot SEN0365,這裡沿用 DFRobot 的
// 函式庫(已確認能編譯過)。要換成 Adafruit 的只需改 readOnce() 一個函式。
// Serial Monitor(115200)會印 [wifi] / [backend] 連線狀態,連不上先看這裡。
// =========================================================

// ---- include 順序:網路先、感測器後(見上方說明 1)----
#include <WiFi.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DFRobot_AS7341.h>

#ifdef ERR_OK
#undef ERR_OK            // 拆掉 DFRobot 的巨集,免得之後又撞到 lwIP
#endif

#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "找不到 secrets.h:把 firmware/capture_screen/secrets.h.example 複製成 secrets.h,填入 Wi-Fi 帳密"
#endif
#if !defined(WIFI_SSID) || !defined(WIFI_PASSWORD)
  #error "secrets.h 必須定義 WIFI_SSID 與 WIFI_PASSWORD"
#endif

// =========================================================
// 1. 設定
// =========================================================
// 後端位置:預設是 Render 上的正式後端,secrets.h 可以覆寫
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

// 原封不動放進每一則 status / measurement(見上方說明 6)
#define DEVICE_ID        "capture-screen-p1"
#define BUILD_ID         "P1-PROTO-01"
#define FIRMWARE_VERSION "6.0.0"
#define LED_CURRENT_MA   5.553f     // 2026-08-25 三用電表實測,韌體讀不到

// ---- 腳位 ----
// iGEM 參考設計是 GPIO2 經 2N7000 低側開關。這台實機目前接在 25:
// GPIO2 是 strapping pin 而且多數 DevKit 上接了板載 LED,開機行為不乾淨。
// 換回 2 的話把下面改掉即可,其餘程式不受影響。
const int LED_PIN = 25;
const int I2C_SDA = 21;
const int I2C_SCL = 22;

const uint8_t AS7341_ADDR = 0x39;
const uint8_t OLED_ADDR   = 0x3C;

// ---- 感測器參數 ----
// 滿刻度 =(ATIME+1)×(ASTEP+1),上限 65535;積分時間 = 該值 × 2.78µs。
// 下面這組:滿刻度 60000、積分約 167ms。全通道讀一次(兩個 SMUX 週期)
// 實測 451.6ms,加上 100ms 穩定時間就是硬體頁記的 551~552ms 開燈窗。
uint8_t  AGAIN_CODE = 10;    // 暫存器索引 0..10 -> 0.5× 1× 2× 4× 8× 16× 32× 64× 128× 256× 512×
uint8_t  ATIME_VAL  = 59;
uint16_t ASTEP_VAL  = 999;

// ---- 時間 ----
const unsigned long DARK_SETTLE_MS      = 50;     // 關 LED 後等多久
const unsigned long LIGHT_SETTLE_MS     = 100;    // 開 LED 後等它穩定(硬體頁實測值)
const unsigned long LIVE_INTERVAL_MS    = 300;    // 串流張與張之間留給 ws.loop()
const unsigned long STATUS_INTERVAL_MS  = 5000;   // 後端 15 秒沒消息就當離線
const unsigned long WIFI_BOOT_WAIT_MS   = 10000;  // 開機最多等 Wi-Fi 這麼久,之後在 loop() 裡繼續追
const unsigned long RECONNECT_MS        = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;  // 抓出沒通知就斷掉的連線
const unsigned long WS_PONG_TIMEOUT_MS  = 10000;  // 量測中有 pump(),最長空檔約一次讀取
const uint8_t       WS_MISSED_PONGS     = 2;
const unsigned long WAITING_LOG_MS      = 10000;  // 連不上後端時多久印一次 Serial
const unsigned long OLED_REFRESH_MS     = 1000;   // 待機畫面重畫間隔

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
DFRobot_AS7341 as7341;
WebSocketsClient ws;

const char* CH_NAME[10] = {"F1","F2","F3","F4","F5","F6","F7","F8","CLR","NIR"};

// ---- 型別:一定要放在「第一個函式定義」之前 ----
// Arduino 會自動產生所有函式的原型,並插在檔案裡第一個函式定義的前面。
// 如果 struct / enum 定義在那個位置之後,插進去的原型(例如 void readOnce(Frame&))
// 就會看不到型別,編譯時報一整串 "'Frame' was not declared in this scope"。
struct Frame { uint16_t ch[10]; };       // F1..F8, CLR, NIR,原始 ADC counts
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

// =========================================================
// 2. 狀態
// =========================================================
DeviceState state = STATE_IDLE;

bool sensorOk = false;
bool oledOk = false;             // OLED 掉線不能拖垮量測,所以每次畫之前都看這個旗標
bool wifiOk = false;
bool wsStarted = false;          // WebSocket 只啟動一次,但要等 Wi-Fi 真的連上
bool backendConnected = false;
bool liveWanted = false;         // 後端說有人開著即時光譜
bool readPending = false;        // 收到 read 還沒量
char readRequestId[40] = "";

uint32_t liveSeq = 0;
unsigned long liveStartedMs = 0, lastLiveFrameMs = 0, lastStatusMs = 0;

// =========================================================
// 3. 感測器設定
// =========================================================
// gain 倍率由索引算出,不可能和實際寫入的值走鐘(見上方說明 2)
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

// 前向宣告
void sendStatus();
void drawIdleScreen();

// =========================================================
// 4. I2C
// =========================================================
bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

void i2cScan() {
  Serial.print("# I2C 掃描:");
  uint8_t n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    if (i2cPresent(a)) {
      Serial.printf(" 0x%02X", a);
      if (a == AS7341_ADDR) Serial.print("(AS7341)");
      if (a == OLED_ADDR)   Serial.print("(OLED)");
      n++;
    }
  }
  if (n == 0) Serial.print(" 沒有任何裝置回應 —— 檢查 SDA/SCL/VCC/GND");
  Serial.println();
}

// =========================================================
// 5. 讀取
// =========================================================

// 量測中讓連線活著(見上方說明 4)。只從 loop() 這一側呼叫,不會從回呼裡呼叫。
void pump() {
  if (wsStarted) ws.loop();
  if (backendConnected && millis() - lastStatusMs >= STATUS_INTERVAL_MS) sendStatus();
  yield();
}

// 全部十個通道讀一次。AS7341 一次只能繞出六個通道,所以要跑兩個 SMUX 週期;
// CLR / NIR 兩邊都有,這裡取第一個週期的值(第二個週期的那組網頁沒用到)。
void readOnce(Frame &f) {
  as7341.startMeasure(as7341.eF1F4ClearNIR);
  DFRobot_AS7341::sModeOneData_t d1 = as7341.readSpectralDataOne();
  f.ch[0] = d1.ADF1; f.ch[1] = d1.ADF2; f.ch[2] = d1.ADF3; f.ch[3] = d1.ADF4;
  f.ch[8] = d1.ADCLEAR; f.ch[9] = d1.ADNIR;

  as7341.startMeasure(as7341.eF5F8ClearNIR);
  DFRobot_AS7341::sModeTwoData_t d2 = as7341.readSpectralDataTwo();
  f.ch[4] = d2.ADF5; f.ch[5] = d2.ADF6; f.ch[6] = d2.ADF7; f.ch[7] = d2.ADF8;

  pump();                        // 一次讀取約 452ms,中間餵一下連線
}

// =========================================================
// 6. OLED(只顯示狀態,不參與量測)
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

// 待機畫面:網頁上看不到裝置時,先看這裡是卡在 Wi-Fi 還是卡在後端
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

// 待機時定期重畫:Wi-Fi 的 IP、後端狀態都會變,而且沒有按鈕可以叫它更新
void refreshIdleScreen() {
  static unsigned long last = 0;
  if (state != STATE_IDLE) return;
  if (millis() - last < OLED_REFRESH_MS) return;
  last = millis();
  drawIdleScreen();
}

// 十個通道兩欄排(即時串流與網頁量測後顯示)
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
// 7. 對後端的訊息
// =========================================================
void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
  doc["firmware_version"] = FIRMWARE_VERSION;
}

// 序列化格式是合約的一部分(見上方說明 3)
void addConfig(JsonObject c) {
  c["led_current_mA"] = serialized(String(LED_CURRENT_MA, 3));
  if (AGAIN_CODE == 0) c["gain"] = serialized(String("0.5"));   // 只有 0.5x 不是整數
  else                 c["gain"] = (uint16_t)gainMultiplier();
  c["atime"] = ATIME_VAL;
  c["astep"] = ASTEP_VAL;
}

// 合約要求原始 ADC counts 是非負整數
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
  doc["state"]     = stateName();
  doc["uptime_ms"] = millis();
  doc["wifi_rssi"] = WiFi.RSSI();
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
// 8. 網頁量測:dark_1 -> light -> dark_2,原始 counts 送回後端
// =========================================================
// 網頁端(hardware_processing.js)拿兩張暗態的平均去扣,兩張的差值同時也是
// 讀取雜訊的估計,所以亮態前後各量一張,不能只量一張。
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

  Serial.printf("# 網頁量測 %lums  light F3=%u F4=%u  dark F4=%u/%u\n",
                (unsigned long)(millis() - t0), light.ch[2], light.ch[3],
                dark1.ch[3], dark2.ch[3]);

  setState(STATE_IDLE);     // 還有人在看的話,下一次 syncLive() 會恢復串流
  showFrame(light);
}

// =========================================================
// 9. 即時串流
// =========================================================
// 串不串流只看兩件事:有沒有人在看、有沒有在量測。
// LED 只在有人看的時候亮,連續照射會讓比色皿裡的樣品發熱、光漂白。
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
  if (now - lastLiveFrameMs < LIVE_INTERVAL_MS) return;
  lastLiveFrameMs = now;

  Frame f;
  readOnce(f);
  if (state != STATE_LIVE) return;       // 讀取期間斷線或有人停看

  JsonDocument doc;
  doc["mode"] = "live";
  doc["seq"] = ++liveSeq;
  doc["t_ms"] = now;
  addFrame(doc["raw"].to<JsonObject>(), f);
  sendJson(doc);

  showFrame(f);
}

// =========================================================
// 10. 後端指令(在 ws.loop() 裡被呼叫:只登記,不量測)
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
      liveWanted = false;     // 沒有後端就沒人在看,LED 不能因此一直亮著
      readPending = false;    // 後端已經放棄這次量測
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

// Wi-Fi 可能比 setup() 的等待時間晚才連上,所以狀態要在 loop() 裡持續追蹤,
// 而且 WebSocket 要等 Wi-Fi 真的通了才啟動。
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
    // TLS 沒有釘憑證:WebSockets 2.7.2 在 ESP32 上沒給 CA 時會 setInsecure()。
    // 要驗證憑證就改用 ws.beginSslWithCA() 帶入 Render 的根憑證。
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

// 卡在連不上後端時定期印出(Wi-Fi 密碼、網址、TLS,或後端在睡)
void logWhileWaitingForBackend() {
  static unsigned long last = 0;
  if (backendConnected || millis() - last < WAITING_LOG_MS) return;
  last = millis();
  Serial.printf("[backend] still connecting to %s:%d (Wi-Fi %s, RSSI %d dBm)\n",
                BACKEND_HOST, BACKEND_PORT, wifiOk ? "up" : "down", WiFi.RSSI());
}

// =========================================================
// 11. Serial 診斷指令
// =========================================================
// 量測全部由網頁發動,Serial 這裡只留「裝不上線 / 讀值不對」時要用的工具:
//   ?  目前設定      i  I2C 掃描     l  手動開關 LED    d  暗態/亮態對照
//   g<0-10> gain     t<0-255> ATIME  s<1-65535> ASTEP
// g/t/s 會算進 fingerprint,改完馬上送一則 status 讓網頁知道。
const uint8_t DIAG_AVG = 8;     // d 指令平均幾次

void printSettings() {
  uint32_t fs = fullScale();
  Serial.printf("# gain=%s atime=%u astep=%u  滿刻度=%lu  積分=%.1fms\n",
                gainName(), ATIME_VAL, ASTEP_VAL, (unsigned long)fs, integrationMs());
  // 刻度太小的話後面所有讀值都會塌掉,而且不會有其他徵兆,所以直接喊出來
  if (fs < 10000)
    Serial.printf("# ** 警告:滿刻度只有 %lu,積分 %.1fms 太短,讀值會埋在量化誤差裡。\n"
                  "#    正常設定是 t59 s999(滿刻度 60000、積分 167ms)。**\n",
                  (unsigned long)fs, integrationMs());
}

void printHelp() {
  Serial.println("# 指令:? 設定  i I2C 掃描  l 開關 LED  d 暗/亮對照");
  Serial.println("#       g<0-10> gain   t<0-255> atime   s<1-65535> astep");
  Serial.println("# 量測與即時光譜由網頁發動,這裡沒有對應指令。");
}

// 形狀鎖死:單獨的小寫字母,或小寫字母 + 純數字。其餘一律當成打錯。
// 舊版只看第一個字母,結果 "test1" 裡的 t 被當成 ATIME 指令、"est1".toInt() 得到 0,
// 積分時間從 167ms 掉到 2.8ms,整批讀值塌掉而且沒有任何錯誤訊息。
bool parseCommand(const String &s, char &c, long &v, bool &hasArg) {
  if (s.length() == 0) return false;
  c = s.charAt(0);
  String rest = s.substring(1);
  hasArg = false;

  if (c == '?') return rest.length() == 0;
  if (!(c >= 'a' && c <= 'z')) return false;

  switch (c) {
    case 'i': case 'l': case 'd':
      return rest.length() == 0;                 // 不帶參數的指令,多一個字就不是指令
    case 'g': case 't': case 's': {
      if (rest.length() == 0) return false;      // 裸的 g/t/s 不算指令,免得誤設成 0
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

  Serial.println("# 通道   暗態      亮態      差值");
  for (uint8_t i = 0; i < 10; i++) {
    double d = sd[i] / DIAG_AVG, l = sl[i] / DIAG_AVG;
    Serial.printf("#  %-4s %8.1f  %8.1f  %8.1f\n", CH_NAME[i], d, l, l - d);
  }
  Serial.println("#   兩欄都接近 0   -> LED 沒亮(或光路被擋住)");
  Serial.println("#   兩欄都大且相近 -> LED 恆亮,沒有被 GPIO 控制到");
  Serial.println("#   暗態小、亮態大 -> 正常");
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
      // 串流或量測中手動切 LED 會污染讀值
      if (state != STATE_IDLE) { Serial.printf("# 狀態 %s,不能手動切 LED\n", stateName()); return; }
      static bool on = false;
      on = !on;
      digitalWrite(LED_PIN, on ? HIGH : LOW);
      Serial.printf("# LED(GPIO%d) -> %s\n", LED_PIN, on ? "ON" : "OFF");
      return;
    }
    case 'd':
      if (!sensorOk) { Serial.println("# 感測器沒回應"); return; }
      if (state != STATE_IDLE) { Serial.printf("# 狀態 %s,稍後再診斷\n", stateName()); return; }
      setState(STATE_MEASURING);      // 佔住裝置,免得網頁同時發 read 進來搶 LED
      showMessage("Diagnostics...", "dark / light");
      diagnoseDarkLight();
      setState(STATE_IDLE);
      return;
    case 'g': if (v <= 10)  AGAIN_CODE = v; else { Serial.println("# gain 只能 0~10"); return; } break;
    case 't': if (v <= 255) ATIME_VAL  = v; else { Serial.println("# atime 只能 0~255"); return; } break;
    case 's': if (v >= 1 && v <= 65535) ASTEP_VAL = v; else { Serial.println("# astep 只能 1~65535"); return; } break;
    case '?': break;
    default:  return;
  }

  applySettings();
  printSettings();
  sendStatus();             // 設定算進 fingerprint,網頁要馬上知道
}

// =========================================================
// 12. setup / loop
// =========================================================
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);            // 開機安全:最早就關掉激發光

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
    Serial.printf("# OLED @0x%02X 沒有回應,改看 Serial(量測不受影響)\n", OLED_ADDR);
  }

  // 感測器偵測用 I2C ACK,不看讀值(見上方說明 5)
  int rc = -99;
  for (uint8_t i = 0; i < 3 && !sensorOk; i++) {
    sensorOk = i2cPresent(AS7341_ADDR);
    if (sensorOk) { rc = as7341.begin(); applySettings(); }
    else delay(300);
  }
  Serial.printf("# AS7341 @0x%02X  %s   begin() rc=%d\n",
                AS7341_ADDR, sensorOk ? "OK" : "沒有回應", rc);
  if (!sensorOk) { showMessage("AS7341 not found", "check I2C wiring"); delay(2000); }

  // Wi-Fi 連不上時裝置不會做任何事,但也不該卡在 setup() 裡:
  // 只等一下,之後交給 loop() 裡的 serviceWifi() 一直追。
  showMessage("Connecting Wi-Fi...", WIFI_SSID);
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // 省電模式會讓串流延遲、更新率掉下來
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

  // 回呼只登記,這裡才真的量;Serial 排在後面,不會和它搶
  if (readPending) { readPending = false; measureForWeb(readRequestId); }

  handleSerial();

  syncLive();
  if (state == STATE_LIVE) streamLiveFrame();

  if (backendConnected && millis() - lastStatusMs >= STATUS_INTERVAL_MS) sendStatus();

  logWhileWaitingForBackend();
  refreshIdleScreen();
  delay(1);
}
