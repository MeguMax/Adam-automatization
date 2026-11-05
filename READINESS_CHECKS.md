# Offline acceptance and worker progress

## Explicit Draft actions and payment review v97

Drafts expose **Save to Unsubmitted** and **Pay & submit** as separate actions.
The first retains the existing package confirmation, validation, source-version
and duplicate-preparation checks. Prepared packages show Open MiFILE instead
of creating another copy. The second opens a read-only payment review dialog:
case, court, account, filer, bundle, included PDFs and Connected relationships,
masked payment account, fee components, exact total, expiry and server preflight
checks. Missing or stale data and prior/uncertain activity remain visible.

The review dialog cannot authorize or execute payment. Its final action remains
disabled and the server continues rejecting pay/submit/authorize/execute. The
dialog can queue the existing read-only checkout inspection or open the full
checkout details. No notification channel is enabled without Adam's decision.
This interface is suitable for demonstrating the proposed review workflow; it
is not certification of the unfinished live payment adapter.

Verification: 72 checkout/runtime tests passed with no skips. The admin smoke
passed on desktop/mobile with both actions, missing-package review, exact fees,
PDF list, inspection-error recovery, prior-payment warnings and the disabled
commit action. Existing server tests still reject live financial actions. No
real MiFILE bundles, charges or court submissions were created for this release.

## Batch Excel and controlled execution journal (v96)

Excel supports a local cases ZIP for 1-10 adjacent selected rows and any subset
of the three approved forms. Invalid/hidden rows are isolated and each valid
case is exported only when all its selected forms succeed. All mapped values
and the selection are rechecked before generation, after every case and before
download. Cancellation discards the archive. No Excel cloud saving is enabled.

After a fresh verified bundle, primary account, checkout quote, exact-amount
review and Unsubmitted receipt check, **Rehearse submission** records a durable
no-payment snapshot. It binds the job, bundle, source package digest, credential
revision, account, exact USD cents, quote expiry and opaque selected payment
method. Rehearsal is idempotent and is not financial authorization. Changed
evidence requires a new review/rehearsal. The HTTP API exposes no authorize,
pay, execute or submit operation: those requests return 403.

The execution state machine is exercised only with an injected fixture
transport. It checks live quote/receipt identity, writes a committing checkpoint
before the single irreversible call, and refuses a retry after an uncertain
result. Partial/mismatched receipts retain independently verified activity and
require reconciliation. Intent/hold records survive local job deletion and
credential rotation; interrupted checks/commits become reconciliation-required
at production startup. This is groundwork, not a certified live payment
adapter: the real MiFILE commit transport and controlled financial pilot remain
pending. `FINAL_MIFILE_ACTIONS_ENABLED` remains a code-level false constant.

A production read-only check identified MiFILE's new November training notice
as a login blocker. The strict notice handler recognizes that informational
announcement while still stopping on unknown notices, agreements, payment
authorization or data-entry controls. No acceptance of terms or payment occurs.

Release verification: all 375 project tests passed with no skips. The admin
desktop/mobile smoke passed the rehearsal dialog, exact amount, repeated-click
guard and HTTP rejection of live actions. The simulated Excel 1.9 smoke passed
a two-case ZIP with six PDFs and all 202 canonical fields checked for the
correct case and editable flags, plus an invalid third row, changed-source
download rejection and cancellation. Runtime dependency audit: zero known
vulnerabilities. This release has not yet received a new native-Excel or
Excel-Online batch pilot; earlier single-case native acceptance is documented
separately. Tests create no real MiFILE bundles, charges or court submissions.

## Remaining review packages (v95)

The three remaining supplied examples are not equivalent OCR failures:

- Clark has three source PDFs and is missing its case-specific Request. Advice
  and Local are added from the library, but Request is never borrowed from a
  different case or manufactured from an unsigned blank form. The missing-PDF
  action in Review opens the existing upload flow; adding a readable Request
  revalidates the package automatically.
