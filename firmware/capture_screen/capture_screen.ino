// =========================================================
// CAPTURE-Screen 韌體 v5.2 —— 台面批次量測 + 連線到 LasReader 後端
//
// 兩條工作流隨時都能用,不用切模式:
//   A. 台面(不需網路):放樣品 -> Serial 輸入編號 -> 按按鈕 -> 自動跑 N_RUN 筆
//      -> OLED 顯示 DONE 與統計 -> 換下一管。CSV 從 Serial 出。
//   B. 網頁:裝置開機連上 Wi-Fi 後,主動連出去到後端的 WebSocket
//        wss://<BACKEND_HOST>/api/hardware/device
//      並一直保持連線(斷線自動重連)。後端在 Render 上,連不進實驗室或家裡的路由器,
//      所以一定是裝置往外連。網頁的即時光譜、量測、校正全部經過這一條連線。
//      Wi-Fi 或後端連不上時,A 照常可用。
//
// 硬體:ESP32-WROOM-32 / AS7341 (I2C 0x39) / SSD1306 OLED (0x3C)
//       藍光激發 LED 於 LED_PIN;按鈕 GPIO13 (INPUT_PULLUP)
//
// ---- 和後端的協定(欄位名稱是合約:backend/app/hardware/models.py、
//      backend/app/live/models.py、frontend/js/hardware_processing.js 三邊要一起改)----
// 裝置 -> 後端
//   {"mode":"status", ...}       連上時、狀態改變時、之後每 5 秒(批次量測中也照送)
//   {"mode":"live", ...}         有人開著即時光譜時一張接一張
//   {"mode":"measurement", ...}  收到 read 後量一次 dark_1 -> light -> dark_2(原始 counts)
//   {"mode":"error", ...}        指令無法執行:busy / sensor_offline
// 後端 -> 裝置
//   {"cmd":"live_start"} / {"cmd":"live_stop"}   有沒有人在看即時光譜
//   {"cmd":"read","request_id":"..."}             量一次
// 裝置只「讀」不算:扣暗態、正規化、解混都在網頁端做。
// 台面批次的結果(CSV、k5 校正)只在裝置上,不送到後端。
//
// 狀態機:IDLE / LIVE / MEASURING。LED 只在有人看即時光譜或量測中才亮:
// 一直亮會讓比色皿裡的樣品發熱、光漂白。量測(網頁或台面)會暫停串流,
// 量完若還有人在看會自動恢復。和後端斷線時 LED 一律關掉。
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
// 3. 量測期間會呼叫 pump():餵 WebSocket 並照常送 status。一批 5 筆 × 8 次平均要十幾秒,
//    不餵的話 pong 會逾時斷線,不送 status 的話後端 15 秒後就把裝置當離線。
//    WebSocket 回呼只「登記」指令(量測中收到 read 直接回 busy),
//    實際量測永遠在 loop() 裡做,所以不會有並行,也不需要鎖。
//
// 4. 感測器是否存在用 I2C ACK 判斷,不看讀值。
//    盒子蓋上且 LED 關閉時所有通道本來就讀 0,那是正常暗態不是失聯。
//
// 5. 每批的第 1 筆不列入統計(換管時 LED 冷掉,回插後第一筆實測高約 6%),
//    但仍然寫進 CSV,事後要用還在。
//
// 6. FIRMWARE_VERSION、gain、ATIME、ASTEP、LED 電流都算進網頁的 config fingerprint。
//    改了任何一個,網頁上用舊設定做的校正曲線就會變成 stale —— 讀值路徑變了本來就該如此。
//
// Wi-Fi 帳密放在 secrets.h(不進 git):把 secrets.h.example 複製成 secrets.h 再填。
// 要連本機後端,也在 secrets.h 裡覆寫 BACKEND_HOST / BACKEND_PORT / BACKEND_USE_TLS。
// 這條連線目前沒有驗證:知道網址的人都能假冒裝置。
//
// 需要的函式庫:DFRobot_AS7341、Adafruit SSD1306、Adafruit GFX、ArduinoJson 7、
// WebSockets(Markus Sattler / Links2004,程式庫管理員搜 "WebSockets")。
// Serial Monitor(115200)會印 [wifi] / [backend] 連線狀態,連不上先看這裡。
// =========================================================

// ---- include 順序:網路先、感測器後(見上方說明 1)----
#include <WiFi.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <Preferences.h>

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
#define FIRMWARE_VERSION "5.2.0"
#define LED_CURRENT_MA   5.553f     // 三用電表實測,韌體讀不到

