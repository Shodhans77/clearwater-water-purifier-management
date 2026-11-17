/* ESP32 DevKit V1. Install ArduinoJson, DHT sensor library, Adafruit GFX, SSD1306. */
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Wire.h>
#include <Preferences.h>
#include <time.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "secrets.h" // local-only Wi-Fi and device credentials; excluded by .gitignore
#define PIN_TDS 34
#define PIN_PH 32
#define PIN_TURBIDITY 35
#define PIN_FLOW 26
#define PIN_LEAK 27
#define PIN_DHT 4
#define PIN_GREEN 16
#define PIN_YELLOW 17
#define PIN_RED 18
#define DHTTYPE DHT11
const char* API_URL="http://172.20.10.3:4000/api/telemetry"; // laptop LAN IPv4; ESP32 must be on the same Wi-Fi/LAN
const float PULSES_PER_LITRE=450.0; const unsigned long SEND_EVERY_MS=10000;
DHT dht(PIN_DHT,DHTTYPE); Adafruit_SSD1306 display(128,64,&Wire,-1); Preferences prefs; volatile uint32_t pulses=0; uint32_t totalPulses=0,sequenceNo=0; unsigned long lastSend=0,lastPulseRead=0;
void IRAM_ATTR pulse(){pulses++;}
void setup(){Serial.begin(115200);analogReadResolution(12);pinMode(PIN_LEAK,INPUT);pinMode(PIN_FLOW,INPUT_PULLUP);pinMode(PIN_GREEN,OUTPUT);pinMode(PIN_YELLOW,OUTPUT);pinMode(PIN_RED,OUTPUT);attachInterrupt(digitalPinToInterrupt(PIN_FLOW),pulse,FALLING);dht.begin();Wire.begin(21,22);display.begin(SSD1306_SWITCHCAPVCC,0x3C);prefs.begin("clearwater",false);totalPulses=prefs.getUInt("pulses",0);sequenceNo=prefs.getUInt("seq",0);Serial.print("Connecting to Wi-Fi");WiFi.begin(WIFI_SSID,WIFI_PASSWORD);while(WiFi.status()!=WL_CONNECTED){delay(500);Serial.print('.');}Serial.print("\nWi-Fi connected. ESP32 IP: ");Serial.println(WiFi.localIP());configTime(0,0,"pool.ntp.org","time.nist.gov");}
void loop(){if(millis()-lastSend<SEND_EVERY_MS)return;lastSend=millis();uint32_t p;noInterrupts();p=pulses;pulses=0;interrupts();totalPulses+=p;float dt=(millis()-lastPulseRead)/60000.0;float flow=dt>0?(p/PULSES_PER_LITRE)/dt:0;lastPulseRead=millis();prefs.putUInt("pulses",totalPulses);int tds=analogRead(PIN_TDS),ph=analogRead(PIN_PH),turb=analogRead(PIN_TURBIDITY);bool leak=digitalRead(PIN_LEAK)==LOW;float temp=dht.readTemperature(),humidity=dht.readHumidity();bool dhtOk=!isnan(temp)&&!isnan(humidity);StaticJsonDocument<512> doc;doc["sequence"]=++sequenceNo;prefs.putUInt("seq",sequenceNo);time_t now=time(nullptr);struct tm timeinfo;if(now>1700000000&&getLocalTime(&timeinfo,20)){char stamp[25];strftime(stamp,sizeof(stamp),"%Y-%m-%dT%H:%M:%SZ",&timeinfo);doc["timestamp"]=stamp;}doc["rawTds"]=tds;doc["rawPh"]=ph;doc["rawTurbidity"]=turb;doc["pulseCount"]=p;doc["flowLpm"]=flow;doc["cumulativeLitres"]=totalPulses/PULSES_PER_LITRE;doc["leakage"]=leak;if(dhtOk){doc["temperatureC"]=temp;doc["humidityPct"]=humidity;}JsonObject health=doc.createNestedObject("sensorHealth");health["tds"]=true;health["ph"]=true;health["turbidity"]=true;health["flow"]=true;health["leakage"]=true;health["dht11"]=dhtOk;String body;serializeJson(doc,body);if(WiFi.status()==WL_CONNECTED){HTTPClient http;http.begin(API_URL);http.addHeader("Content-Type","application/json");http.addHeader("X-Device-Id",DEVICE_ID);http.addHeader("X-Device-Secret",DEVICE_SECRET);int code=http.POST(body);if(code>=200&&code<300)Serial.printf("Telemetry accepted (HTTP %d)\n",code);else Serial.printf("Telemetry rejected (HTTP %d): %s\n",code,http.getString().c_str());http.end();}else Serial.println("Wi-Fi disconnected; telemetry not sent.");digitalWrite(PIN_RED,leak);digitalWrite(PIN_YELLOW,!leak&&flow==0);digitalWrite(PIN_GREEN,!leak&&flow>0);display.clearDisplay();display.setTextColor(SSD1306_WHITE);display.setCursor(0,0);display.printf("TDS raw:%d\npH raw:%d\nTurb raw:%d\nFlow:%.2f L/min\nLeak:%s",tds,ph,turb,flow,leak?"YES":"NO");display.display();}
