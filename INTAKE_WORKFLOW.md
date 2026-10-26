# New-case email intake and MiFILE preparation

## Current workflow

One authorized email creates one new Draft and one OneDrive folder. The worker processes attached PDFs, extracts fields from the Complaint, and validates the package. Nonpayment, termination, and DC 102c recovery-of-possession Complaints use the same filing workflow; paragraph 10 determines possession-only versus possession and supplemental money judgment.

The Draft editor displays the PDF with page navigation and zoom beside the editable fields. On mobile, switch between Document and Fields. Missing data, unreadable files, ambiguous document roles, and incomplete packages require review.

Completed email packages with no validation issues and no previous filing job are queued automatically when the preparation worker is enabled and ready. No Sync, extraction, confirmation or preparation button is needed for this path. Manual packages and corrected packages use **Confirm & prepare** after resolving their review items. The only destination is **History > Unsubmitted**. Final submission and payment remain disabled. Both the alternate and primary accounts access live MiFILE; "alternate" does not mean sandbox. The only permitted filer is **Devlin, Adam**.

## Sending a package

Use the **Automation inbox** shown under **Settings > Email intake**. It is the existing Microsoft 365 mailbox configured by `USER_EMAIL`; no new mailbox is provisioned by this update.

Send a new email with a subject such as:

```text
NEW LT FILING - Example Property LLC v Morgan Tenant
```

Attach individual PDFs: Complaint, Summons, Request, and applicable Demand/Notice/Lease/Deed or other supporting documents. Include Advice and court-specific Local until the verified forms have been added to Settings > Form library. Keep each PDF within 25 MB. Word files, ZIP archives, and cloud-link-only packages are not supported as intake documents.

Document types are recognized from known titles in the PDF text layer or offline OCR when the text layer is insufficient. Filenames are a fallback, not the source of case facts. Filename-only recognition, low-confidence OCR, conflicting titles, combined packages, and unknown files require manual Filing Type confirmation. OCR can suggest Complaint parties and addresses, but scan-derived fields and paragraph 2/10 answers require review. Case facts continue to come from the Complaint.

Complaint extraction first reads populated DC 102a/DC 102c PDF form fields, including their actual checkbox values. Empty overlay fields do not override visible flattened text. If populated form fields are unavailable, the extractor reads the caption's text coordinates before using OCR. Drafts identify these sources as **PDF form fields**, **PDF text layout**, or **Scan OCR**. Clearly separated people and businesses become distinct parties sharing the caption address. Company-name suffixes remain together. Per Adam's instruction, names after "and all other occupants" and the separate Notice per MCL 600.3238(6) block are not parties. Unrecognized additional instructions still require review.

OCR renders up to approximately 300 DPI within the existing 8-million-pixel limit, normalizes contrast, corrects small skew, retries low-quality page segmentation, and re-reads identifiable party blocks separately. It runs offline and keeps the original PDF unchanged. Word confidence is checked within party regions, not just averaged across the page. Scan-derived values still require confirmation. Unread checkbox states remain unknown, and total claim amounts are not substituted with a monthly rent rate. Re-extraction clears unverified old automatic checkbox/amount answers while preserving explicit manual corrections.

Adam has confirmed his office contacts for missing Plaintiff contact fields: 30850 Telegraph Rd Ste 250, Bingham Farms, MI 48025; 248-703-6201; ajd@devlinlawpllc.com. Explicit Complaint addresses and manual corrections, including intentionally cleared fields, are preserved. The permitted filer uses the confirmed Adam J Devlin / P72877 office profile. Policy-derived fields are labelled **Attorney rule**, not PDF-extracted facts. Missing required documents and genuinely uncertain answers remain correction items. Existing editable intakes can be refreshed by the serialized extraction worker; locked/prepared cases and court notifications are not changed.