// ---- 腳位 ----
// iGEM 參考設計是 GPIO2 經 2N7000 低側開關。這台實機目前接在 25:
// GPIO2 是 strapping pin 而且多數 DevKit 上接了板載 LED,開機行為不乾淨。
// 換回 2 的話把下面改掉即可,其餘程式不受影響。
const int LED_PIN    = 25;
const int BUTTON_PIN = 13;
const int I2C_SDA    = 21;
const int I2C_SCL    = 22;

const uint8_t AS7341_ADDR = 0x39;
const uint8_t OLED_ADDR   = 0x3C;

// ---- 感測器參數 ----
// 滿刻度 =(ATIME+1)×(ASTEP+1),上限 65535;積分時間 = 該值 × 2.78µs。
// 下面這組:滿刻度 60000、積分約 167ms。實測本機空艙 F3≈964(佔 1.6%),
// 加上比色皿與菌液約 5~8%,離飽和很遠。
uint8_t  AGAIN_CODE = 10;    // 暫存器索引 0..10 -> 0.5× 1× 2× 4× 8× 16× 32× 64× 128× 256× 512×
uint8_t  ATIME_VAL  = 59;
uint16_t ASTEP_VAL  = 999;

const uint8_t N_AVG  = 8;    // 台面每筆量測平均幾次
const uint8_t N_RUN  = 5;    // 按一次按鈕跑幾筆
const uint8_t N_SKIP = 1;    // 每批前幾筆不列入統計

// ---- 時間 ----
const unsigned long DARK_SETTLE_MS      = 50;     // 關 LED 後等多久
const unsigned long LIGHT_SETTLE_MS     = 100;    // 開 LED 後等它穩定
const unsigned long LIVE_INTERVAL_MS    = 300;    // 串流張與張之間留給 ws.loop() 與按鈕
const unsigned long STATUS_INTERVAL_MS  = 5000;   // 後端 15 秒沒消息就當離線
const unsigned long WIFI_BOOT_WAIT_MS   = 10000;  // 開機最多等 Wi-Fi 這麼久,之後在 loop() 裡繼續追
const unsigned long RECONNECT_MS        = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;  // 抓出沒通知就斷掉的連線
const unsigned long WS_PONG_TIMEOUT_MS  = 10000;  // 量測中有 pump(),最長空檔約一次讀取
const uint8_t       WS_MISSED_PONGS     = 2;
const unsigned long WAITING_LOG_MS      = 10000;  // 連不上後端時多久印一次 Serial
const unsigned long DEBOUNCE_MS         = 50;

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
DFRobot_AS7341 as7341;
WebSocketsClient ws;
Preferences prefs;

const char* CH_NAME[10] = {"F1","F2","F3","F4","F5","F6","F7","F8","CLR","NIR"};

// ---- 型別:一定要放在「第一個函式定義」之前 ----
// Arduino 會自動產生所有函式的原型,並插在檔案裡第一個函式定義的前面。
// 如果 struct / enum 定義在那個位置之後,插進去的原型(例如 void readOnce(Frame&))
// 就會看不到型別,編譯時報一整串 "'Frame' was not declared in this scope"。
struct Frame { float ch[10]; };          // F1..F8, CLR, NIR
enum DeviceState { STATE_IDLE, STATE_LIVE, STATE_MEASURING };

// gain 倍率由索引算出,不可能和實際寫入的值走鐘
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
void applySettings() {
  as7341.setAtime(ATIME_VAL);
  as7341.setAstep(ASTEP_VAL);
  as7341.setAGAIN(AGAIN_CODE);
}

// 藍光洩漏校正:訊號 = F5 − k5 × F3,用 F3 當內部標準吸收濁度與強度漂移。
// 實測:絕對強度 CV 4.1% 的情況下,比值的 CV 只有 0.8%。
float LEAK_K5 = 0.05358f;
float LEAK_K4 = 0.19760f;

// =========================================================
// 2. 狀態
// =========================================================
DeviceState state = STATE_IDLE;

bool sensorOk = false;
bool wifiOk = false;
bool wsStarted = false;          // WebSocket 只啟動一次,但要等 Wi-Fi 真的連上
bool backendConnected = false;
bool liveWanted = false;         // 後端說有人開著即時光譜
bool readPending = false;        // 收到 read 還沒量
char readRequestId[40] = "";

