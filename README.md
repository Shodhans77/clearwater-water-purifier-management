# ClearWater — Remote Integrated Water Purifier Management

Fresh project for customer and service-provider water purifier monitoring. This repository is an engineering demonstration scaffold with a React client, Express API, PostgreSQL/Prisma schema, and ESP32 firmware.

## Start locally

1. Install Node.js 20+ and PostgreSQL 15+.
2. Follow [docs/setup.md](docs/setup.md) to configure `.env`, install packages, migrate and seed.
3. Start the API, web app and demo worker in separate PowerShell windows.
4. Open http://localhost:5173.

See [docs/setup.md](docs/setup.md), [docs/esp32-integration.md](docs/esp32-integration.md), and [docs/calibration.md](docs/calibration.md).

**Included:** separate customer/provider registration and portals; password hashing and SMTP-backed password reset; seed accounts; a shared real-device row; provider credential rotation and customer claim codes; building/floor management; calibrated telemetry ingestion, configurable warning thresholds, offline/sensor/leak alerts; scoped SSE with a 10-second polling fallback; consumption, history, calibration and maintenance views; service requests; technician and billing records; scheduled and on-demand weekly PDF reports; demo-only simulator and reset; and a PWA shell. The ESP32 device is not considered online until it sends an authenticated packet.

**Still needed before production completion:** verify migrations, seeding and all user flows against PostgreSQL; test with physical hardware; configure and validate SMTP deliverability; complete technician-to-request assignments and richer billing workflows; add integration tests and deployment hardening. This environment had no PostgreSQL installation or connected hardware, so those checks are not claimed.
