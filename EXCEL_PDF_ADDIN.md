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
- Known date fields use Excel's own TEXT function with m/d/yyyy. No guessed serial-date epoch or date mutation.
- Same admin credentials, but a separate, 30-minute PDF-only session. Tokens remain in task-pane memory; no third-party cookies or browser storage are required.
- PDF.js preview and explicit download. All PDF fields remain fillable. Temporary server files are deleted after the worker returns; there is no generated-PDF archive in SQLite.
- Successful generation scrolls to the result. Preview height adapts to short Office task panes so the download action stays reachable.
- **Back to form** returns to the form selector without reopening Office's panel or signing in again.
- Download names include the form, court, case number and parties when available, with Windows-unsafe characters removed.
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
an authorized pilot. Excel Online and Adam's tenant installation remain unverified.

Protocol references:
- https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0

## Installation and first live test

Manifest: https://legal-workflow-admin.onrender.com/excel/manifest.xml

Task pane: https://legal-workflow-admin.onrender.com/excel/

Opening the task-pane URL in a normal browser does not connect it to a workbook.
Install the manifest in Excel, open the supplied workbook, select a single case
row, sign in with admin credentials, choose a form and select **Generate PDF**.
Inspect the preview and download the result. Closing/reloading the panel or a
server redeployment requires signing in again.

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

The first installation in Adam's Microsoft 365 tenant and Excel Online has not
been verified yet. Automated browser QA uses an explicitly simulated Office API;
it is separate from the native Windows checks and does not establish tenant or
web-host compatibility. Optional OneDrive delivery must be configured separately.

On 2026-10-28 the v66 pane was refreshed in Windows desktop Excel and signed in
again before testing. DC105, both DC508 pages and MC202 were generated and
downloaded for the second fictional case. **Back to form** kept the sign-in.
Selecting the first case cleared the previous preview; MC202 regenerated and
downloaded with the first case's values without reopening the pane. All four
downloads passed canonical/widget value, checkbox state, editable-field and
appearance checks (126 fields / five pages), followed by local visual review.
The test changed selection only, not workbook data. This run is separate from
the earlier native formula-edit test and from Excel Online verification.

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