char LABEL[24] = "-";
uint32_t seqNo = 0, liveSeq = 0, batchNo = 0;
uint8_t  repIdx = 0;
double   accF3 = 0, accF3sq = 0, accSig = 0, accSigSq = 0;
uint8_t  accN = 0;

unsigned long liveStartedMs = 0, lastLiveFrameMs = 0, lastStatusMs = 0;

const char* stateName() {
  switch (state) {
    case STATE_LIVE:      return "LIVE";
    case STATE_MEASURING: return "MEASURING";
    default:              return "IDLE";
  }
}

// 前向宣告
void sendStatus();
void showIdleScreen();

// =========================================================
// 3. I2C
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
// 4. 讀取
// =========================================================

// 量測中讓連線活著(見上方說明 3)。只從 loop() 這一側呼叫,不會從回呼裡呼叫。
void pump() {
  if (wsStarted) ws.loop();
  if (backendConnected && millis() - lastStatusMs >= STATUS_INTERVAL_MS) sendStatus();
  yield();
}

void readOnce(Frame &f) {
  as7341.startMeasure(as7341.eF1F4ClearNIR);
  DFRobot_AS7341::sModeOneData_t d1 = as7341.readSpectralDataOne();
  f.ch[0] = d1.ADF1; f.ch[1] = d1.ADF2; f.ch[2] = d1.ADF3; f.ch[3] = d1.ADF4;
  f.ch[8] = d1.ADCLEAR; f.ch[9] = d1.ADNIR;

  as7341.startMeasure(as7341.eF5F8ClearNIR);
  DFRobot_AS7341::sModeTwoData_t d2 = as7341.readSpectralDataTwo();
  f.ch[4] = d2.ADF5; f.ch[5] = d2.ADF6; f.ch[6] = d2.ADF7; f.ch[7] = d2.ADF8;
}

// 平均 n 次,回填平均與標準差;回傳是否有通道飽和。
// n=1 給網頁量測與即時串流(送原始 counts),n=N_AVG 給台面量測(要穩)。
bool readAvg(Frame &mean, Frame &sd, uint8_t n) {
  double s[10] = {0}, ss[10] = {0};
  bool sat = false;
  uint32_t fs = fullScale();
  for (uint8_t i = 0; i < n; i++) {
    Frame v;
    readOnce(v);
    for (uint8_t c = 0; c < 10; c++) {
      if (v.ch[c] >= fs) sat = true;
      s[c]  += v.ch[c];
      ss[c] += (double)v.ch[c] * v.ch[c];
    }
    pump();                       // 每次讀取之間餵一下連線
  }
  for (uint8_t c = 0; c < 10; c++) {
    mean.ch[c] = s[c] / n;
    double var = ss[c] / n - (double)mean.ch[c] * mean.ch[c];
    sd.ch[c] = var > 0 ? sqrt(var) : 0.0f;
  }
  return sat;
}

// 一筆完整量測:LED 關(暗態)-> LED 開(亮態)-> 相減。
// 一次就扣掉環境光、暗電流與溫度漂移。
bool measureNet(Frame &net, Frame &netSd) {
  Frame dark, darkSd, lit, litSd;

  digitalWrite(LED_PIN, LOW);
  delay(DARK_SETTLE_MS);
  bool satD = readAvg(dark, darkSd, N_AVG);

  digitalWrite(LED_PIN, HIGH);
  delay(LIGHT_SETTLE_MS);
  bool satL = readAvg(lit, litSd, N_AVG);

  digitalWrite(LED_PIN, LOW);            // 量完就關,減少 LED 發熱造成的漂移

  for (uint8_t c = 0; c < 10; c++) {
    net.ch[c]   = lit.ch[c] - dark.ch[c];
    netSd.ch[c] = sqrt(litSd.ch[c] * litSd.ch[c] + darkSd.ch[c] * darkSd.ch[c]);
  }
  return satD || satL;
}

// =========================================================
// 5. OLED
// =========================================================
void showMessage(const char* l1, const char* l2) {
  display.clearDisplay();
  display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(l1);
  if (l2) display.println(l2);
  display.display();
}