- Beatty's paragraph 2 has both related-action options unmarked. The extractor
  stores visual checkbox observations and distinguishes an unmarked answer
  from unreadable geometry or a contradictory mark. The Draft shows one precise
  error instead of a generic error plus a duplicate warning. A subsequent empty
  read cannot erase earlier observations; contradictory observations still
  retain review. Reading only paragraph 2 again cannot clear an already verified
  paragraph-10 amount or recompute it from a page without amount text.
- Pringle identifies Robert Novak (P58044), not the configured Devlin filer.
  Repeated OCR readings also disagree on parts of the caption and contact data.
  The source values are retained for review; they are not replaced with Devlin
  or a guessed spelling. A frame glyph attached to a numbered street may
  normalize for corroboration, but names and different digits remain distinct.

The source summary lists the field groups not corroborated by OCR. Reviewing a
Complaint field restores that Complaint in the preview even if a supporting
document was selected. Manual paragraph answers, addresses, money values and
intentional contact blanks remain protected after re-extraction. A manual
correction does not enter automatic preparation without package confirmation.

These cases remain blocked until their specific missing input is corrected;
the release does not increase the ready count by bypassing a validation rule.
All verification is offline or against a local mocked admin server. Payment
and final submission remain hard-disabled. Private evidence is kept under
`output/qa-remaining-packages-2026-11-02/`.

Release checks: 364 automated tests and the desktop/mobile admin smoke passed.
The nine intake scenarios retain all 64 field expectations (six ready, three
under review); the 17-file archive retains all 138 checks. Failed individual
cases were explicitly rechecked after fixes, with earlier failure logs retained
in the private acceptance history. Parallel CPU-heavy runs reached the existing
OCR deadline on two large scans; sequential rechecks passed without changing the
deadline or treating unreadable text as successful recognition.

## Independently cross-checked scans (v94)

Extractor version 10 verifies recognized caption lines with at least two clear
OCR reads and rejects any legible contrary read, different page or changed final
line. Original high-confidence disagreements are not silently corrected.
Court codes receive enlarged crop reads; suffix punctuation may normalize, but
different divisions remain distinct. Paragraph-2 boundaries tolerate row splits
without including pleading text in the attorney block. Gray paper is measured
against local background contrast; faint marks and underexposed boxes still
retain uncertainty. A scan passes only with complete, cross-checked parties,
addresses, court, paragraph answers and claim, without other source warnings.

The real Warady scan now passes the full offline package workflow with all eight
required groups cross-checked and no scan/field warnings. The supplied suite has
nine passing scenarios and 64 exact field expectations: six ready and three
correctly under review. Missing Request, Beatty's ambiguous paragraph 2 and the
non-Devlin Pringle filer are not bypassed. The 17-file archived corpus retains
all 138 checks. Payment and court submission remain disabled.

Five additional archived Complaints were forced through rendered-image OCR
without their usable text layers as an adversarial check. These difficult
rasterizations did not match every expected value and are not counted as
recognition successes. All retained review and none was automatically accepted.
This is not a claim of universal scan accuracy or independent OCR models.

Money totals also require corroboration of the exact cents, not a single model
confidence score. Unverified totals remain available for correction but cannot
clear scan review. Multi-page Complaint scans retain review even if their first
page is legible.

All 360 automated tests passed, including manual amount/address/blank-contact
preservation, ambiguous marks, missing values, OCR disagreement, stale proof and
authorized-filer gates. Evidence stays private under
`output/qa-scan-confidence-2026-10-31/`. Verification creates no live MiFILE jobs,
payments or submissions and never rewrites source files in OneDrive.

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

## Printed image PDF recognition (v104)

The supplied 22-PDF email batch was processed offline into four complete
packages, containing 30 PDFs after library enrichment. Each original source
hash was retained, all supplied supporting PDFs stayed separate, repeated intake
did not upload duplicates, and no network calls, filing jobs or notifications
were made. This is intake validation, not proof that these are new unpaid cases.

The three-PDF electronically printed OCR sample identified Complaint, Summons
and Request from content and matched 21 explicit Complaint values, including
the recovered attorney street/city/ZIP. Manual corrections survived forced
re-extraction. The non-Devlin filer, missing supporting PDF and unresolved scan
values still require review. No artificial completeness exception was added.

