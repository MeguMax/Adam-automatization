# Devlin Law Excel PDF Forms

This is separate from email intake, Draft review and MiFILE preparation. It never
sends email, modifies case records, pays fees or submits a filing.

## Current implementation

- Office.js task pane for Microsoft 365 Excel desktop and Excel Online, requiring ExcelApi 1.9 (including calculation-state and worksheet-collection events).
- Three approved templates: DC105 Judgment, DC508 Conditional Dismissal (both pages), MC202 Certification of Records.
- A **PDF Forms** button in the **Devlin Law** group on Excel's **Home** ribbon opens the panel. It does not generate or upload anything by itself.
- Current selected row is recalculated and read from the open workbook immediately before generation. No XLSX cache or workbook upload is used.
- Generation waits up to 15 seconds for Excel to finish calculating. If calculation does not finish, no PDF is generated from cached values.
- The selected sheet, row, case identity and mapped field values are checked again after generation and immediately before download. A changed case or formula invalidates the PDF and requires regeneration.
- Changes and selections are tracked across the worksheet collection, including newly added sheets. Rechecks still protect downloads when host change events are unavailable.
- Exact matching column names; missing/duplicate columns and mapped Excel errors stop generation. Errors in unrelated columns do not block a valid form.
- Source issues are collected for the selected form or all three ZIP forms. The panel lists missing/duplicate headers and invalid mapped cells with their source sheet and addresses. Cell buttons select the exact worksheet cell (or the header row for a missing column) without rewriting values, formulas or headers. PDF layout errors also link back to the source cell.
- Known numeric date fields use Excel's MONTH, DAY and YEAR results, assembled as m/d/yyyy without locale-specific TEXT format codes. No guessed serial-date epoch or date mutation.
- One initial connection with admin credentials creates a separate, fixed 12-hour PDF-only session. The panel restores it automatically after reload/reopening; restarting Render does not revoke it. No password is stored in the pane, manifest, workbook or browser storage.
- The browser stores only an opaque Excel access token and its expiry. SQLite stores only its hash and credential version in a separate `excel_sessions` table. This token cannot open the admin panel or MiFILE. Disconnect, expiry and credential changes revoke access; reconnecting never extends the original deadline.
- Sessions belong to the Office/browser profile, not its IP address. Desktop Excel and Excel Online can use separate storage partitions and may each need an initial connection. If browser storage is disabled, generation still works for the current pane but closing it requires reconnecting. Third-party cookies are not required.
- A temporary server/network failure while restoring access keeps the connection and exposes **Reconnect**, without asking for the password again. PDF generation remains disabled until the server verifies access.
- PDF.js preview and explicit download. All PDF fields remain fillable. Temporary server files are deleted after the worker returns; there is no generated-PDF archive in SQLite.
- Successful generation scrolls to the result. Preview height adapts to short Office task panes so the download action stays reachable.
- **Back to form** returns to the form selector without reopening Office's panel or signing in again.
- Download names include the form, court, case number and parties when available, with Windows-unsafe characters removed.
- The last chosen form is remembered per Office/browser profile. No case data or custom filenames are saved in preferences.
- **File name** can be edited before generation. A missing form prefix and `.pdf` extension are added; unsafe paths, other form names and overlong names are rejected before a PDF request. The reset icon restores the automatic name. Editing the name invalidates the old result; changing cases resets it, while refreshing the same case retains the custom name. The download and optional OneDrive delivery use the same generated name.
- Login requests have a 20-second deadline; PDF generation/download responses have a 45-second deadline. Network failures, HTML gateway errors and invalid PDF responses leave generation retryable without exposing a broken download.
- Long text is measured against its actual PDF widget. The original font size is retained when it fits; otherwise it is reduced to a minimum of 7 pt. Explicit line breaks are preserved in multiline fields. Values are never truncated, abbreviated or silently wrapped.
- Text that cannot fit legibly, unsupported font characters, control characters, or line breaks in a single-line field stop generation. Field-specific errors identify the original worksheet and cell; correct that value/formula in Excel and generate again.
- Export reopens the PDF and verifies canonical values, widget values, appearances and checkbox states. The source templates are never modified and existing output files are never overwritten.

