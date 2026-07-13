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

5. Leave `WORKER_ENABLED=false` for the first deploy. Open `https://<service>.onrender.com/`, authenticate with `ADMIN_USERNAME` and `ADMIN_PASSWORD`, and verify `https://<service>.onrender.com/healthz` returns `{"ok":true}`.

6. While the worker is disabled, the admin synchronizes up to 500 recent inbox messages. This reconstructs recent email records and reports without downloading historical court files again.

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
   Worker runtime: { buildId: '2026-07-12-plaintiff-db-naming-v3', ... }
   Plaintiff naming database lookup: ...
   OneDrive file name selected: ...
   ```

## Notes

- Render provides `PORT`; the admin binds to it automatically on `0.0.0.0`.
- `/healthz` is public only for Render health checks. The dashboard and all `/api/*` endpoints require admin credentials.
- Do not copy a live SQLite file over the running Render database. This deployment starts with a clean operational database, restores Plaintiff mappings from the seed, and rebuilds recent inbox state from Microsoft 365. A full historical SQLite migration should be handled separately if old audit history is required.