Live Draft refresh checks the selected record and edit revision again after each background response. Responses started before a field edit do not replace unsaved input, including while navigating between Drafts. When an unedited form refreshes, the active field, text selection and field-panel scroll position are preserved so a correction link does not lose keyboard focus during the next poll.

## Correcting and confirming a Draft

The review panel separates **required corrections** from **review notes**. Each arrow opens the affected field or document mapping; **First item** jumps to the first required correction. Missing Plaintiff and Defendant address components are reported individually. Correct the highlighted values and save to refresh validation. Notes from OCR or an unusual caption remain visible for the attorney's review rather than being silently dismissed.

Filing fields identify their saved source: PDF fields, PDF text, Scan OCR, Manual, or a default. Party and attorney provenance is tracked by field group. The document icon beside a Complaint-derived group opens the primary Complaint; it does not claim to locate the exact word or checkbox on a particular page. Empty values remain marked Missing.

**Confirm package** cannot waive required MiFILE answers: paragraph 2, paragraph 10, a positive supplemental claim amount, prior-action details when applicable, and an explicit Other/Connected choice must be completed. Choosing Review required for a document preserves that unknown state, including when its Filing Type is Other. Informational review notes can be acknowledged through normal package confirmation. Both automated and manual packages use **Prepare in MiFILE**, never a final-submit action.

The preparation button stays disabled after queueing, during preparation, while reconciliation is required, and after preparation. A repeated queue request returns a conflict without adding a second job. Core document constraints and the required mailing checkbox remain read-only; source PDFs remain viewable while the Draft is locked.

Selecting an unavailable document shows its download status, error, retry timing and recorded failure log directly above the PDF preview. The retry arrow queues the existing document retry without creating a second document. Unsaved Draft corrections are saved before queueing it. Internal email-attachment source identifiers are not presented as browser download links.

The MiFILE uploader sends one PDF at a time, verifies its source filename before renaming the filing, and requires an exact Filing Type for separate filings, allowing only MiFILE's displayed fee suffix (for example, ` - $45.00`). The primary Complaint is first, followed immediately by its Connected PDFs, then other separate filings. MiFILE renumbers its rows when a PDF is connected: each supporting PDF is connected immediately to the verified Complaint row rather than using old batch indexes. MiFILE itself assigns the child label CONNECTED FILING; an Other option is not required for a Connected child. Missing/disabled controls, ignored connections, unexpected merge behavior, upload warnings and source-row mismatches stop preparation for review. The full source-PDF count, names, types, upload states and connections are checked before Save Progress. Old queued payloads are checked again for unknown required answers and relationships before any external access. Temporary PDFs are removed even if OneDrive materialization fails partway through the package.

### Saved bundle verification

New preparation jobs require the signed-in account to match the configured MiFILE login and the filer to be exactly **Devlin, Adam (P72877)**. The live dropdown identifies this filer by separate Name, Role, State and Number fields; selection requires Devlin, Adam / Attorney / MI / P72877, one unambiguous matching option and the confirmed selected label. Additional organization text is not mistaken for part of the name. Before saving the case form, the worker reads back the claim amount, related-action choices and mailing request from MiFILE's controls. Preparation acknowledges only the known PII information notice and the observed TrueFiling court-news notice. Sign-in checks for a late-loading news overlay before a normal click; it does not force a click through it. Unknown notices, terms, payment authorizations and additional verification stop for manual review. It does not remove those dialogs or accept them silently. Settings account verification uses the same notice policy; the existing court-download login path is unchanged.

Each source PDF receives a SHA-256 digest and byte count when downloaded from OneDrive. These are bound to the immutable filing payload by a package digest. After Save Progress the worker reopens the exact saved bundle and checks the account, court, temporary case, filer, generated Case Initiation Form, every expected source row, upload state, Filing Type and Connected parent. Only then does the job become Prepared. A failed or interrupted readback requires reconciliation and preserves the known remote references; it never creates a replacement case automatically.

