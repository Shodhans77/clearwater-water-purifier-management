# Windows setup

Install Node.js 20+, PostgreSQL 15+, VS Code and Arduino IDE 2.x. In PowerShell from the project root:

```powershell
Copy-Item .env.example .env
# Edit configuration and set seed passwords (12+ characters)
notepad .env
# Use this PowerShell command to generate a JWT secret, then paste it into JWT_SECRET in .env:
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
Copy-Item .env apps/api/.env -Force
npm install --workspaces=false
npm install --prefix apps/api --workspaces=false
npm install --prefix apps/web --workspaces=false
createdb -U postgres clearwater
npm exec --prefix apps/api -- prisma generate --schema apps/api/prisma/schema.prisma
npm run db:migrate --prefix apps/api
npm run db:seed --prefix apps/api
# Start these in separate PowerShell windows:
npm run dev --prefix apps/api
npm run dev --prefix apps/web
npm run worker:demo --prefix apps/api
npm run worker:reports --prefix apps/api
```

Open http://localhost:5173. API health is http://localhost:4000/api/health. The seed accounts are `shodhan.s77@gmail.com` (customer) and `shodhanchinnu45@gmail.com` (provider); their passwords are the `SEED_CUSTOMER_PASSWORD` and `SEED_PROVIDER_PASSWORD` values you chose. Change them after first login. The seed is repeatable and does not reset existing passwords. The provider login can add buildings/floors, generate customer claim codes, update calibration/thresholds, record maintenance, manage service requests and download on-demand PDF reports based only on stored readings.

For password reset email, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` in `.env`, then copy the updated file to `apps/api/.env`. If these values are missing, the UI reports that no email was sent. Start `npm run worker:reports --prefix apps/api` to generate saved PDF reports for each active device after each full UTC week; the report history is available in the portal.

Arduino IDE: install ArduinoJson, DHT sensor library, Adafruit GFX and SSD1306. Edit Wi-Fi, device ID/secret, and `API_URL` with the computer's LAN IPv4 (never localhost). Allow inbound TCP 4000 on the private network. The seed adds `CW-REAL-001` for both accounts, but does not set its secret hash. The provider Add Device form provisions or rotates the credential and displays it once. Never put this secret in the frontend. The unit is not connected until a real packet is stored.

## Uploading the ESP32 firmware

1. Sign in to the provider account, choose **Add device**, enter `CW-REAL-001` and a display name. This rotates the shared device credential and shows a new secret once. Copy it into the firmware's `DEVICE_SECRET` and save the `.ino` file privately.
2. In PowerShell run `ipconfig` and copy the computer's IPv4 address on the same Wi-Fi network as the ESP32. Put that address in `API_URL`, for example `http://192.168.1.24:4000/api/telemetry`.
3. In Arduino IDE open `firmware/clearwater_esp32/clearwater_esp32.ino`. Install the listed libraries through **Tools → Manage Libraries**. Select **ESP32 Dev Module**, the connected COM port, then click **Upload**.
4. Open **Tools → Serial Monitor**, set 115200 baud. Successful HTTP responses show status 202. Sign in to both portals; customer and provider views should show the same `CW-REAL-001` device and its real readings after the first accepted packet.

If `createdb` is not recognized, create database `clearwater` in pgAdmin (right-click **Databases → Create → Database**) or add PostgreSQL's `bin` directory to PATH. Use HTTP only on a trusted local network; use HTTPS and TLS-capable firmware for deployment.