// 待機畫面:連線狀態在這裡,網頁上看不到裝置時先看這裡
void showIdleScreen() {
  display.clearDisplay();
  display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("CAPTURE-Screen v5");
  display.print("WiFi ");
  display.println(wifiOk ? WiFi.localIP().toString() : String("connecting"));
  display.print("Web  ");
  display.println(backendConnected ? "online" : "connecting");
  display.print(gainName()); display.print("  k5 "); display.println(LEAK_K5, 4);
  display.println(sensorOk ? "" : "AS7341 NOT FOUND");
  display.print("ID "); display.println(LABEL);
  display.print("Type ID, press button");
  display.display();
}

// 只在連線狀態改變時重畫,免得 DONE 或校正結果馬上被蓋掉
void refreshIdleScreen() {
  static bool shownWifi = false, shownBackend = false;
  if (state != STATE_IDLE) return;
  if (wifiOk == shownWifi && backendConnected == shownBackend) return;
  shownWifi = wifiOk; shownBackend = backendConnected;
  showIdleScreen();
}

void showRunning(uint8_t done, float f3 = -1, float sig = 0, bool sat = false) {
  display.clearDisplay();
  display.setTextSize(2); display.setCursor(0, 0); display.print(LABEL);
  display.setTextSize(1);
  display.setCursor(86, 7); display.print(done); display.print("/"); display.print(N_RUN);
  display.drawRect(0, 22, 128, 9, SSD1306_WHITE);
  if (done) display.fillRect(2, 24, (124 * done) / N_RUN, 5, SSD1306_WHITE);
  display.setCursor(0, 36);
  if (sat) {
    display.println("** SATURATED **");
  } else if (f3 >= 0) {
    display.print("F3  "); display.println(f3, 0);
    display.print("SIG "); display.println(sig, 2);
  } else {
    display.println("measuring...");
  }
  display.setCursor(0, 56); display.print("do not touch");
  display.display();
}

// 十個通道兩欄排(即時串流與網頁量測後顯示)
void showFrame(const Frame &f) {
  display.clearDisplay();
  display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
  const uint8_t yy[5] = {0, 13, 26, 39, 52};
  for (uint8_t r = 0; r < 5; r++) {
    display.setCursor(0, yy[r]);
    display.print(CH_NAME[r]); display.print(":"); display.print((int)f.ch[r]);
    display.setCursor(66, yy[r]);
    display.print(CH_NAME[r + 5]); display.print(":"); display.print((int)f.ch[r + 5]);
  }
  display.display();
}

// =========================================================
// 6. 對後端的訊息
// =========================================================
void addIdentity(JsonDocument &doc) {
  doc["device_id"] = DEVICE_ID;
  doc["build_id"] = BUILD_ID;
  doc["firmware_version"] = FIRMWARE_VERSION;
}

void addConfig(JsonObject c) {
  // 固定 3 位小數:float 直接序列化會變成 5.5529999…,網頁端的 fingerprint 會對不上
  c["led_current_mA"] = serialized(String(LED_CURRENT_MA, 3));
  if (AGAIN_CODE == 0) c["gain"] = serialized(String("0.5"));   // 只有 0.5x 不是整數
  else                 c["gain"] = (uint16_t)gainMultiplier();
  c["atime"] = ATIME_VAL;
  c["astep"] = ASTEP_VAL;
}

// 合約要求原始 ADC counts 是非負整數
void addFrame(JsonObject o, const Frame &f) {
  for (uint8_t c = 0; c < 10; c++) o[CH_NAME[c]] = (uint32_t)lroundf(f.ch[c] > 0 ? f.ch[c] : 0);
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
  if (state == STATE_IDLE) showIdleScreen();
}

// =========================================================
// 7. 樣品編號與空白校正(台面)
// =========================================================
void setLabel(const char* t) {
  String s(t); s.trim();
  if (s.length() == 0) s = "-";
  s.toCharArray(LABEL, sizeof(LABEL));
  Serial.printf("# 樣品編號 -> %s   (按按鈕開始,自動跑 %u 筆)\n", LABEL, N_RUN);

  if (state != STATE_IDLE) return;       // 串流或量測中不搶畫面
  display.clearDisplay();
  display.setTextSize(2); display.setCursor(0, 0); display.println(LABEL);
  display.setTextSize(1);
  display.setCursor(0, 26); display.println("Ready.");
  display.print("Press button -> "); display.print(N_RUN); display.println(" runs");
  display.display();
}