**Activity > Before court submission** distinguishes this automatic evidence from older or manually reconciled bundles. Displayed fees are captured from the saved upload page as integer USD cents. They are a pre-checkout subtotal, not a charge authorization or final amount: the Checkout total, processing fee and payment method are not inferred. Missing or ambiguous fee values and quantities stay unknown. No card numbers or security codes are collected by this application.

Failed jobs expose their existing diagnostic PNG through an authenticated, non-cached link in Activity. The endpoint accepts only a job ID, checks the canonical per-job diagnostics directory, PNG signature and size, and cannot read an arbitrary filesystem path. Login progress is recorded before authentication starts, so a slow sign-in is not shown as a OneDrive download.

An empty Angular notice container is given up to five seconds to load its text before classification. Each acknowledged notice is tracked by its actual element and the visible dialog set is read again afterwards, avoiding duplicate nested wrappers or a newly displayed notice being mistaken for the old one. Unknown or still-empty notices remain blocking; no authorization is inferred from an empty backdrop.

The stored source hashes identify the bytes used during preparation; they do not make OneDrive immutable or attest to a freshly downloaded MiFILE PDF. Before a future payment action, the system must re-check the source content, remote bundle and Checkout fees, then obtain a fresh per-package confirmation. Switching accounts invalidates the current-account check for previously prepared bundles. Old jobs are not retroactively marked verified or automatically re-created.

### Remaining court-submission gate

The current release still rejects `submit` jobs and contains no payment or final-submit action. Enabling that stage is a separate rollout, not an environment toggle. It requires the client's primary account, an owner-configured payment method in MiFILE, a current itemized Checkout quote, approval tied to the exact account/bundle/documents/amount, and a verified submission/payment receipt. An uncertain result must be reconciled from MiFILE history before any retry; submitted, clerk-accepted and rejected outcomes must remain distinct. Final financial and legal confirmation stays with the account owner during the initial rollout.

MiFILE's own workflow separates Save Progress from Checkout and final submission: [official filer guide, sections 9-12](https://info.courts.mi.gov/hubfs/01.MiFILE_FilerExperience_MiFile_6.17.2022.pdf). Fees are read from the live interface rather than hard-coded from this guide.

MiFILE can create an Unsubmitted bundle as soon as the case-initiation form is saved, before any source PDF is saved. A failure or restart during case-form completion, PDF upload, or Save Progress therefore requires reconciliation; it must not queue a fresh package blindly. Migration 26 also protects the latest historical failures at those earlier stages. Check the actual bundle contents, not just its existence, before marking it prepared. The reconciliation dialog lists the immutable expected PDF package and requires explicit confirmation of every listed PDF, Filing Type and connection. The server rejects missing, incomplete or duplicate verification IDs; finding a partial bundle alone cannot mark it Prepared. A partial bundle must be completed in MiFILE or removed by the account owner before a fresh preparation attempt.

Preparation progress shows its current stage, uploaded source-PDF count, active filename, and an expandable per-file checklist. An upload error identifies the exact PDF; unattempted PDFs remain Waiting and an interrupted upload remains Check MiFILE. Completed upload counts do not imply that Save Progress succeeded. Historical totals are labelled Reported rather than inventing per-file verification. Manual reconciliation is labelled PDFs checked by you; it is an attorney confirmation, not an automated remote inspection. The MiFILE case-initiation/system form is not counted as an additional source PDF.

### Removing and Replacing PDFs

The trash icon removes the selected PDF from the Draft only. Its OneDrive copy is retained. Original email documents are archived in SQLite rather than recreated on the next inbox sync, and removed documents cannot be retried. Required-package checks still apply: removing a required PDF leaves a correction item until a suitable document is added. Library forms retain their separate version controls.

**Replace PDF** also works for a failed document that has never reached OneDrive. Existing uploaded PDFs keep their filename and link while their contents are replaced. A first-time replacement upload uses the existing Draft document ID to keep its storage filename stable across retries. Failed uploads retain one repairable Draft record rather than requiring another Add PDFs action.