Downloads remain available independently of OneDrive. The panel does **not**
silently write to `C:\Users\adamj\OneDrive\Documents`; that local path cannot
identify the correct cloud folder on Render.

## Optional OneDrive delivery

The current rollout remains **download-only**, as requested. No Excel delivery
folder or new Microsoft permissions have been configured.

Set `EXCEL_PDF_ONEDRIVE_SHARE_URL` to an approved **folder** sharing URL, such as
Adam's intended Documents folder. The existing `TENANT_ID`, `CLIENT_ID` and
`CLIENT_SECRET` application must already have access to that folder. The module
does not grant permissions or create sharing links. It never falls back to the
court worker's `ONEDRIVE_ROOT_SHARE_URL`.

When configured and accessible, the authenticated panel shows the destination
folder, **Save to OneDrive**, and **Save to OneDrive automatically**. Automatic
delivery is off until the user checks it for the current sign-in. A successful
save exposes an **Open saved OneDrive file** link. Failed saves leave the PDF
available for download and retry. Without this setting, only download controls
are shown. Do not enable it until the actual target folder is confirmed.

Only the exact server-generated PDF shown in the preview can be saved. It is
bound to the PDF-only session; arbitrary file bytes and caller-supplied paths
are not accepted. A bounded memory cache retains at most eight PDFs / 16 MiB for
five minutes, not a disk or database archive. The panel rechecks the selected
row and mapped values immediately before sending the save request.

Saved names include a content-hash suffix. Upload sessions fail on name conflict;
existing files are never blindly replaced. Both a successful upload and a retry
after an uncertain result are checked by downloading the target file and comparing
its SHA-256 hash, parent folder and byte count. A mismatched existing file stops
the save. One cloud save runs at a time, with a 40-second operation deadline.

API/adapter tests and browser QA exercise this flow without writing real cloud
files. Live delivery to Adam's destination is still pending the folder link and
an authorized pilot. Installation in Adam's Microsoft 365 tenant remains unverified.

Protocol references:
- https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0

## Installation and first live test

Customer guide: https://legal-workflow-admin.onrender.com/excel/help

The same English guide opens from the question-mark icon in the panel. It covers
Microsoft 365 installation, initial connection, single-PDF and ZIP downloads,
workbook requirements and common recovery actions. It contains no credentials,
customer workbook values or PDF templates and works without the Office runtime.

Manifest: https://legal-workflow-admin.onrender.com/excel/manifest.xml

Task pane: https://legal-workflow-admin.onrender.com/excel/

Opening the task-pane URL in a normal browser does not connect it to a workbook.
Install the manifest in Excel, open the supplied workbook, select a single case
row, connect once with admin credentials, choose a form and select **Generate PDF**.
Inspect the preview and download the result. For the next 12 hours the same
Office/browser profile reconnects automatically when the panel is reopened or
the server redeploys. **Disconnect** clears local access and revokes the server
session. An expired connection requires a new sign-in. No credentials are embedded
for automatic login, and neither PDF generation nor the admin API is public.

Use manifest version 1.2.0.0 or later for the Home ribbon command. Reimport the
manifest if an older test installation still declares ExcelApi 1.7 or lacks the
command. The workbook's first row must contain
the exact form column headers and a nonempty `Defendant` case-identity column.
Optional filename context uses `Landlord`, `Court_Name` (or `Court`) and
`Case_Number`. Missing or duplicate mapped form columns are not guessed.

For an initial Excel Online test, upload the XML manifest through Office's
**Upload My Add-in** flow, when permitted by the tenant. For regular deployment
across desktop and web, Adam's Microsoft 365 administrator can deploy the custom
add-in through the Microsoft 365 admin center. Windows shared-folder sideloading
is a testing option, not the production deployment method.

### Adam's Microsoft 365 installation