// 放進「不會發光」的樣品(野生株或只有培養基)後校正。
// 重要:要在暖機之後做 —— LED 冷機時光輸出高約 6%,冷機校正出來的 k 會偏 1%。
void calibrateBlank() {
  if (!sensorOk) {
    Serial.println("# 感測器沒回應,無法校正");
    return;
  }
  if (state == STATE_MEASURING) {
    Serial.println("# 量測中,先等這批跑完(或按 m 中止)再校正");
    return;
  }
  digitalWrite(LED_PIN, LOW);
  setState(STATE_MEASURING);
  showMessage("CALIBRATING...", "blank in place?");

  Frame net, sd;
  bool sat = measureNet(net, sd);

  if (sat || net.ch[2] < 50) {
    if (sat) {
      Serial.printf("# 校正失敗:有通道飽和(滿刻度 %lu)。\n"
                    "#   高 gain 下環境光會讓暗態與亮態雙雙頂到天花板,相減反而趨近 0。\n"
                    "#   先確認蓋子密合,再不行就降 gain(現在 %s)。\n",
                    (unsigned long)fullScale(), gainName());
    } else {
      Serial.printf("# 校正失敗:F3 只有 %.1f —— LED 沒亮、或光路被擋住\n", net.ch[2]);
    }
    showMessage("CALIBRATION FAILED", sat ? "saturated" : "no light");
    delay(1200);
    setState(STATE_IDLE);
    return;
  }

  LEAK_K5 = net.ch[4] / net.ch[2];
  LEAK_K4 = net.ch[3] / net.ch[2];
  prefs.putFloat("k5", LEAK_K5);
  prefs.putFloat("k4", LEAK_K4);

  Serial.printf("# F3 = %.1f,佔滿刻度 %.1f%%\n", net.ch[2], 100.0 * net.ch[2] / fullScale());
  Serial.printf("# 校正完成 [%s]  k5=%.5f  k4=%.5f  (F3=%.1f F4=%.1f F5=%.1f)\n",
                LABEL, LEAK_K5, LEAK_K4, net.ch[2], net.ch[3], net.ch[4]);

  display.clearDisplay();
  display.setTextSize(2); display.setCursor(0, 0); display.println("CAL OK");
  display.setTextSize(1);
  display.print("k5  "); display.println(LEAK_K5, 5);
  display.print("F3  "); display.println(net.ch[2], 0);
  display.print("on  "); display.println(LABEL);
  display.display();

  delay(1200);
  setState(STATE_IDLE);
}

// =========================================================
// 8. 批次量測(台面工作流)
// =========================================================
void emitReading(const Frame &net, const Frame &netSd, float sig5, float sigSd,
                 float snr, bool sat) {
  Serial.printf("%lu,%s,%lu,%u,%lu,%s,%u,%u,%d", (unsigned long)seqNo, LABEL,
                (unsigned long)batchNo, repIdx, (unsigned long)millis(),
                gainName(), ATIME_VAL, ASTEP_VAL, sat ? 1 : 0);
  for (uint8_t c = 0; c < 10; c++) Serial.printf(",%.1f", net.ch[c]);
  for (uint8_t c = 0; c < 10; c++) Serial.printf(",%.2f", netSd.ch[c]);
  Serial.printf(",%.5f,%.2f,%.2f,%.2f\n", LEAK_K5, sig5, sigSd, snr);
}

void startBatch() {
  if (!sensorOk) {
    Serial.println("# 感測器沒回應,無法量測");
    return;
  }
  batchNo++;
  repIdx = 0; accN = 0;
  accF3 = accF3sq = accSig = accSigSq = 0;
  digitalWrite(LED_PIN, LOW);
  setState(STATE_MEASURING);
  Serial.printf("# ---- 開始 [%s]  batch %lu ----\n", LABEL, (unsigned long)batchNo);
  if (strcmp(LABEL, "-") == 0)
    Serial.println("# 注意:還沒輸入樣品編號,這批會標成 \"-\"");
  showRunning(0);
}

