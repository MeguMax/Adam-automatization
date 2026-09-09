# New-case email intake and MiFILE preparation

## Current workflow

One authorized email creates one new Draft and one OneDrive folder. The worker processes attached PDFs, extracts fields from the Complaint, and validates the package. The supported scope remains first-hearing nonpayment LT cases.

The Draft editor displays the PDF with page navigation and zoom beside the editable fields. On mobile, switch between Document and Fields. Missing data, unreadable files, ambiguous document roles, and incomplete packages require review.

After correction and approval, **Prepare in MiFILE** queues a Playwright job. Its only destination is **History > Unsubmitted**. Final submission and payment remain disabled. Both the alternate and primary accounts access live MiFILE; "alternate" does not mean sandbox. The only permitted filer is **Devlin, Adam**.

## Sending a package

Use the **Automation inbox** shown under **Settings > Email intake**. It is the existing Microsoft 365 mailbox configured by `USER_EMAIL`; no new mailbox is provisioned by this update.

Send a new email with a subject such as:

```text
NEW LT FILING - Example Property LLC v Morgan Tenant
```

Attach individual PDFs: Complaint, Advice, court-specific Local, Summons, Request, and applicable Demand/Notice/Lease/Deed or other supporting documents. Keep each PDF within 25 MB. Word files, ZIP archives, and cloud-link-only packages are not supported as intake documents. The original file names should identify the document roles. Unknown roles are left for review.

By default, accepted senders are `ajd@devlinlawpllc.com` and the `USER_EMAIL` address. Override the list with `FILING_INTAKE_ALLOWED_SENDERS`, a comma-separated list of exact email addresses. The sender list is visible in Settings.

Replies and forwards with `Re:` or `FW:` subjects do not create another intake. Existing MiFILE notifications retain their existing processing path, including when a notification body appears under an intake subject. Reprocessing the same recorded email resumes missing documents; sending the package as a completely new email creates a separate Draft.

## Storage and recovery

- PDFs are stored under `New filings/<stable package key>` in the configured OneDrive root. Stable file names prevent an uncertain upload retry from creating another copy at a new path.
- Each completed document is recorded immediately. A failed attachment does not stop later files in that package.
- The download and upload layer makes up to three immediate attempts for transient errors. Existing delayed document retries and manual retry controls remain available.
- Invalid or unreadable PDFs are recorded with a validation error. Correct them through the Draft document controls.
- Failures before the attachment list has been obtained get an email-level retry, with a delay starting at one minute and capped at thirty minutes. Record Detail shows the next Inbox retry time.
- Every completed retry reruns package validation. Download success alone does not make a case ready for preparation.
- The court must be explicitly selected if the Complaint has not provided a usable MiFILE court name. Court-specific Other/Connected relationships must be reviewed where no definitive mapping is available.
- Intake itself does not automatically queue a MiFILE job or send a correction email to the sender. Review and preparation are controlled from the Draft editor in this release.

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

The browser smoke test uses an isolated SQLite database and mocked OneDrive and MiFILE sign-in services. It checks account saving, credential redaction, cross-origin rejection, uploading a PDF to an initially empty Draft, PDF canvas rendering, and desktop/mobile layout. Screenshots are written to `output/intake-qa`.

Before inviting live client packages, deploy the update, confirm the inbox and accepted senders in Settings, and run one controlled package through the real Microsoft 365 and OneDrive services. Select the exact court, resolve validation issues, and prepare that package in MiFILE. Confirm the resulting bundle in History > Unsubmitted. Local tests do not substitute for this live integration check.