1. Download the XML manifest from the link above.
2. Sign in to the Microsoft 365 admin center with Adam's organizational administrator account.
3. Open **Settings > Integrated apps**, then the **Add-ins** link and **Deploy Add-in**.
4. Choose the custom add-in option and upload the XML manifest (or use its public HTTPS URL).
5. Assign the initial rollout to **Just me** or specifically to Adam, not the entire organization.
6. Adam reviews the existing workbook read/write permission and completes deployment himself.
7. Open Excel with that organizational account. Find **Devlin Law > PDF Forms** on **Home**; use **More Options** if the ribbon is narrow.
8. Select a case row, connect for 12 hours, choose a form, optionally adjust **File name**, and generate/download the fillable PDF.

The downloaded file goes to the browser/Excel download location or the location
chosen in its save dialog, not automatically to Adam's OneDrive folder. Customer
workbooks and source PDF templates stay unchanged. Updating the hosted panel does
not require reinstalling this unchanged manifest. Deployment in Adam's tenant is
still his administrator-controlled step, not something verified on our personal
test account.

Official installation reference: [Microsoft 365 add-in deployment](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-deployment-of-add-ins?view=o365-worldwide).

Personal OneDrive's browser editor has two ancestor origins: `onedrive.live.com`
and `excel.officeapps.live.com`. The public `/excel/*` shell allows both explicitly
in its framing policy; it does not allow arbitrary `*.live.com` hosts. This policy
does not apply to the main admin sign-in, which continues to reject framing.

Official installation references:
- https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing
- https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-deployment-of-add-ins
- https://learn.microsoft.com/en-us/javascript/api/excel/excel.application?view=excel-js-1.9

The panel loaded successfully in the local Windows Excel host after a full Excel
restart, using a fictional workbook. No security settings or recovery files were
changed. Registration while Excel was already running did not load the panel;
for development testing, close Excel completely after saving open work before
registering and reopening the add-in. A successful registration command alone is
not evidence that Office loaded the panel.

Windows desktop QA also verified sign-in, live row reads, all three generated
fillable PDF downloads (48/28/25 fields and 1/2/1 pages), selection-change
invalidation and a second case after changing a formula input. Reopened downloaded
files matched the case data and date produced by Excel. The fictional input was
restored after the recalculation test.

The v64 desktop repeat downloaded all three forms from an ordinary fictional
workbook through Render. The downloaded files were reopened and checked for 101
canonical fields, matching widget values, editable fields and nonempty
appearances; all four pages were rendered and visually reviewed. Party names,
case numbers and the Excel-formatted DC105 date matched their source columns.
Selection changes invalidated the old result. Post-edit regeneration was not
completed in this repeat: reopening the panel required a new sign-in. The earlier
desktop recalculation check and automated change-during-generation checks remain
separate evidence.

The first installation in Adam's Microsoft 365 tenant has not been verified yet.
Automated browser QA uses an explicitly simulated Office API; it is separate
from the real Windows and Excel Online checks below and does not establish
compatibility with every tenant policy. Optional OneDrive delivery must be
configured separately.

On 2026-10-28 the v66 pane was refreshed in Windows desktop Excel and signed in
again before testing. DC105, both DC508 pages and MC202 were generated and
downloaded for the second fictional case. **Back to form** kept the sign-in.
Selecting the first case cleared the previous preview; MC202 regenerated and
downloaded with the first case's values without reopening the pane. All four
downloads passed canonical/widget value, checkbox state, editable-field and
appearance checks (126 fields / five pages), followed by local visual review.
The test changed selection only, not workbook data. This run is separate from
the earlier native formula-edit test and from Excel Online verification.

On 2026-10-28 the version 1.2.0.0 manifest was installed through Excel Online's
Upload My Add-in dialog in a personal OneDrive test workbook containing only
fictional cases. The Home ribbon command opened the live Render v69 panel.
After signing in once, DC105, DC508 (both pages) and MC202 were generated and
downloaded from row 3. All 101 canonical fields, including intentionally blank
values and unchecked boxes, matched the fixture; widget values, appearances,
checkbox states and editable flags also passed readback. All four PDF pages
were rendered locally and visually reviewed.