void finishBatch(bool aborted) {
  digitalWrite(LED_PIN, LOW);

  float mF3 = 0, sdF3 = 0, mSig = 0, sdSig = 0, cv = 0;
  if (accN >= 2) {
    mF3 = accF3 / accN;
    double v1 = accF3sq / accN - (double)mF3 * mF3;
    sdF3 = v1 > 0 ? sqrt(v1) : 0;
    mSig = accSig / accN;
    double v2 = accSigSq / accN - (double)mSig * mSig;
    sdSig = v2 > 0 ? sqrt(v2) : 0;
    cv = mF3 > 0 ? 100.0 * sdF3 / mF3 : 0;
  }

  Serial.printf("# ==== %s [%s] batch %lu  統計用第 %u~%u 筆 ====\n",
                aborted ? "中止" : "完成", LABEL, (unsigned long)batchNo,
                N_SKIP + 1, repIdx);
  if (accN >= 2) {
    Serial.printf("#   F3   = %.1f +- %.1f  (CV %.2f%%)\n", mF3, sdF3, cv);
    Serial.printf("#   SIG5 = %.2f +- %.2f\n", mSig, sdSig);
    if (cv > 1.0)
      Serial.println("#   ** F3 的 CV 超過 1%,比色皿可能沒放穩,建議重跑這一管 **");
  } else {
    Serial.println("#   有效筆數不足,無法統計");
  }
  Serial.println("# 下一管:放好樣品 -> 輸入編號 -> 按按鈕");

  display.clearDisplay();
  display.setTextSize(2); display.setCursor(0, 0);
  display.println(aborted ? "STOP" : "DONE");
  display.setTextSize(1);
  display.setCursor(0, 18);
  display.print(LABEL); display.print("   n="); display.println(accN);
  if (accN >= 2) {
    display.print("F3  "); display.print(mF3, 0); display.print(" +-"); display.println(sdF3, 1);
    display.print("SIG "); display.print(mSig, 2); display.print(" +-"); display.println(sdSig, 2);
    if (cv > 1.0) display.println("** unstable, redo **");
  }
  display.setCursor(0, 56); display.print("Next: ID + button");
  display.display();

  state = STATE_IDLE;       // 不用 setState:畫面要留著給人看
  sendStatus();
}

void stepBatch() {
  Frame net, netSd;
  bool sat = measureNet(net, netSd);
  if (state != STATE_MEASURING) return;   // 讀取期間被中止(Serial 或按鈕不會,但保險)

  float sig5  = net.ch[4] - LEAK_K5 * net.ch[2];
  float sigSd = sqrt(netSd.ch[4] * netSd.ch[4] +
                     LEAK_K5 * LEAK_K5 * netSd.ch[2] * netSd.ch[2]);
  float snr   = sigSd > 0.01f ? sig5 / sigSd : 0.0f;

  seqNo++; repIdx++;
  emitReading(net, netSd, sig5, sigSd, snr, sat);

  if (repIdx > N_SKIP) {
    accF3  += net.ch[2]; accF3sq  += (double)net.ch[2] * net.ch[2];
    accSig += sig5;      accSigSq += (double)sig5 * sig5;
    accN++;
  }
  showRunning(repIdx, net.ch[2], sig5, sat);

  if (repIdx >= N_RUN) finishBatch(false);
}

// =========================================================
// 9. 網頁量測:dark_1 -> light -> dark_2,原始 counts 送回後端
// =========================================================
void measureForWeb(const char *requestId) {
  digitalWrite(LED_PIN, LOW);
  setState(STATE_MEASURING);
  showMessage("Measuring...", "requested online");

  Frame dark1, light, dark2, sd;
  unsigned long t0 = millis();

  delay(DARK_SETTLE_MS);
  readAvg(dark1, sd, 1);

  digitalWrite(LED_PIN, HIGH);
  delay(LIGHT_SETTLE_MS);
  readAvg(light, sd, 1);

  digitalWrite(LED_PIN, LOW);
  delay(DARK_SETTLE_MS);
  readAvg(dark2, sd, 1);

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

  // 用 # 開頭,Serial 的 CSV 照樣能直接讀
  Serial.printf("# 網頁量測 %lums  light F3=%.0f F4=%.0f  dark F4=%.0f/%.0f\n",
                (unsigned long)(millis() - t0), light.ch[2], light.ch[3], dark1.ch[3], dark2.ch[3]);

  setState(STATE_IDLE);     // 還有人在看的話,下一次 syncLive() 會恢復串流
  showFrame(light);
}

