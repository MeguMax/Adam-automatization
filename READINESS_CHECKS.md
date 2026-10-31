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

## Supplied supporting policy (v90)

The attorney-confirmed package policy supersedes the former inferred Demand/Notice
gate. A Deed, Lease or other supplied supporting PDF no longer needs a legal
exception reason. Each remains a distinct Other/Connected upload under the
approved court rule. The required Complaint, Summons, Request, Advice and Local
forms, at least one supporting PDF, source hashes, readable files, duplicate/core
guards, account checks and the Devlin filer remain protected.

All nine supplied scenarios passed the revised explicit expectations, comparing
62 Complaint values with zero external requests and zero MiFILE jobs. Five were
ready and four retained review gates. The Deed-only and additional-supporting
examples now pass without inventing a Demand obligation. Missing Request,
uncertain Complaint scan values and the non-Devlin attorney remain under review.
Evidence stays private under `output/qa-supplied-policy-2026-10-31/`.

This offline run did not prepare, pay for or submit any real case. Previously
submitted/rejected bundles are not retried, old intakes do not enter a bulk
automatic replay, and queued version-1 completeness snapshots stop before remote
access. New version-2 snapshots bind every included PDF, source generation, role,
Filing Type, relationship and court before preparation.

All 322 automated project tests passed with no failures or skips. The desktop and
mobile admin smoke passed, including optional contents metadata, the supporting
PDF count, PDF preview, retained missing-form checks and stale browser-review
rejection. Integration coverage exercises five distinct supporting PDFs in both
Other and Connected courts, a complete email-to-preparation queue without a
Demand, an incomplete email that does not block the complete one, old snapshot
rejection, changed content pins and prevention of bulk legacy auto-queueing.
The runtime dependency audit reported zero known vulnerabilities.
