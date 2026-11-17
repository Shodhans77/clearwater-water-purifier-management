# Architecture

React/Vite client, Express REST API, PostgreSQL through Prisma. The device row is canonical; customer and provider relations may reference that same row. `Device.kind` distinguishes REAL from DEMO. Only authenticated packets to REAL devices are stored. Telemetry retains raw ADC, optional calibrated values, device time, server receipt time and sequence. Unique sequence keys prevent retry duplication.

Potability is not inferred from these sensors. WQS appears only when all three water-quality measures are calibrated. Pump/relay/voltage/current fields are excluded. Authenticated, tenant-scoped SSE refreshes real-device views; a 10-second poll also refreshes simulator values and covers reconnects. Password-reset links are stored hashed, expire in 30 minutes, and are emailed only when SMTP is configured.