Selecting row 2 cleared the previous PDF and download action. MC202 regenerated
and downloaded with the second case's values without reopening the pane or
signing in again. This brought the real web-host check to four downloads,
126 field comparisons and five visually reviewed pages. The header-row guard
was observed before selection. Workbook values/formulas were not edited in this
run; formula-edit coverage remains a separate native/automated check. All PDF
delivery was local downloads. No Excel PDFs were saved to OneDrive, and no
email, MiFILE preparation, payment or court submission was performed by this QA.
This confirms the tested personal OneDrive web host, not deployment in Adam's
Microsoft 365 tenant. Local evidence is under
`output/qa-excel-online-2026-10-28/`.

An already-open Office task pane keeps its loaded frontend through a server
deployment. Before testing a new frontend, right-click inside the panel and use
**Reload** (or close and reopen the pane), then sign in again. A successful PDF
from the new server alone does not prove the panel's frontend was refreshed.

## Runtime and tests

Render's Docker image installs an isolated Python environment with the pinned
dependencies in `tools/excel_pdf/requirements.txt`. A build-time check generates
and verifies all three blank forms before the image can start. Generation runs
in a separate process with a 25-second timeout, bounded input/output and one
concurrent request. The worker and admin inbox remain independent.

For local generation, set `EXCEL_PDF_PYTHON` to a Python executable with those
dependencies. `EXCEL_PDF_PUBLIC_URL` optionally configures the HTTPS origin in the
downloaded manifest; it must not include a path, credentials or query string.

```powershell
npm.cmd test
npm.cmd run test:excel-pdf
python tools/excel_pdf/check_install.py
python -m unittest discover -s tools/excel_pdf -p test_core.py -v
npx.cmd office-addin-manifest validate output/devlin-law-excel.xml
```

`test:excel-pdf` runs a local, isolated task-pane server, a simulated Office host,
real PDF generation/downloads, mobile/desktop screenshots and nonblank canvas
checks. It also tests delayed calculation, silent formula changes during
generation, stale downloads, newly added worksheets, HTTP/network failures,
invalid PDF responses and timeout recovery. It never connects to
Microsoft Graph, MiFILE or a live workbook.

The edited-formula scenario changes a source value, generates again without
reopening the panel, downloads the real PDF and verifies its canonical field
value. Additional coverage checks manual/automatic delivery, identical saved
bytes, failed-save retry, stale-save rejection and the download-only layout.
Cloud storage in these tests is an injected adapter, not Adam's real OneDrive.

The appearance-quality regression also renders all 31 checkboxes through PDF.js
in both states and compares pixels inside each widget. It tests visible marks,
not merely nonempty appearance streams. Oversized text must produce a source-cell
error, no partial download, and successful regeneration after correction.
Python round-trip coverage fills and clears all 101 fields, checks long captions,
multiline addresses, date/money/zero values, and rejects unreadable text without
leaving a pending file. The normal `npm test` regression also runs this Python
suite when the configured PDF runtime is available. The PDF core uses pinned ReportLab standard-font metrics
and pypdf for the interactive output; it does not flatten the forms.

Local acceptance on 2026-10-27 regenerated all three forms for each of the three
supplied examples. All 303 saved-cache field comparisons had no material
differences from the supplied PDFs. The customer workbook and generated customer
samples stayed local and were not uploaded to the test service. This does not
replace a live Excel calculation test or establish Excel Online compatibility.

Architecture: `src/excelPdf.ts` owns only `/excel/*`; `excel-addin/` contains the
task pane and row reader; `tools/excel_pdf/http_worker.py` invokes the verified
Python core. Templates under `assets/excel-pdf/` are attorney-provided blank forms
with all interactive values cleared. They are not exposed as public downloads.

## Twelve-hour connection acceptance (2026-10-28)

The v70 change retains server-side generation. It does not enable anonymous
generation, cloud delivery, payments or court submission. No new environment
variables or manifest permissions are required. Migration 29 creates the separate
SQLite session table on the existing persistent Render disk.

All 211 automated project tests passed. Session integration tests close and reopen
SQLite and recreate the HTTP handler to verify restart recovery, fixed expiry,
hashed tokens, logout and credential revocation, same-origin checks and isolation
from admin authentication. The 27 Excel-specific tests also passed separately.

