# Render Deployment

This project runs the admin UI and court-email worker in one Docker Web Service. Both use one SQLite database on the Render persistent disk at `/var/data/workflow.sqlite`.

## Before Deploying

- Use the Render Professional tier. In `render.yaml`, its valid Blueprint value is `pro`. SQLite requires the persistent disk and must run in one service instance.
- Keep exactly one active worker. Disable the old Render worker before enabling the new one.
- The public admin uses HTTP Basic Auth. Choose a long `ADMIN_PASSWORD` without a colon (`:`).

## First Deployment

1. Run local checks and export the existing short Plaintiff mappings:

   ```powershell
   npm.cmd test
   npm.cmd run plaintiffs:export -- .\plaintiff-mappings.json
   ```

2. Commit and push the deployment changes:

   ```powershell
   git add Dockerfile .dockerignore render.yaml DEPLOY_RENDER.md package.json package-lock.json src
   git commit -m "Prepare Render production deployment"
   git push origin HEAD
   ```

3. In Render, select **New** -> **Blueprint**, connect this repository, and confirm the `render.yaml` configuration. It creates one `pro` Docker Web Service with a 5 GB persistent disk.

4. Enter every requested secret. Copy their values from the local `.env`; never commit `.env`.

   Required secrets: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `USER_EMAIL`, `NOTIFY_TO_EMAIL`, `SENDER_USER_ID`, `ONEDRIVE_ROOT_SHARE_URL`, `MIFILE_USER`, `MIFILE_PASSWORD`, `TWO_CAPTCHA_API_KEY`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD`. `TRUECERTIFY_HEADLESS=true` and `TRUECERTIFY_DEBUG_DIR=/var/data/captcha_debug` are configured by the Blueprint.

5. Leave `WORKER_ENABLED=false` for the first deploy. Open `https://<service>.onrender.com/`, authenticate with `ADMIN_USERNAME` and `ADMIN_PASSWORD`, and verify `https://<service>.onrender.com/healthz` returns `{"ok":true}`.

6. While the worker is disabled, the admin synchronizes 100 recent inbox messages per background pass. Use **Sync 1000** once when a larger metadata backfill is needed; this does not download historical court files again.

## Transfer Plaintiff Mappings

The new Render database is persistent from its first deploy onward. Transfer the JSON generated in the first step so new file names immediately use existing short Plaintiff names.

1. In the Render service's **Connect** section, copy the SSH address and run:

   ```powershell
   scp.exe -s .\plaintiff-mappings.json <render-ssh-address>:/var/data/plaintiff-mappings.json
   ```

2. In Render Environment, temporarily add:

   ```text
   PLAINTIFF_MAPPINGS_SEED_PATH=/var/data/plaintiff-mappings.json
   ```

3. Run **Manual Deploy**. The startup log must include `Imported N Plaintiff mapping(s) from startup seed`.

4. Remove `PLAINTIFF_MAPPINGS_SEED_PATH` after a successful import so later deploys do not re-import it.

## Switch to the New Worker

1. Confirm the mapping list contains the expected short names.
2. Suspend or delete the old Render worker.
3. Change `WORKER_ENABLED` to `"true"` in `render.yaml`, commit and push that one-line change, then run **Manual Deploy**. You can also change it in the Render Dashboard, but keep `render.yaml` in sync so a later Blueprint update does not turn it off again.
4. Confirm the Render log contains:

   ```text
   Production worker enabled.
   Worker runtime: { buildId: '2026-08-12-resilient-downloads-v8', ... }
   Plaintiff naming database lookup: ...
   OneDrive file name selected: ...
   ```

## Notes

- Render provides `PORT`; the admin binds to it automatically on `0.0.0.0`.
- `/healthz` is public only for Render health checks. The dashboard and all `/api/*` endpoints require admin credentials.
- `DOCUMENT_IMMEDIATE_DOWNLOAD_ATTEMPTS=3` keeps a bad file from monopolizing the worker. Failed documents are retried later up to `DOCUMENT_AUTO_RETRY_LIMIT`, two due retry jobs per poll.
- Document retries use the URL and parsed case data already stored in SQLite. They do not require the original Outlook message unless the source is a PDF email attachment. If Outlook changed the message ID after moving the email, the worker recovers it by subject, sender, and received time.
- MiFILE authentication is verified by its identity cookie and cached for ten minutes. A response redirected to the login page invalidates and refreshes that session before the download is marked failed.
- Queue history is paginated from SQLite and is not capped at the newest 100 or 200 records. Period cleanup deletes database records and tombstones their mailbox IDs; it never deletes OneDrive files.
- Do not copy a live SQLite file over the running Render database. This deployment starts with a clean operational database, restores Plaintiff mappings from the seed, and rebuilds recent inbox state from Microsoft 365. A full historical SQLite migration should be handled separately if old audit history is required.