During replacement the document is reserved, preparation is blocked, and its original attachment retry is retired. An interrupted or failed replacement requires another local replacement; neither the delayed retry worker nor email reprocessing restores the old attachment over the correction. Replacing or removing the primary Complaint clears its automatic fields and extraction result. Explicit manual corrections are preserved. A replacement Complaint is read automatically; review the refreshed result. **Re-read Complaint** is available for troubleshooting.

Manual document additions, removals and replacements disable automatic preparation for that Draft. After correcting the package, use **Confirm package** and **Prepare in MiFILE**. Unchanged incoming packages can still use the existing automatic Unsubmitted preparation path. Queued, running, reconciliation-required, prepared and court-notification records cannot be modified through these document controls.

### Court Filing Rules

**Settings > Court filing rules** stores a versioned rule for an exact court: **Other - separate filing**, **Connected to Complaint**, or **Manual review**. Adam's confirmed default is Connected for 45, 17, 47, 41A-1, 18, 1, 32A, 71A, 54A, 66, 56A and 73A; all other exact MI District Courts use Other. 41A without a division remains unknown. A default is stored with its source/version when first applied. Existing saved rules, disabled rules, and manual document choices are never replaced by the default. These are Adam's workflow instructions, not independently inferred legal requirements. Notes are displayed with the document's rule-derived submission choice.

The worker applies a configured rule after intake and standard-form completion. Manual document choices are preserved. Each rule change creates a new version. Existing Draft documents keep their pinned version and require review if that version changes or is disabled. **Apply court rule** explicitly updates non-manual choices to the current rule. Changing the Draft's court clears an automatic choice from the previous court. An unresolved court or intentionally disabled rule leaves the relationship unknown; a recognized new court receives Adam's default. Queued job payloads remain immutable snapshots, and prepared bundles are not changed.

## Reusable forms

In **Settings > Form library**, upload the attorney-approved Advice PDF for all courts and a Local PDF for each exact MiFILE court name. Confirm the document type and court assignment before saving. No legal forms are preinstalled or downloaded from third parties.

The worker adds missing forms after intake. Saving a new-case Draft or extracting its Complaint also checks the library. **Add standard forms** performs the same check manually. Existing Advice/Local attachments are preserved, and repeated checks do not create duplicates. An exact court match is required. A district code can resolve to a court only when it uniquely matches a known full court name; ambiguous matches require manual selection.

Each form is copied into that case's OneDrive folder and pinned to its library version. Saving an updated form or disabling it affects future additions only. Existing Drafts and pending retries keep their original version. To replace a pinned form, remove it from the Draft and add the correct one. Changing a Draft's court blocks preparation if its Local form belongs to the previous court. A court may have multiple approved Local components. The 21st District Court receives both its Local information and Zoom instructions as separate Local filings. The complete three-page 73A packet is retained and filed as one Local document, in addition to the universal Advice.

Upload failures use the normal per-document automatic and manual retries. Inactive form versions remain available for already-reserved documents. Library PDFs are stored next to SQLite in `filing-forms/`, outside the database. On Render this is `/var/data/filing-forms/`. Back up both the database and this directory. Disabled versions are retained; they are not automatically deleted by email cleanup.

By default, accepted senders are `ajd@devlinlawpllc.com` and the `USER_EMAIL` address. Override the list with `FILING_INTAKE_ALLOWED_SENDERS`, a comma-separated list of exact email addresses. The sender list is visible in Settings.

Replies and forwards with `Re:` or `FW:` subjects do not create another intake. Original court notifications are processed only from exact `@truefiling.com` addresses. Client replies quoting a court notification are ignored, including delayed retries previously queued from those replies. `Document Sent` reads the case number and title from the actual email Subject header. Reprocessing the same recorded email resumes missing documents; sending the package as a completely new email creates a separate Draft.

Court notifications are download history and cannot create a new case package, including through the former manual-copy API. Notification reports do not announce filing readiness. To prepare a new case, the user must send an authorized intake or create a new manual Draft with original case documents.

