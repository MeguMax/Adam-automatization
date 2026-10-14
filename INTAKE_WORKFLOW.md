# New-case email intake and MiFILE preparation

## Current workflow

One authorized email creates one new Draft and one OneDrive folder. The worker processes attached PDFs, extracts fields from the Complaint, and validates the package. Nonpayment, termination, and DC 102c recovery-of-possession Complaints use the same filing workflow; paragraph 10 determines possession-only versus possession and supplemental money judgment.

The Draft editor displays the PDF with page navigation and zoom beside the editable fields. On mobile, switch between Document and Fields. Missing data, unreadable files, ambiguous document roles, and incomplete packages require review.

Completed email packages with no validation issues and no previous filing job can be queued automatically for preparation. Manual packages and packages requiring correction use the Draft review controls and **Prepare in MiFILE**. The only destination is **History > Unsubmitted**. Final submission and payment remain disabled. Both the alternate and primary accounts access live MiFILE; "alternate" does not mean sandbox. The only permitted filer is **Devlin, Adam**.

## Sending a package

Use the **Automation inbox** shown under **Settings > Email intake**. It is the existing Microsoft 365 mailbox configured by `USER_EMAIL`; no new mailbox is provisioned by this update.

Send a new email with a subject such as:

```text
NEW LT FILING - Example Property LLC v Morgan Tenant
```

Attach individual PDFs: Complaint, Summons, Request, and applicable Demand/Notice/Lease/Deed or other supporting documents. Include Advice and court-specific Local until the verified forms have been added to Settings > Form library. Keep each PDF within 25 MB. Word files, ZIP archives, and cloud-link-only packages are not supported as intake documents.

Document types are recognized from known titles in the PDF text layer or offline OCR when the text layer is insufficient. Filenames are a fallback, not the source of case facts. Filename-only recognition, low-confidence OCR, conflicting titles, combined packages, and unknown files require manual Filing Type confirmation. OCR can suggest Complaint parties and addresses, but scan-derived fields and paragraph 2/10 answers require review. Case facts continue to come from the Complaint.

Complaint extraction first reads populated DC 102a/DC 102c PDF form fields, including their actual checkbox values. Empty overlay fields do not override visible flattened text. If populated form fields are unavailable, the extractor reads the caption's text coordinates before using OCR. Drafts identify these sources as **PDF form fields**, **PDF text layout**, or **Scan OCR**. Clearly separated full Defendant names are entered as separate parties sharing the caption address. Additional caption notice recipients require review instead of being silently included as Defendants.

OCR renders up to approximately 300 DPI within the existing 8-million-pixel limit, normalizes contrast, corrects small skew, retries low-quality page segmentation, and re-reads identifiable party blocks separately. It runs offline and keeps the original PDF unchanged. Word confidence is checked within party regions, not just averaged across the page. Scan-derived values still require confirmation. Unread checkbox states remain unknown, and total claim amounts are not substituted with a monthly rent rate. Re-extraction clears unverified old automatic checkbox/amount answers while preserving explicit manual corrections.

An address absent from the Complaint must be entered manually. The extractor does not silently use the attorney's address as the Plaintiff's address. Missing Request documents and uncertain court-specific Other/Connected relationships remain visible review issues. **Extract fields** updates existing editable Drafts to the current extraction rules; deploying the update does not automatically reprocess or queue historical cases.

Live Draft refresh checks the selected record and edit revision again after each background response. Responses started before a field edit do not replace unsaved input, including while navigating between Drafts.

## Correcting and confirming a Draft

The review panel separates **required corrections** from **review notes**. Each arrow opens the affected field or document mapping; **First item** jumps to the first required correction. Missing Plaintiff and Defendant address components are reported individually. Correct the highlighted values and save to refresh validation. Notes from OCR or an unusual caption remain visible for the attorney's review rather than being silently dismissed.

Filing fields identify their saved source: PDF fields, PDF text, Scan OCR, Manual, or a default. Party and attorney provenance is tracked by field group. The document icon beside a Complaint-derived group opens the primary Complaint; it does not claim to locate the exact word or checkbox on a particular page. Empty values remain marked Missing.