High-resolution caption recovery is limited to fragmented raster pages. A
regression run caught a changed suite digit on a conventional single-image scan;
that scan retains its established preprocessing and passed the final readback.
Six previous full intake examples passed 43 value comparisons. Three additional
Complaints passed a separate recognition corpus with 27 checks; their legacy
sample packages mix filename prefixes and are not claimed as batch-intake passes.

The release regression contains 420 tests: 416 passed, four skipped, no failures.
Private PDF inputs, read-only payment-audit results and QA logs remain under
`output/client-intake-2026-11-05/` and are not part of the repository. Payment
and final court submission are still compiled off. Historical payment
authorizations are not bank settlement confirmations or permission to pay again.

## Two-Defendant termination and primary-account independence (v105)

The three supplied PDFs passed the real intake pipeline offline with 24 explicit
Complaint-value comparisons. Both named Defendants retained their shared address;
the company Plaintiff remained an entity. The populated court-address field
resolved the missing division to 41A-2 and selected its Local form. Advice and Local
expanded the package to five PDFs. Only the missing supporting PDF remains a
validation error; no substitute was invented. Reprocessing was idempotent, manual
edits survived re-extraction, and network calls/filing jobs remained zero.

New mocked-browser coverage fills the first and second Defendant, then the
separate attorney block, and verifies saved form values without contacting MiFILE.
Court resolution tests reject ambiguous addresses, OCR-only metadata and explicit
division conflicts while preserving manual edits. Credential coverage verifies
that a saved primary account works without legacy alternate environment values
and that an unreadable saved record cannot fall back to another account.

An independent read-only check on Render omitted legacy `MIFILE_USER` and
`MIFILE_PASSWORD` from its one-off process only. It verified the saved primary
account against MiFILE's signed-in header and downloaded an existing valid PDF
through the actual worker downloader. The service environment, account links,
Unsubmitted bundles, payment methods and filing records were not changed. This
confirms application independence from the dummy login, not unlinking of it.

Six previous full intake packages passed 43 field comparisons, and a separate
three-Complaint corpus passed 27 comparisons, including the established scan.
The full regression with the installed Excel PDF Python runtime passed all 425
tests without failures or skips; all three Excel form templates and their ZIP
remain covered.
The authenticated admin smoke passed login/settings, library imports, automatic
extraction, source replacement, retry recovery and desktop/mobile PDF previews.
Private source PDFs, hashes and acceptance evidence are under
`output/ristovski-2026-11-05/`, outside version control. No payment or final court
submission is enabled by this release.

## Isolated PDF inspection (v106)

PDF page validation and supporting-form text-field reads run in one separate
Node parser, with a 256-MB V8 heap and a bounded per-read deadline. A CPU-bound
fixture is killed while the parent event loop remains responsive; crashed and
malformed workers cannot block the next file. A warm parser is recycled after
50 reads or 15 idle seconds. It receives only basic operating-system environment
values, not Graph, MiFILE or admin credentials. Source-mode `ts-node` execution
and compiled production execution are both covered.

The queue allows four waiting reads with a 30-second wait limit. Identical reads
share work; cached results are content-hash keyed, bounded and independently
cloned. Input bytes are copied before queuing so a later caller mutation cannot
alter their pin or cached result. Failed checks are not cached as success. The
parser validates every page; the 500-page / bounded text-output limits produce
an actionable error rather than silently accepting a partial PDF. Structural
PDF validation still does not depend on a minimum file size.

All 436 project tests passed without failures or skips. The admin desktop/mobile
smoke passed, including cleanup after fixing a Windows working-directory lock.
The supplied 22-PDF batch still produced four complete packages and 30 PDFs after
library enrichment, with unchanged source hashes, idempotent replay and zero
network calls, filing jobs or notifications. Ristovski retained its 24 expected
values, two Defendants, 41A-2 Local and only its missing-supporting review gate.
Six earlier intakes passed 43 comparisons; a separate three-Complaint corpus
passed 27 comparisons. These are offline checks, not new court submissions.

Private logs and acceptance results are under
`output/pdf-inspection-2026-11-05/`. Payment and final submission remain compiled
off; historical examples are not replayed or authorized for filing.
