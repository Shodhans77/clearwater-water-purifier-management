# ESP32 integration

Pins per supplied setup: TDS 34, pH 32, turbidity 35, flow interrupt 26, leak 27, DHT11 4, OLED I2C SDA 21/SCL 22, LEDs 16/17/18. No pump, relay or ACS712 is included.

Firmware sends raw ADC values, pulse delta, approximate flow (450 pulses/L), cumulative litres, leak status, DHT temperature/humidity, sensor health and a monotonically increasing sequence every 10 seconds. It authenticates using `X-Device-Id` and `X-Device-Secret`. Raw data is never silently converted to ppm/pH/NTU. Add NTP plus Preferences/NVS persistence for sequence and accumulated pulses before field deployment; the current sketch resets the cumulative value on power loss.