**Confirm package** cannot waive required MiFILE answers: paragraph 2, paragraph 10, a positive supplemental claim amount, prior-action details when applicable, and an explicit Other/Connected choice must be completed. Choosing Review required for a document preserves that unknown state, including when its Filing Type is Other. Informational review notes can be acknowledged through normal package confirmation. Both automated and manual packages use **Prepare in MiFILE**, never a final-submit action.

The preparation button stays disabled after queueing, during preparation, while reconciliation is required, and after preparation. A repeated queue request returns a conflict without adding a second job. Core document constraints and the required mailing checkbox remain read-only; source PDFs remain viewable while the Draft is locked.

Selecting an unavailable document shows its download status, error, retry timing and recorded failure log directly above the PDF preview. The retry arrow queues the existing document retry without creating a second document. Unsaved Draft corrections are saved before queueing it. Internal email-attachment source identifiers are not presented as browser download links.

The MiFILE uploader requires an exact Filing Type option and stops if a requested Connected control is unavailable. It no longer selects a potentially different first option or silently skips a connection. Old queued payloads are checked again for unknown required answers and relationships before any external access. Temporary PDFs are removed even if OneDrive materialization fails partway through the package.

## Reusable forms

In **Settings > Form library**, upload the attorney-approved Advice PDF for all courts and a Local PDF for each exact MiFILE court name. Confirm the document type and court assignment before saving. No legal forms are preinstalled or downloaded from third parties.

The worker adds missing forms after intake. Saving a new-case Draft or extracting its Complaint also checks the library. **Add standard forms** performs the same check manually. Existing Advice/Local attachments are preserved, and repeated checks do not create duplicates. An exact court match is required. A district code can resolve to a court only when it uniquely matches a known full court name; ambiguous matches require manual selection.

Each form is copied into that case's OneDrive folder and pinned to its library version. Saving an updated form or disabling it affects future additions only. Existing Drafts and pending retries keep their original version. To replace a pinned form, remove it from the Draft and add the correct one. Changing a Draft's court blocks preparation if its Local form belongs to the previous court. A court may have multiple approved Local components. The 21st District Court receives both its Local information and Zoom instructions as separate Local filings. The complete three-page 73A packet is retained and filed as one Local document, in addition to the universal Advice.

Upload failures use the normal per-document automatic and manual retries. Inactive form versions remain available for already-reserved documents. Library PDFs are stored next to SQLite in `filing-forms/`, outside the database. On Render this is `/var/data/filing-forms/`. Back up both the database and this directory. Disabled versions are retained; they are not automatically deleted by email cleanup.

By default, accepted senders are `ajd@devlinlawpllc.com` and the `USER_EMAIL` address. Override the list with `FILING_INTAKE_ALLOWED_SENDERS`, a comma-separated list of exact email addresses. The sender list is visible in Settings.

Replies and forwards with `Re:` or `FW:` subjects do not create another intake. Original court notifications are processed only from exact `@truefiling.com` addresses. Client replies quoting a court notification are ignored, including delayed retries previously queued from those replies. `Document Sent` reads the case number and title from the actual email Subject header. Reprocessing the same recorded email resumes missing documents; sending the package as a completely new email creates a separate Draft.

Court notifications are download history and cannot create a new case package, including through the former manual-copy API. Notification reports do not announce filing readiness. To prepare a new case, the user must send an authorized intake or create a new manual Draft with original case documents.

Adam supplies Complaint, Summons, Request and at least one supporting document. The library adds Advice and the selected court's Local form, giving a minimum standard package of six documents. Missing library forms require correction. Automatic Other/Connected selection still needs Adam's court list; until then uncertain relationships require review.

## Storage and recovery

