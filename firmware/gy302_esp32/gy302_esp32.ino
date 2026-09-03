/*
  ESP32 -> Render 後端 連線測試
  功能：模擬感測器數值，每隔幾秒用 HTTPS POST 傳到後端

  需要安裝的函式庫（Arduino IDE -> 程式庫管理員）：
    - ArduinoJson (by Benoit Blanchon)
  ESP32 board package 內建就有 WiFi.h / HTTPClient.h / WiFiClientSecure.h，不用額外裝
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ====== 請修改成你的資訊 ======
const char* WIFI_SSID     = "";
const char* WIFI_PASSWORD = "";

// Render 後端網址
const char* SERVER_URL = "https://igem-ncku-software.onrender.com/api/hardware/upload";

// 這台 ESP32 的識別名稱（之後多顆板子時用來分辨來源）
const char* DEVICE_ID = "esp32-test-01";
// ==============================

unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL_MS = 3000; // 每 3 秒送一次

void setup() {
  Serial.begin(115200);
  delay(500);

  WiFi.mode(WIFI_STA); // 確保是 station 模式，不是 AP 模式
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("正在連接 WiFi: ");
  Serial.println(WIFI_SSID);

  int attempt = 0;
  const int MAX_ATTEMPTS = 30; // 最多等 15 秒（30 x 500ms）

  while (WiFi.status() != WL_CONNECTED && attempt < MAX_ATTEMPTS) {
    delay(500);
    Serial.print(".");
    attempt++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi 已連線，IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.print("WiFi 連線失敗，狀態碼: ");
    Serial.println(WiFi.status());
    Serial.println("常見狀態碼意思：");
    Serial.println("  1 = 找不到這個 SSID（名稱打錯，或該頻段ESP32不支援，例如5GHz）");
    Serial.println("  4 = 連線失敗（通常是密碼錯誤）");
    Serial.println("  6 = 密碼錯誤");
    Serial.println("請檢查 WIFI_SSID 是否為 2.4GHz 頻段，並確認密碼正確。");
  }
}

void loop() {
  if (millis() - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = millis();
    sendSimulatedData();
  }
}

void sendSimulatedData() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi 未連線，略過本次傳送");
    return;
  }

  // 模擬感測數值：用 sin 波 + 一點雜訊，看起來比純隨機更像真實訊號
  static float t = 0;
  t += 0.3;
  float simulatedValue = 500 + 200 * sin(t) + random(-20, 20);

  WiFiClientSecure client;
  client.setInsecure(); // 測試階段先跳過憑證驗證，正式上線建議改用憑證驗證

  HTTPClient https;
  Serial.print("連線到後端: ");
  Serial.println(SERVER_URL);

  if (https.begin(client, SERVER_URL)) {
    https.addHeader("Content-Type", "application/json");

    // 組 JSON payload
    StaticJsonDocument<200> doc;
    doc["device_id"] = DEVICE_ID;
    doc["value"] = simulatedValue;
    doc["unit"] = "a.u."; // 之後可改成你實際的單位，例如 "RFU"

    String payload;
    serializeJson(doc, payload);

    int httpCode = https.POST(payload);

    if (httpCode > 0) {
      Serial.printf("HTTP 回應碼: %d\n", httpCode);
      String response = https.getString();
      Serial.println("後端回應: " + response);
    } else {
      Serial.printf("傳送失敗，錯誤: %s\n", https.errorToString(httpCode).c_str());
    }

    https.end();
  } else {
    Serial.println("無法連線到後端");
  }
}