Adam supplies Complaint, Summons, Request and at least one supporting document. The library adds Advice and the selected court's Local form, giving a minimum standard package of six documents. Missing library forms require correction. Automatic Other/Connected selection uses Adam's confirmed court policy unless an explicit court/document override takes precedence.

## Storage and recovery

- PDFs are stored under `New filings/<stable package key>` in the configured OneDrive root. Stable file names prevent an uncertain upload retry from creating another copy at a new path.
- Each completed document is recorded immediately. A failed attachment does not stop later files in that package.
- The download and upload layer makes up to three immediate attempts for transient errors. Existing delayed document retries and manual retry controls remain available.
- Invalid or unreadable PDFs are recorded with a validation error. Correct them through the Draft document controls.
- Failures before the attachment list has been obtained get an email-level retry, with a delay starting at one minute and capped at thirty minutes. Record Detail shows the next Inbox retry time.
- Every completed retry reruns package validation. Download success alone does not make a case ready for preparation.
- The court must be explicitly selected if the Complaint has not provided a usable MiFILE court name. Court-specific Other/Connected relationships must be reviewed where no definitive mapping is available.
- Completed email intakes with zero current validation issues and no previous filing job can automatically queue preparation when the filing worker is enabled and ready. Set `MIFILE_AUTO_PREPARE_ENABLED=false` to disable this. Manual packages are excluded. Failed or uncertain filing jobs require review instead of automatic resubmission. The system does not automatically email a correction request to the sender.

## Guided Draft review

Complaint extraction is automatic after upload, replacement, successful email intake, and a primary-source change. Opening an old editable Draft also checks whether extraction needs updating. A separate serialized production worker repairs missing/outdated results without opening the admin page. It does not create new packages from court notifications, modify prepared/queued cases, or choose between multiple Complaints without a selected primary source. Reading failures retain the uploaded PDF and retry after 5 and 10 minutes (three automatic attempts per source/version). An interrupted read is recovered after restart. **Re-read Complaint** remains available in the document menu for troubleshooting, but is not part of the normal workflow.

Version 5 reads AcroForm values first and supports mixed business/person Defendant lists. Flattened pages and scans use positioned text/OCR plus bounded image-based checkbox verification; a square must actually be found before its empty interior can mean unchecked. A selected paragraph 10 Damages claimed amount is read from its own labelled row. Selected rent owing can reference an explicit paragraph 5(d) total only when the separate damages choice is not selected. Monthly rent is never substituted for a total. Column-crossing caption labels and wrapped names are handled separately. A low-confidence ordinal in the court header can be suggested but remains covered by scan review. Unmarked related-action answers and ambiguous amounts remain review items, not fabricated values.

Manual corrections are stored as field paths, including intentional blanks. Changing a phone no longer freezes an entire party: subsequent reading can update the automatic fields while keeping that phone. Party-list additions/removals remain protected as a whole. Older group-level overrides keep their conservative protection. Automatic court/title values are tracked separately from manual identifiers. Saving unchanged document controls preserves automatic Filing Type/court-rule ownership. Background updates and responses in flight cannot replace unsaved browser edits. Automatic MiFILE preparation waits for the current extractor version and is blocked while reading is running.

The Draft workspace opens on **Review**: court, parties, claim and included documents, with required corrections linked to their exact input. The Complaint PDF remains alongside the review. **Case data**, **Documents**, and **Activity** keep editing, Filing Types, inclusion, primary source selection, notes and diagnostics available without displaying every control at once. Optional party details, assigned case numbers, advanced MiFILE settings and technical logs expand on demand. Document tools (extract, replace, remove, standard forms and court rules) are in the menu beside **Add PDFs**. Secondary case actions, including confirm without preparation and reject, are in the header menu.