The browser smoke test uses an explicit simulated Excel host, real PDF generation,
and screenshots. It verifies automatic restoration after reload/navigation, no
additional credential POST, temporary 502 recovery without losing access, expired
session cleanup, the active 12-hour expiry timer, storage-disabled fallback, all
three forms and all 31 visible checkbox marks. The admin desktop/mobile smoke
also passed. Screenshots are in `output/excel-addin-qa/`.

These checks do not claim a new real-Office acceptance run for v70 or a 12-hour
wall-clock soak. Earlier real desktop/web tests above identify their actual
versions. Browser storage restrictions can still require an initial connection
per Office/browser profile; the server never authorizes another user by IP alone.

## Usability acceptance (2026-10-28, v71)

The new filename and remembered-form behavior passed the browser smoke test and
all 212 automated project tests. Unsafe names are rejected before generation;
editing a name hides the old result; reset and same-case refresh are covered.

In real Excel Online, one initial connection was followed by closing/reopening
the pane and a Render deployment from v70 to v71. Access restored without another
credential entry. DC105, DC508 and MC202 were generated for the fictional row 3
with edited filenames and downloaded locally. Reopening retained MC202, while the
custom name was not persisted. Selecting row 2 retained the form, refreshed the
case-specific filename, and generated a separate MC202. All 126 fields in the
four actual downloads, their five pages, widget appearances and fillable flags
were verified; all five pages were rendered and visually inspected.

Separately, local generation from the customer workbook's saved cache produced
nine PDFs. All 303 fields matched the three supplied completed examples, allowing
only equivalent numeric formatting and equivalent checkbox on/off states. The
customer workbook and examples were read-only and were not uploaded. This is not
a new live recalculation of Adam's workbook. Evidence is under
`output/excel-usability-2026-10-28/`.

The main production QA Draft TEMP-MJKS6DER was checked without reprocessing or
creating a second filing: Prepared, seven documents, two Connected to Complaint,
Unsubmitted-only. A blank embedded-preview navigation was observed. The v72
fallback adds Retry preview and a separate Open PDF link when the initial blank
frame persists after its automatic recovery. The admin smoke tests both the
fallback and successful retry, including the mobile layout. It changes no case
data, preparation status, payment setting or court-submission permission.

Live v72 readback confirmed that the recovery controls replace the persistent
blank iframe and the same PDF renders correctly in a separate tab. Retrying the
embedded frame in this Edge session still stalled; this is a tested fallback,
not a claim that the underlying embedded-navigation issue is fully resolved.

The desktop Excel windows could not be reliably inspected in this run. New
desktop v71 acceptance and installation in Adam's own Microsoft 365 tenant remain
pending; previous real desktop evidence above applies to its stated versions.

The desktop acceptance gap recorded above was closed by the following run.
The v73 main Draft-preview change does not modify Excel generation or its session.

## Windows desktop acceptance (2026-10-29, v73)

After one initial user sign-in, the current production pane generated DC105,
DC508 and MC202 from row 3 of the local fictional `qa-cases.xlsx` workbook.
Each PDF was downloaded locally with a custom filename. Selecting row 2 removed
the old preview, retained MC202, reset the case-specific filename and generated
a separate PDF for Morgan Example. Refreshing the same row preserved its edited
filename. No workbook cells or formulas were changed during this run.

Closing the task pane and reopening it through Home > PDF Forms restored the
connection without another sign-in. MC202 remained selected and the custom
filename was not persisted; the current case's automatic filename was restored.
This verifies reopening within a valid session, not a 12-hour wall-clock soak.

All 126 fields in the four actual downloads matched the fixture, including the
fixed `DATE(2026,10,27)` formula result. Canonical field values, page widgets,
appearance streams, checkbox states, page counts and editable flags passed.
All five pages were rendered and visually inspected. Poppler reported missing
display fonts for retained Symbol/ArialUnicode resources; the reviewed populated
appearances rendered correctly without clipping or missing values.

Evidence is in `output/desktop-excel-2026-10-29/`, including the field-verification
JSON, rendered pages and reopened-pane screenshot. Excel PDF delivery remains
local-only. No customer workbook was uploaded, no cloud copy was created and no
MiFILE preparation, payment or court submission was performed by this run.
Installation and a first pilot in Adam's own Microsoft 365 tenant remain separate
rollout steps. No new runtime code, manifest permissions or deployment variables
were needed for this acceptance run.

