/*
  BH1750 (GY-302) 光感測器 -> Render 後端 連線版
  功能：讀取 BH1750 光度(lux)，每隔幾秒用 HTTPS POST 傳到後端；
        同時本地即時控制 LED(暗處亮燈、亮處熄滅)。

  需要安裝的函式庫（Arduino IDE -> 程式庫管理員）：
    - BH1750 (by Christopher Laws)
    - ArduinoJson (by Benoit Blanchon)
  ESP32 board package 內建就有 WiFi.h / HTTPClient.h / WiFiClientSecure.h，不用額外裝

  後端契約（app/hardware_gy302/router.py）：
    POST /api/hardware_gy302/upload
    body: {"lux": <float, 必須 >= 0>}
*/

#include <Arduino.h>
#include <Wire.h>
#include <BH1750.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ====== 請修改成你的資訊 ======
const char* WIFI_SSID     = "";           // Wi-Fi 或手機熱點名稱(需為 2.4GHz)
const char* WIFI_PASSWORD = "";   // Wi-Fi 密碼

// Render 後端網址（注意 prefix 是 hardware_gy302，不是 hardware）
const char* SERVER_URL = "https://igem-ncku-software.onrender.com/api/hardware_gy302/upload";
// ==============================

// --- 硬體物件與參數設定 ---
BH1750 lightMeter;

const int LED_PIN = 2;          // 內建 LED 腳位 (GPIO 2)
float thresholdLux = 50.0;      // 明暗判定門檻值 (Lux)

// --- 計時設定(非阻塞) ---
unsigned long lastReadTime = 0;
const unsigned long READ_INTERVAL_MS = 500;   // 每 0.5 秒讀一次 + 控制 LED
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL_MS = 3000;  // 每 3 秒上傳一次到後端

// HTTPS timeout 拉長，Render 免費方案冷啟動要 30~60 秒
const uint16_t HTTP_TIMEOUT_MS = 20000;

float lastLux = -1;             // 記住最近一次讀到的光度，供上傳用(-1 = 尚未讀到有效值)
bool sensorOk = false;          // BH1750 是否初始化成功

void connectWiFi() {
  WiFi.mode(WIFI_STA);          // station 模式(連進既有網路，不是自己開熱點)
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("正在連線至 Wi-Fi: ");
  Serial.println(WIFI_SSID);

  int attempt = 0;
  const int MAX_ATTEMPTS = 30;  // 最多等 15 秒（30 x 500ms）
  while (WiFi.status() != WL_CONNECTED && attempt < MAX_ATTEMPTS) {
    delay(500);
    Serial.print(".");
    attempt++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi 連線成功！ESP32 IP 位址: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.print("Wi-Fi 連線失敗，狀態碼: ");
    Serial.println(WiFi.status());
    Serial.println("常見狀態碼意思： 1=找不到SSID(名稱錯或5GHz) / 4,6=密碼錯誤");
    Serial.println("請確認 SSID 為 2.4GHz 頻段，且密碼正確。");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);

  // 1. 初始化 Wi-Fi 連線
  WiFi.setAutoReconnect(true);
  connectWiFi();

  // 2. 初始化 I2C (SDA = GPIO 21, SCL = GPIO 22)
  Wire.begin(21, 22);
  Serial.println("BH1750 GY-302 模組初始化中...");

  sensorOk = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire);
  if (sensorOk) {
    Serial.println("BH1750 初始化成功 (位址 0x23)");
  } else {
    // ADDR 腳接高電位時位址會變成 0x5C，這裡再試一次
    sensorOk = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x5C, &Wire);
    if (sensorOk) {
      Serial.println("BH1750 初始化成功 (位址 0x5C)");
    } else {
      Serial.println("BH1750 初始化失敗，請檢查 21/22 腳位接線與供電");
    }
  }
}

void loop() {
  unsigned long now = millis();

  // ---- 每 0.5 秒：讀光度 + 控制 LED + Serial 輸出 ----
  if (now - lastReadTime >= READ_INTERVAL_MS) {
    lastReadTime = now;

    float lux = lightMeter.readLightLevel();

    if (isnan(lux) || lux < 0) {
      // BH1750 讀取失敗時會回傳負值(-1 / -2)
      Serial.print("BH1750 讀值異常: ");
      Serial.println(lux);
      lastLux = -1;
      digitalWrite(LED_PIN, LOW);
    } else {
      lastLux = lux;
      String stateStr = (lux < thresholdLux) ? "Dark" : "Bright";

      Serial.print("Light = ");
      Serial.print(lux);
      Serial.print(" lux | State = ");
      Serial.println(stateStr);

      // LED 狀態控制 (暗處亮燈，亮處熄滅)
      digitalWrite(LED_PIN, (lux < thresholdLux) ? HIGH : LOW);
    }
  }

  // ---- 每 3 秒：上傳最近一次光度到後端 ----
  if (now - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = now;
    sendData(lastLux);
  }
}

void sendData(float lux) {
  // 後端的 lux 欄位限制 ge=0，送負值會被擋成 422，所以先在這裡攔掉
  if (lux < 0) {
    Serial.println("尚無有效讀值，略過本次上傳");
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi 未連線，嘗試重連...");
    connectWiFi();
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();          // 測試階段先跳過憑證驗證，正式上線建議改用憑證驗證
  client.setTimeout(HTTP_TIMEOUT_MS / 1000);

  HTTPClient https;
  https.setTimeout(HTTP_TIMEOUT_MS);
  https.setConnectTimeout(HTTP_TIMEOUT_MS);

  Serial.print("上傳到後端: ");
  Serial.println(SERVER_URL);

  if (https.begin(client, SERVER_URL)) {
    https.addHeader("Content-Type", "application/json");

    // 組 JSON payload（後端 SensorReading 只認 lux 這個欄位）
    StaticJsonDocument<128> doc;
    doc["lux"] = lux;

    String payload;
    serializeJson(doc, payload);
    Serial.println("送出 payload: " + payload);

    int httpCode = https.POST(payload);

    if (httpCode > 0) {
      Serial.printf("HTTP 回應碼: %d\n", httpCode);
      String response = https.getString();
      Serial.println("後端回應: " + response);
      if (httpCode == 422) {
        Serial.println("422 = 後端不接受這個 JSON 格式，請確認欄位名稱是否為 lux");
      }
    } else {
      Serial.printf("上傳失敗，錯誤: %s\n", https.errorToString(httpCode).c_str());
      Serial.println("若是 -1 / -11，通常是 Render 免費方案在冷啟動，等一下會自己恢復");
    }

    https.end();
  } else {
    Serial.println("無法連線到後端");
  }
}
