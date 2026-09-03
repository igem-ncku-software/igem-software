/*
 * NodeMCU-32S (ESP32) + GY-302 (BH1750) ambient light sensor.
 *
 * Connects to WiFi, reads illuminance (lux) from the GY-302 over I2C
 * every UPLOAD_INTERVAL_MS, and POSTs it as JSON to the backend's
 * /api/hardware_gy302/upload endpoint:
 *   { "lux": 123.45 }
 *
 * Wiring (GY-302 -> ESP32, default I2C pins):
 *   VCC  -> 3V3
 *   GND  -> GND
 *   SCL  -> GPIO22
 *   SDA  -> GPIO21
 *   ADDR -> GND (I2C address 0x23; leave floating/high for 0x5C)
 *
 * Required libraries (Arduino Library Manager):
 *   - "BH1750" by claudio rocchini
 *   - ArduinoJson (by Benoit Blanchon)
 */

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <BH1750.h>
#include <ArduinoJson.h>

// ---- Wifi credentials ----
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ---- Backend endpoint ----
// 本機測試用電腦的區網 IP + uvicorn 預設埠（例如 http://192.168.1.23:8000）；
// 正式環境改成 Render 的網址 https://igem-ncku-software.onrender.com
const char *UPLOAD_URL = "http://192.168.1.23:8000/api/hardware_gy302/upload";

const unsigned long UPLOAD_INTERVAL_MS = 2000;

BH1750 lightMeter;

void connectWifi() {
  Serial.printf("Connecting to WiFi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("WiFi connected, IP address: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  delay(200);

  Wire.begin(); // 預設 SDA=GPIO21, SCL=GPIO22
  if (!lightMeter.begin()) {
    Serial.println("Failed to initialize BH1750 (GY-302). Check wiring.");
  }

  connectWifi();
}

void uploadReading(float lux) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected, attempting to reconnect...");
    connectWifi();
    return;
  }

  HTTPClient http;
  http.begin(UPLOAD_URL);
  http.addHeader("Content-Type", "application/json");

  JsonDocument doc;
  doc["lux"] = lux;
  String body;
  serializeJson(doc, body);

  int statusCode = http.POST(body);
  if (statusCode > 0) {
    Serial.printf("Uploaded lux=%.2f, HTTP %d\n", lux, statusCode);
  } else {
    Serial.printf("Upload failed: %s\n", http.errorToString(statusCode).c_str());
  }

  http.end();
}

void loop() {
  float lux = lightMeter.readLightLevel();

  if (lux < 0) {
    Serial.println("Failed to read from BH1750 sensor.");
  } else {
    uploadReading(lux);
  }

  delay(UPLOAD_INTERVAL_MS);
}