The full project regression was rerun on 2026-10-29: all 218 tests passed, with
zero failures, cancellations or skipped tests. Production health reported
`2026-10-28-inline-preview-v73`, ready, with `unsubmitted_only` preparation.

## Three-form local ZIP (v86)

The panel offers `Generate all 3 forms (ZIP)` alongside individual generation.
It reads all 101 matching fields from one calculated row, formats date serials
using Excel, then generates DC105, DC508 and MC202 as three separate fillable
PDFs. Member filenames use the same case metadata and their own form prefixes.
The archive filename begins `FORMS`. ZIP generation uses automatic member names;
the editable single-PDF filename still applies only to that individual form.

The whole input is validated before generation. A missing column, formula error,
invalid field or failed PDF prevents the entire download; partial archives are
not returned. Changes to the row, sheet, case identity or any of the 101 fields
invalidate the ZIP both after generation and immediately before download.
`/excel/generate-package` uses the same PDF-only 12-hour session, same-origin
checks and single-generation slot. Sessions are checked again before returning
the result. Each Python worker retains its 25-second deadline; the package
request has a separate 105-second client deadline.

ZIP contents are held in memory only for the response. The ZIP never creates a
OneDrive generation handle or performs a cloud save, including when optional
single-PDF cloud delivery is configured. Local downloads remain the production
delivery mode. Updating the installed panel requires no new Office permissions.

## Real Excel Online ZIP acceptance (2026-10-31, v87)

The installed panel was tested in the real Excel Online host with the fictional
`qa-cases.xlsx` workbook and the production Render generator. Reopening the pane
loaded the new version and restored its valid connection without another login.

The first attempt exposed a date-format failure at `dc105_24` in the localized
Office host. Numeric dates now use Excel's MONTH, DAY and YEAR results instead
of locale-sensitive TEXT format tokens. No cells, formulas or workbook date
settings are changed, and no serial-date epoch is guessed. All 309 project tests
and the complete simulated Office task-pane smoke passed after the correction.

Two ZIPs were generated and downloaded from rows 2 and 3. Each archive contained
exactly DC105, DC508 and MC202, with its own case-specific filenames. Selecting
the second row removed the previous ZIP result; no additional login or pane
restart was needed between cases. Both ZIPs passed CRC checks. All 202 canonical
field values, their page widgets, editable flags and appearance streams passed
independent readback. The eight original pages were rendered and inspected;
the fixed DATE formula appeared as `10/27/2026` in each DC105.

Local verification copies of all six PDFs were edited, saved and reopened.
Changed text and checkbox states survived, while other fields were preserved.
Three checked widgets from the first case were additionally rendered with PDF.js
and visibly compared against their unchecked originals. The local Windows
Poppler runtime did not display these legacy checkbox glyphs reliably, so its
renders alone were not used as proof of checkbox appearance. The original ZIPs
and PDFs were not modified by these edit checks.

Evidence is under `output/qa-excel-zip-2026-10-31/`, including per-case verification
JSON, rendered pages, checkbox pixel comparisons and real-Office screenshots.
Generation still runs on Render; file saving is local-only. No OneDrive copy,
MiFILE preparation, payment or court submission was performed by this acceptance
run. Installation and acceptance in Adam's own Microsoft 365 tenant remain a
separate pilot step; this does not claim a new desktop-Excel ZIP acceptance run.

## Source diagnostics (v88)

Mapped column validation reports all detected missing headers, duplicate headers,
formula errors and unsupported values in the current read instead of stopping at
the first column. The ZIP checks the union of its three forms; an individual PDF
still ignores errors in unrelated form columns. Required case identity and date
errors also retain their worksheet context.

`Source issues` appears only when applicable. It lists the affected sheet and
cells, with selection buttons for real cells or the header row when a column is
missing. Repeated headers expose their actual locations. These controls only
activate a worksheet and select a cell; they do not repair, rename or overwrite
anything. The immediate readback does not force another calculation. Selecting
a header keeps generation blocked until a data row is selected again. Fixing a
source value or choosing another form refreshes validation normally.