// =========================================================
// 10. 即時串流
// =========================================================
// 串不串流只看兩件事:有沒有人在看、有沒有在量測
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

  Frame f, sd;
  readAvg(f, sd, 1);                     // 串流只讀一次,要快
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
// 11. 後端指令(在 ws.loop() 裡被呼叫:只登記,不量測)
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
// 12. Serial 指令
// =========================================================
// 編號直接打(A3、B2、A5end…)。指令一律小寫:
//   g<0-10> gain   t<0-255> ATIME   s<1-65535> ASTEP
//   k 空白校正   m 開始/中止一批   l 開關 LED   d 暗態/亮態診斷
//   b 按鈕電位   i I2C 掃描   ? 目前設定
// 判斷一行輸入是不是指令。形狀鎖得很死,其餘一律當成樣品編號:
//   單獨的小寫字母      k m l d b i ?      -> 指令
//   小寫字母 + 純數字   g10  t59  s999     -> 指令
//   n 開頭              nA3                -> 樣品編號(舊寫法)
//   其他任何東西        A3  B2  test1  t   -> 樣品編號
//
// 這一條規則是被實機咬過才寫的:舊版只看第一個字母,所以編號打成 "test1" 時
// t 被當成 ATIME 指令、"est1".toInt() 得到 0,ATIME 就被設成 0,
// 積分時間從 167ms 掉到 2.8ms,讀值整批塌掉而且完全沒有錯誤訊息。
bool parseCommand(const String &s, char &c, long &v, bool &hasArg) {
  if (s.length() == 0) return false;
  c = s.charAt(0);
  String rest = s.substring(1);
  hasArg = false;

  if (c == '?') return rest.length() == 0;
  if (!(c >= 'a' && c <= 'z')) return false;

  switch (c) {
    case 'k': case 'm': case 'l': case 'd': case 'b': case 'i':
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

void printSettings() {
  uint32_t fs = fullScale();
  float integ = (ATIME_VAL + 1.0) * (ASTEP_VAL + 1.0) * 2.78e-3;
  Serial.printf("# gain=%s atime=%u astep=%u  滿刻度=%lu  積分=%.1fms  k5=%.5f\n",
                gainName(), ATIME_VAL, ASTEP_VAL, (unsigned long)fs, integ, LEAK_K5);
  // 刻度太小的話後面所有讀值都會塌掉,而且不會有其他徵兆,所以直接喊出來
  if (fs < 10000)
    Serial.printf("# ** 警告:滿刻度只有 %lu,積分 %.1fms 太短,讀值會埋在量化誤差裡。\n"
                  "#    正常設定是 t59 s999(滿刻度 60000、積分 167ms)。**\n",
                  (unsigned long)fs, integ);
}

void handleSerial() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.length() == 0) return;

  // n<標籤> 的舊寫法
  if (cmd.charAt(0) == 'n' && cmd.length() > 1) { setLabel(cmd.substring(1).c_str()); return; }

  char c; long v = 0; bool hasArg = false;
  if (!parseCommand(cmd, c, v, hasArg)) { setLabel(cmd.c_str()); return; }

  switch (c) {
    case 'm': if (state == STATE_MEASURING) finishBatch(true); else startBatch(); return;
    case 'k': calibrateBlank(); return;
    case 'i': i2cScan(); return;
    case 'b':
      Serial.printf("# BUTTON_PIN(%d) 現在 %s  (放開應為 HIGH)\n",
                    BUTTON_PIN, digitalRead(BUTTON_PIN) ? "HIGH" : "LOW");
      return;
    case 'l': {
      // 串流或量測中手動切 LED 會污染讀值
      if (state != STATE_IDLE) { Serial.printf("# 狀態 %s,不能手動切 LED\n", stateName()); return; }
      static bool on = false;
      on = !on;
      digitalWrite(LED_PIN, on ? HIGH : LOW);
      Serial.printf("# LED(GPIO%d) -> %s\n", LED_PIN, on ? "ON" : "OFF");
      return;
    }
    case 'd': {
      if (!sensorOk) { Serial.println("# 感測器沒回應"); return; }
      if (state != STATE_IDLE) { Serial.printf("# 狀態 %s,稍後再診斷\n", stateName()); return; }
      Frame dk, dks, lt, lts;
      digitalWrite(LED_PIN, LOW);  delay(DARK_SETTLE_MS);  readAvg(dk, dks, N_AVG);
      digitalWrite(LED_PIN, HIGH); delay(LIGHT_SETTLE_MS); readAvg(lt, lts, N_AVG);
      digitalWrite(LED_PIN, LOW);
      Serial.println("# 通道   暗態      亮態      差值");
      for (uint8_t i = 0; i < 10; i++)
        Serial.printf("#  %-4s %8.1f  %8.1f  %8.1f\n", CH_NAME[i], dk.ch[i], lt.ch[i], lt.ch[i] - dk.ch[i]);
      Serial.println("#   兩欄都接近 0   -> LED 沒亮(或光路被擋住)");
      Serial.println("#   兩欄都大且相近 -> LED 恆亮,沒有被 GPIO 控制到");
      Serial.println("#   暗態小、亮態大 -> 正常");
      return;
    }
    case 'g': if (v <= 10)    AGAIN_CODE = v; else { Serial.println("# gain 只能 0~10"); return; } break;
    case 't': if (v <= 255)   ATIME_VAL  = v; else { Serial.println("# atime 只能 0~255"); return; } break;
    case 's': if (v >= 1 && v <= 65535) ASTEP_VAL = v; else { Serial.println("# astep 只能 1~65535"); return; } break;
    case '?': break;
    default:  return;
  }

  applySettings();
  printSettings();
  sendStatus();             // 設定算進 fingerprint,網頁要馬上知道
}

