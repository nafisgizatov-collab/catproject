#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include "secrets.h"
WebServer web(80); String lastState; unsigned long lastSentAt=0;
bool relay(const char* state){if(lastState==state&&millis()-lastSentAt<1000)return true;if(WiFi.status()!=WL_CONNECTED)return false;HTTPClient h;h.begin(DOOR_API_URL);h.addHeader("Content-Type","application/json");h.addHeader("X-Door-Token",DOOR_API_TOKEN);int code=h.POST(String("{\"state\":\"")+state+"\"}");h.end();if(code>=200&&code<300){lastState=state;lastSentAt=millis();return true;}return false;}
void openDoor(){bool ok=relay("opened");web.send(ok?202:503,"application/json",ok?"{\"ok\":true}":"{\"ok\":false}");}
void closeDoor(){bool ok=relay("closed");web.send(ok?202:503,"application/json",ok?"{\"ok\":true}":"{\"ok\":false}");}
void health(){web.send(200,"application/json",String("{\"ip\":\"")+WiFi.localIP().toString()+"\"}");}
void setup(){Serial.begin(115200);WiFi.mode(WIFI_STA);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);unsigned long d=millis()+30000;while(WiFi.status()!=WL_CONNECTED&&millis()<d)delay(250);web.on("/door/open",HTTP_POST,openDoor);web.on("/door/close",HTTP_POST,closeDoor);web.on("/health",HTTP_GET,health);web.begin();}
void loop(){web.handleClient();if(WiFi.status()!=WL_CONNECTED)WiFi.reconnect();}