All 312 project tests passed without skips. The simulated Excel 1.9 browser smoke
also passed: two simultaneous ZIP header errors stopped before any PDF request,
source navigation selected the exact header/data cell without changing values,
and a server-side layout error linked back to its source cell. Existing individual
PDFs, three-form ZIPs, session restoration, download guards and local-only mode
remain covered. This is not a new real desktop-Excel acceptance result; native
input was unavailable in this run, and the desktop ZIP pilot remains pending.

## Real Windows desktop ZIP acceptance (2026-10-31, v88)

The installed task pane was tested in Windows desktop Excel after one initial
user sign-in. Production Render generated two ZIPs from rows 2 and 3 of the local
fictional `qa-cases.xlsx` workbook. Each actual local download contained exactly
DC105, DC508 and MC202 with its own case-specific filenames. Switching rows
removed the previous ZIP result and refreshed the case identity without another
sign-in. Closing and reopening Home > PDF Forms restored the valid session and
remembered MC202; no 12-hour wall-clock soak is claimed.

Both ZIPs passed CRC checks. All 202 canonical field values, page widgets,
appearance streams and editable flags matched the fixture. All eight original
pages were rendered with PDF.js and visually inspected, including the fixed
`DATE(2026,10,27)` result. Local verification copies of all six PDFs were edited,
saved and reopened: changed text and checkbox states survived while other values
remained intact. PDF.js pixel comparisons also confirmed that each of the six
test checkbox marks visibly changed. The downloaded originals were not edited.

A temporary rename of the fictional `dc105_01` header verified native source
diagnostics. MC202 remained available independently, while the three-form ZIP
reported the missing mapped column under Source issues. Its Header row button
selected A1 on the correct worksheet. The temporary edit was undone, the
original header was visibly restored, and ZIP generation succeeded again.
The QA workbook was not saved with the temporary error. This closes the desktop
ZIP acceptance gap above; it does not claim acceptance in Adam's own tenant.

The complete project regression was rerun: 312 tests passed with zero failures,
cancellations or skipped tests. Evidence is under
`output/qa-excel-desktop-zip-2026-10-31/`, including field-verification JSON,
PDF.js renderings, checkbox pixel comparisons and native Excel screenshots.
Generation remains on Render and PDF delivery remains local-only. No customer
workbook was uploaded, no OneDrive copy was created, and no MiFILE preparation,
payment or court submission was performed by this acceptance run. No runtime,
manifest, permission or environment changes were required.

## Self-service startup and recovery (v89)

The panel waits for a supported Excel host before showing the credential form or
restoring a saved PDF session. Opening its URL in an ordinary browser instead
shows Open in Excel and the installation guide. Unsupported Excel versions,
missing Office.js, and an unresolved Office.onReady callback have distinct
recovery states; initialization has a 20-second watchdog. A failure to download
the initial Office.js script is still subject to the browser's network handling
before our own deferred application script can run.

The public form catalog has a separate 20-second fetch/body deadline and schema
validation. Temporary gateway errors, malformed data and stalled responses show
Reload forms without discarding a valid PDF session. Connecting while the
catalog is unavailable cannot generate from stale mappings. Once the catalog
returns, the current row is read again. An online event retries only an unavailable
catalog or failed session restoration, never a PDF request, download or cloud
write. Concurrent session-restoration attempts are suppressed. The explicit
Reconnect and Reload forms actions remain available when the server recovers
without a browser connectivity event. No credentials are resent automatically.

The manifest's support link now points to the guide. Existing installed manifests
continue to work, with unchanged API requirements and workbook permissions; the
panel's guide link does not require reinstallation. PDF saving remains local-only.

All 313 project tests passed without skips. The simulated Excel 1.9 browser smoke
also passed catalog gateway/schema/deadline recovery, password-free online resume,
ordinary-browser and unsupported/missing/stalled Office states, and the guide at
340 px and 1280 px. It reran all three PDFs, the 101-field ZIP, editable field and
checkbox checks, source navigation, expired-session guards and download-only mode.
The runtime dependency audit reported zero known vulnerabilities. These checks
do not replace installation and acceptance in Adam's own Microsoft 365 tenant.