- PDFs are stored under `New filings/<stable package key>` in the configured OneDrive root. Stable file names prevent an uncertain upload retry from creating another copy at a new path.
- Each completed document is recorded immediately. A failed attachment does not stop later files in that package.
- The download and upload layer makes up to three immediate attempts for transient errors. Existing delayed document retries and manual retry controls remain available.
- Invalid or unreadable PDFs are recorded with a validation error. Correct them through the Draft document controls.
- Failures before the attachment list has been obtained get an email-level retry, with a delay starting at one minute and capped at thirty minutes. Record Detail shows the next Inbox retry time.
- Every completed retry reruns package validation. Download success alone does not make a case ready for preparation.
- The court must be explicitly selected if the Complaint has not provided a usable MiFILE court name. Court-specific Other/Connected relationships must be reviewed where no definitive mapping is available.
- Completed email intakes with zero current validation issues and no previous filing job can automatically queue preparation when the filing worker is enabled and ready. Set `MIFILE_AUTO_PREPARE_ENABLED=false` to disable this. Manual packages are excluded. Failed or uncertain filing jobs require review instead of automatic resubmission. The system does not automatically email a correction request to the sender.

## Account settings

The existing environment credentials remain active until an account is saved through Settings. To enable saving credentials, configure admin authentication and a persistent encryption key in Render:

```text
MIFILE_CREDENTIALS_KEY=<64 hexadecimal characters>
```

Generate the value once with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Store the generated value as a Render environment secret. Keep a secure backup separately from database backups. Do not regenerate it on each deployment: previously saved credentials require the same key to decrypt.

In **Settings > MiFILE account**, enter the login email, password, and account type. **Test sign-in** checks the entered account without saving it. **Verify and save** checks sign-in and then activates the account. A blank password preserves the current password only when the username is unchanged. Primary-account activation requires the checkbox in the form.

The complete account record is encrypted using AES-256-GCM before storage in SQLite. Passwords and ciphertext are not returned by the settings API. Account updates are blocked while MiFILE jobs are queued or running. New login sessions use the saved account without a service restart. A missing or incorrect encryption key blocks use of saved credentials instead of silently switching to a different environment account.

## Verification and rollout

```powershell
npm.cmd test
npm.cmd run test:admin-intake
```

The browser smoke test uses an isolated SQLite database and mocked OneDrive and MiFILE sign-in services. It checks account saving, credential redaction, cross-origin rejection, uploading a PDF to an initially empty Draft, PDF canvas rendering, and desktop/mobile layout. It also corrects missing fields, completes a six-document package, confirms it, queues one preparation job, and simulates a restart at Save Progress followed by reconciliation. The MiFILE uploader tests use a local browser fixture to check all six uploads, exact Filing Type selection, missing Connected controls, and refusal to save or submit on those failures. These tests do not create a real MiFILE bundle. Screenshots are written to `output/intake-qa`.

Before inviting live client packages, deploy the update, confirm the inbox and accepted senders in Settings, and run one controlled package through the real Microsoft 365 and OneDrive services. Select the exact court, resolve validation issues, and prepare that package in MiFILE. Confirm the resulting bundle in History > Unsubmitted. Local tests do not substitute for this live integration check.
# September 24: intake recovery and scanned documents

- Drafts defaults to new filing packages. Existing court notifications remain in Queue and in the optional All records view; they are not new cases.
- New case creates an editable manual package without sending an email. Add PDFs there; manual packages are never automatically queued while the user is still assembling them.
- Report emails, failure notifications and replies/forwards of our reports are correspondence, not attachment sources. Migration 23 stops their synthetic attachment retries without deleting audit history or OneDrive files.
- Scanned PDFs use offline English Tesseract OCR in a separate process, serialized with a 120-second deadline, at most 12 pages and 8 million render pixels per page. Models ship in the Docker image through npm; documents are not sent to an OCR service. Original bytes are retained.
- OCR can populate Complaint parties and addresses. Paragraph 2/10 answers and scan-derived party data require review; absence of an OCR checkbox is never interpreted as No. Poor scans remain editable and do not invalidate successful downloads.
- PDF.js WASM decoders, fonts and character maps are provided for both server extraction and browser preview, including JBIG2 scans.
- Settings supports bulk Advice/Local import using verified MiFILE court names. Existing form components are not silently replaced. Shared county forms can be assigned to each applicable MiFILE court, while court-specific supplemental Local files remain separate components.
- `MIFILE_AUTO_PREPARE_ENABLED=false` disables automatic preparation. Otherwise, completed email intakes with zero current validation issues and no previous filing job can queue **prepare only**. Failed/uncertain jobs are not automatically resubmitted. Court submission and payment remain disabled.