**Confirm & prepare** replaces the former two-step confirmation and preparation path. The confirmation dialog identifies the case, PDF count, account and Unsubmitted-only limit. Cancel has no side effects. Approval and the immutable preparation snapshot are committed in one database transaction. Changed server versions are rejected for fresh review; required validation errors, existing jobs, reconciliation and court-notification restrictions cannot be bypassed. No payment or final submission is enabled.

The primary action changes with the case: **Save & check**, **Review corrections**, **Confirm & prepare**, **View progress**, **Check result**, or **Open MiFILE**. Saving locks mutating controls until completion. Tab/disclosure selection, unsaved inputs and PDF navigation survive ordinary refreshes. Known-good new email intakes retain their existing automatic Unsubmitted preparation; incomplete packages still require correction, and uncertain remote results still require checking MiFILE before retrying.

## Account settings

The existing environment credentials remain active until an account is saved through Settings. Admin authentication is required. In production, no extra Render secret is needed for a fresh installation: the server creates one random 256-bit key at `/var/data/.secrets/mifile-credentials.key` and reuses it after restarts. The key file is separate from SQLite, private to the server user on Linux, and excluded from Git and Docker builds. Back it up securely; restoring the database alone cannot decrypt a saved account.

An explicit environment key takes precedence. This is also the configuration for standalone `npm run admin`:

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

### October 26 live automatic acceptance check

- A clearly marked fictional email was delivered once to the configured Microsoft 365 inbox. Without pressing Sync, extraction, confirmation or preparation controls, Render processed its five attached PDFs, extracted Complaint fields, added the approved Advice/Local, and saved `TEMP-H5WNXK2C` in MiFILE Unsubmitted. Preparation itself took 26 seconds; email arrival to saved bundle took approximately 57 seconds.
- The bundle was reopened independently from History > Unsubmitted. All seven source PDFs and MiFILE's generated Case Initiation Form were present with successful upload states. Both supporting PDFs were Connected children of the Complaint, not merged documents. MiFILE's history count excludes Connected children; that count alone is not the source-PDF total.
- A second email deliberately omitted Request. All six available PDFs were retained, Review identified the missing Request, and no MiFILE job was created. It did not block the complete package. Both email tokens were found once in Inbox; the complete Draft had one preparation attempt.
- Evidence is retained under `output/qa-email-complete-2026-10-26/` and `output/qa-email-incomplete-2026-10-26/` in the local QA workspace. The test used the alternate live account and made no payment or final court submission. It does not certify every unseen document format or the client's primary login.

# September 24: intake recovery and scanned documents

- Drafts defaults to new filing packages. Existing court notifications remain in Queue and in the optional All records view; they are not new cases.
- New case creates an editable manual package without sending an email. Add PDFs there; manual packages are never automatically queued while the user is still assembling them.
- Report emails, failure notifications and replies/forwards of our reports are correspondence, not attachment sources. Migration 23 stops their synthetic attachment retries without deleting audit history or OneDrive files.
- Scanned PDFs use offline English Tesseract OCR in a separate process, serialized with a 120-second deadline, at most 12 pages and 8 million render pixels per page. Models ship in the Docker image through npm; documents are not sent to an OCR service. Original bytes are retained.
- OCR can populate Complaint parties and addresses. Paragraph 2/10 answers and scan-derived party data require review; absence of an OCR checkbox is never interpreted as No. Poor scans remain editable and do not invalidate successful downloads.
- PDF.js WASM decoders, fonts and character maps are provided for both server extraction and browser preview, including JBIG2 scans.
- Settings supports bulk Advice/Local import using verified MiFILE court names. Existing form components are not silently replaced. Shared county forms can be assigned to each applicable MiFILE court, while court-specific supplemental Local files remain separate components.
- `MIFILE_AUTO_PREPARE_ENABLED=false` disables automatic preparation. Otherwise, completed email intakes with zero current validation issues and no previous filing job can queue **prepare only**. Failed/uncertain jobs are not automatically resubmitted. Court submission and payment remain disabled.