// =========================================================
// 13. 按鈕
// =========================================================
void handleButton() {
  static bool lastRaw = false, stablePressed = false;
  static unsigned long lastChange = 0;

  bool raw = digitalRead(BUTTON_PIN) == LOW;
  if (raw != lastRaw) { lastRaw = raw; lastChange = millis(); }
  if (millis() - lastChange >= DEBOUNCE_MS && raw != stablePressed) {
    stablePressed = raw;
    if (stablePressed) {
      if (state == STATE_MEASURING) finishBatch(true);
      else startBatch();
    }
  }
}

// =========================================================
// 14. setup / loop
// =========================================================
void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);            // 開機安全:最早就關掉激發光
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  Serial.begin(115200);
  prefs.begin("capture", false);
  LEAK_K5 = prefs.getFloat("k5", LEAK_K5);
  LEAK_K4 = prefs.getFloat("k4", LEAK_K4);

  Wire.begin(I2C_SDA, I2C_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  display.setTextColor(SSD1306_WHITE);
  showMessage("CAPTURE-Screen v5", "starting...");

  // 感測器偵測用 I2C ACK,不看讀值(見上方說明 4)
  i2cScan();
  int rc = -99;
  for (uint8_t i = 0; i < 3 && !sensorOk; i++) {
    sensorOk = i2cPresent(AS7341_ADDR);
    if (sensorOk) { rc = as7341.begin(); applySettings(); }
    else delay(300);
  }
  Serial.printf("# AS7341 @0x%02X  %s   begin() rc=%d\n",
                AS7341_ADDR, sensorOk ? "OK" : "沒有回應", rc);
  if (!sensorOk) { showMessage("AS7341 not found", "check I2C wiring"); delay(2000); }

  // Wi-Fi 連不上也要能用台面工作流,所以只等一下,之後交給 loop() 裡的 serviceWifi()
  showMessage("Connecting Wi-Fi...", WIFI_SSID);
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                  // 省電模式會讓串流延遲、更新率掉下來
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_BOOT_WAIT_MS) delay(200);
  if (WiFi.status() != WL_CONNECTED)
    Serial.println("[wifi] not connected yet, continuing offline; the backend link starts once it connects");

  // CSV 表頭
  Serial.printf("# CAPTURE-Screen v%s (%s)  LED %.3f mA   k5=%.5f k4=%.5f   每批 %u 筆(略過前 %u 筆)\n",
                FIRMWARE_VERSION, BUILD_ID, LED_CURRENT_MA, LEAK_K5, LEAK_K4, N_RUN, N_SKIP);
  Serial.print("seq,label,batch,rep,ms,gain,atime,astep,sat");
  for (uint8_t c = 0; c < 10; c++) { Serial.print(","); Serial.print(CH_NAME[c]); }
  for (uint8_t c = 0; c < 10; c++) { Serial.print(","); Serial.print(CH_NAME[c]); Serial.print("_sd"); }
  Serial.println(",k5,SIG5,SIG5_sd,SNR");

  printSettings();
  serviceWifi();
  showIdleScreen();
}

void loop() {
  serviceWifi();
  if (wsStarted) ws.loop();

  // 網頁量測先做:回呼只登記,這裡才真的量;按鈕與 Serial 排在後面,不會和它搶
  if (readPending) { readPending = false; measureForWeb(readRequestId); }

  handleSerial();
  handleButton();

  if (state == STATE_MEASURING) { stepBatch(); return; }

  syncLive();
  if (state == STATE_LIVE) streamLiveFrame();

  if (backendConnected && millis() - lastStatusMs >= STATUS_INTERVAL_MS) sendStatus();

  logWhileWaitingForBackend();
  refreshIdleScreen();
  delay(1);
}
