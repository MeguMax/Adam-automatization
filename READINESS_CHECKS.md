# Offline acceptance and worker progress

## Additional archived documents (v93)

`npm run test:recognition-corpus -- --manifest C:\private\corpus.json --output C:\private\results`
checks individual real PDFs independently of package preparation. Version-1
manifests contain `cases` with a unique `id`, a PDF `file` and explicit
`expected.role`. Optional expectations are `source`, `pageCount`, `extraction`
and required extraction-warning codes. Paths are relative to the manifest.
Expected party arrays require an exact length, not just matching first entries.

Each document runs in an isolated process with external requests prohibited and
an eight-minute deadline. The content classifier receives `document.pdf`, not a
helpful source filename. Optional `filename` also tests the actual naming hint.
Private results retain recognized roles, extracted fields, warnings and source
text; no mailbox/OneDrive updates or MiFILE jobs are created. Expectations must
be checked independently against the actual source pages, not copied blindly
from an extractor's result. A failed document does not skip the remaining corpus.

Extractor version 9 shares the same party-splitting rules across flattened text,
interactive fields and OCR. Commas between people no longer collapse several
Defendants into one party; business suffixes and ambiguous surname-first names
retain their safeguards. Notice recipients after the occupants boundary do not
become Defendants. Quarter-point checkbox geometry recognizes thin 8.75pt SCAO
squares without relaxing checked-mark or border thresholds. Faint interior marks
prevent an empty-box conclusion. Missing checkbox evidence stays unknown and no
longer retains stale high-confidence metadata for cleared automatic values.

Release acceptance: 17 additional archived PDFs (27 pages), including five
Complaints and two image-only documents, passed all 138 explicit checks. The
Complaints contributed 75 independently checked field values across four court
districts. Judicial orders and an Appearance remained non-Complaint documents.
The corpus is separate from the prior nine supplied package examples; those
nine also passed their 63 field expectations (five ready, four under review).
All 349 automated tests and desktop/mobile admin smoke passed. Runtime audit
reported zero known vulnerabilities. Private evidence stays under
`output/qa-broad-recognition-2026-10-31/`; PDFs, party data and cloud references
are not committed. Archive retrieval was read-only; no MiFILE job, payment or
court submission was created by this verification.

## Automatic checkout readiness (v92)

New verified primary-account packages continue automatically from Unsubmitted
status verification to a read-only exact-fee inspection. This is not payment
automation: no payment or court submission action is enabled. Failed checks use
bounded retries and persistent backoff; stale or uncertain results require
review. Existing bundles are not bulk-enrolled, and completed quotes are not
renewed forever. The Review screen exposes the amount/readiness state and links
directly to fee review without replacing the recorded court outcome.

Checkout regression fixtures cover the automatic sequence, unselected payment
methods, restarts, expiry, account changes, preparation priority, exact-amount
review and legacy/corrupt preflights. Durable account/bundle holds are tested
across password changes, duplicate local jobs and local-history deletion. A paid,
rejected or refunded observation never becomes permission to charge again.
These tests are not a real payment or court-submission acceptance test.

Release acceptance: 344/344 automated tests passed without skips; desktop/mobile
admin smoke passed; all nine supplied cases passed their explicit outcomes with
63 Complaint values compared (five ready, four retained review gates). No live
MiFILE preparation, payment or court submission was performed by this acceptance
run. Evidence is private under `output/qa-auto-checkout-v92-2026-10-31/` and the
`output/auto-checkout-v92-*-release.log` files. Runtime dependency audit: zero
known vulnerabilities.

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

## Complaint confidence (v91)

Extractor version 8 corrects attorney-column bleed while retaining the Defendant
address region. Contradictory repeated PDF fields and visual checkbox readings
are not resolved by document order. Selected damages/rent totals cannot retain
an earlier automatic claim when the observed values conflict. Unselected
conditional fields do not create false conflicts. Scalar corrections survive
re-extraction; conflicting whole-party PDF fields require a corrected source.

Review notes identify the exact low-confidence field group and open its Case
data control, including folded setup/attorney sections. The desktop/mobile
browser smoke verifies focus and responsive layout, alongside a nonblank PDF
preview. The full regression passes 330 tests without failures or skips.

All nine supplied intake scenarios passed their explicit offline expectations,
including 63 Complaint-value comparisons. Five packages were ready; missing
Request, an ambiguous related-action answer, scan review and the non-Devlin filer
retained their applicable review gates. The Warady attorney street no longer
contains the neighboring paragraph number and Pringle's Defendant address is
preserved. Cloud storage was mocked, network calls were blocked and no MiFILE
jobs were created. Private acceptance evidence is under
`output/qa-recognition-v8-release-2026-10-31/`.

The preceding v90 live automatic acceptance prepared ten source PDFs and five
Connected children of the Complaint in the primary account's Unsubmitted area.
The v91 recognition acceptance is offline and does not create another MiFILE
bundle, charge a payment account or submit anything to court. Both releases
retain the unsubmitted-only preparation limit.
