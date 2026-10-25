# Devlin Law Excel PDF Forms

This is separate from email intake, Draft review and MiFILE preparation. It never
sends email, modifies case records, pays fees or submits a filing.

## Current implementation

- Office.js task pane for Microsoft 365 Excel desktop and Excel Online, requiring ExcelApi 1.7.
- Three approved templates: DC105 Judgment, DC508 Conditional Dismissal (both pages), MC202 Certification of Records.
- Current selected row is recalculated and read from the open workbook immediately before generation. No XLSX cache or workbook upload is used.
- Exact matching column names; missing/duplicate columns and mapped Excel errors stop generation. Errors in unrelated columns do not block a valid form.
- Known date fields use Excel's own TEXT function with m/d/yyyy. No guessed serial-date epoch or date mutation.
- Same admin credentials, but a separate, 30-minute PDF-only session. Tokens remain in task-pane memory; no third-party cookies or browser storage are required.
- PDF.js preview and explicit download. All PDF fields remain fillable. Temporary server files are deleted after the worker returns; there is no generated-PDF archive in SQLite.

The current save action is a download. It does **not** silently write to
`C:\Users\adamj\OneDrive\Documents` or upload through Graph. The user can choose
that OneDrive-synced folder in the browser/Excel download workflow. Automatic
OneDrive delivery is a separate integration requiring explicit target-folder and
Microsoft account authorization.

## Installation and first live test

Manifest: https://legal-workflow-admin.onrender.com/excel/manifest.xml

Task pane: https://legal-workflow-admin.onrender.com/excel/

Opening the task-pane URL in a normal browser does not connect it to a workbook.
Install the manifest in Excel, open the supplied workbook, select a single case
row, sign in with admin credentials, choose a form and select **Generate PDF**.
Inspect the preview and download the result. Closing/reloading the panel or a
server redeployment requires signing in again.

For an initial Excel Online test, upload the XML manifest through Office's
**Upload My Add-in** flow, when permitted by the tenant. For regular deployment
across desktop and web, Adam's Microsoft 365 administrator can deploy the custom
add-in through the Microsoft 365 admin center. Windows shared-folder sideloading
is a testing option, not the production deployment method.

Official installation references:
- https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing
- https://learn.microsoft.com/en-us/microsoft-365/admin/manage/manage-deployment-of-add-ins

The first installation in Adam's real Excel host has not been verified yet.
Browser QA uses an explicitly simulated Office API; it is not proof of native
Office or tenant deployment compatibility. Download behavior and Office host
events must be confirmed in both desktop and Excel Online before production use.

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
npx.cmd office-addin-manifest validate output/devlin-law-excel.xml
```

`test:excel-pdf` runs a local, isolated task-pane server, a simulated Office host,
real PDF generation/downloads, mobile/desktop screenshots and nonblank canvas
checks. It never connects to Microsoft Graph, MiFILE or a live workbook.

Architecture: `src/excelPdf.ts` owns only `/excel/*`; `excel-addin/` contains the
task pane and row reader; `tools/excel_pdf/http_worker.py` invokes the verified
Python core. Templates under `assets/excel-pdf/` are attorney-provided blank forms
with all interactive values cleared. They are not exposed as public downloads.
