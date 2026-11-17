# ClearWater deployment notes

This deployment copy is separate from the working local folder. No local environment files, ESP32 `secrets.h`, generated reports, `outputs/`, or `work/` artifacts belong in the public repository. Keep provider credentials in Vercel/Render/Neon secret settings only.

## Services

- Vercel builds `apps/web` and proxies `/api/*` to `https://clearwater-api-shodhan.onrender.com/api/*`. Change the destination in `vercel.json` only if the Render service receives a different hostname.
- Render runs the Express API, report worker, and demo telemetry worker. The API runs `prisma migrate deploy` as its pre-deploy command. The report worker has a persistent disk mounted at `reports/` so saved PDFs and their database paths remain available across restarts.
- Configure Render `WEB_ORIGIN` to the exact production Vercel origin. Add required secret values in the Render dashboard, never in this file.

## Environment variables

API and worker services need `DATABASE_URL` for Neon. API needs a strong generated `JWT_SECRET`, `WEB_ORIGIN`, `DEVICE_OFFLINE_SECONDS`, and `DEMO_SIMULATOR=false`. Password-reset email needs `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. The current database seed also requires `SEED_CUSTOMER_PASSWORD` and `SEED_PROVIDER_PASSWORD` if a seed is intentionally run; do not run the seed against production without a reviewed plan. `PORT` is supplied by Render. Never copy `.env` files to a provider or repository.

## Neon migration and data protection

Do not point the production app at the existing local database, and do not run a schema reset. Before migration, take and validate a `pg_dump` backup of the local PostgreSQL database. Create a separate Neon database/branch, inspect the existing schema and migration history, then restore/import the backup into Neon and verify table/row counts. Only after that review should the Neon connection string be configured in Render. `prisma migrate deploy` applies checked-in pending migrations; it does not seed or reset the database. Keep the backup unchanged until the public app has been verified and the rollback window is accepted.

## Production readiness gates

The current app uses bearer tokens in `localStorage`; `docs/deployment.md` itself says to replace that with secure HttpOnly cookies before production. This deployment copy intentionally does not change authentication. Do not expose production user data until the authentication change is separately approved and completed. ESP32 firmware currently targets a private LAN HTTP address; update only its API URL after the Render HTTPS URL is confirmed, and keep the device secret in ignored `secrets.h`.

The Render Blueprint declares paid starter services and persistent report storage. Review provider pricing and approve the configuration before creating services. The existing source code and schema are otherwise copied without feature changes.
