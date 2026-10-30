# Offline acceptance and worker progress

## Supplied intake examples

Run a private acceptance manifest after building:

```powershell
npm.cmd run test:intake-examples -- --manifest C:\private\cases.json --output C:\private\results
```

The version-1 manifest contains `forms` (the library directory) and `cases`.
Each case has a unique lowercase `id`, local PDF `files`, and explicit
`expected.review`. Paths resolve relative to the manifest. Optional expectations
are `pdfCount`, an `extraction` subset (or `extractionFile`), `errorFields`,
positive `documentKinds` and `excludedDefendants`.

```json
{
  "version": 1,
  "forms": "C:/private/Local Advice",
  "cases": [{
    "id": "missing-request",
    "files": ["Complaint.pdf", "Summons.pdf", "Demand.pdf"],
    "expected": {"review": true, "pdfCount": 5, "errorFields": ["package.request"]}
  }]
}
```

Each case runs the real intake pipeline in a separate process and temporary DB,
with network blocked and cloud storage mocked. It verifies source-PDF retention,
expected review gates, preserved manual overrides, idempotent reprocessing and
zero external requests or MiFILE jobs. A failure does not skip later cases.
Each process has an eight-minute deadline. Summary JSON records outcomes and
elapsed times; detailed reports and logs contain private case data and must stay
outside version control. This is not a live court-acceptance or 100% OCR guarantee.

## Background workers

The header's activity icon opens the status of email processing, PDF recognition
and MiFILE preparation. Authenticated `GET /api/worker-health` reports the current
phase, last real checkpoint, elapsed time and last completed cycle. Polling this
endpoint never advances a checkpoint. A completed cycle means the worker loop
completed, not that every document or court filing succeeded; case-specific
errors remain in the Queue and Draft activity.

Workers not started in an admin-only process are explicitly unmonitored. Disabled
workers are not shown as healthy running workers. The UI refreshes every 15
seconds while visible and marks unavailable responses as unknown, not healthy.
State resets on server restart; historical case activity remains in SQLite.

No-progress deadlines are three minutes for inbox discovery, up to fifteen
minutes per email/download attempt group, and five minutes per recognition or
MiFILE checkpoint. Idle workers must check in within at least one minute (or
three poll intervals, whichever is longer). A 15-second watchdog logs transitions
requiring attention without including subjects, credentials, URLs or raw errors.
These are diagnostics, not cancellation deadlines or automatic retry permission.

`/healthz` remains a liveness check. Upstream failures must not cause Render to
restart a process in the middle of an uncertain MiFILE write. The monitor never
retries, submits, pays for, deletes or duplicates a bundle. Existing download
retry and MiFILE reconciliation rules remain authoritative. Final payment and
court submission remain disabled.

## Local v86 acceptance, 2026-10-31

All nine supplied scenarios passed their explicit expectations (62 compared
Complaint values). Three were ready and six correctly retained review gates;
the run made zero external requests or MiFILE jobs. Missing Request, missing
Demand/Notice, uncertain scan values and the non-Devlin attorney remained blocked.
All 308 automated tests passed without skips. Admin desktop/mobile browser smoke
and the simulated Excel 1.9 task-pane smoke also passed, including the local ZIP,
independent PDF/ZIP readback, change guards, failure recovery and rendered checkbox
marks. Real-Office rollout acceptance is recorded separately when performed.
