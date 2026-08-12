import http from 'http';
import fs from 'fs';
import { URL } from 'url';
import { timingSafeEqual } from 'crypto';
import {
    CaseDraftStatus,
    EmailProcessingStatus,
    getWorkflowDatabase,
    ProcessingReportInput,
    ReviewAction,
    ValidationStatus,
} from './database';
import {
    fetchCourtEmailById,
    fetchRecentCourtEmailHeaders,
    parseEmailBody,
} from './emailProcessor';
import { addEmailAttachmentSources } from './emailAttachmentSource';
import { loadLegacyProcessed } from './legacyState';
import {
    downloadDriveItemBuffer,
    renameDriveItem,
    resolveSharedDriveItem,
} from './oneDriveClient';

const DEFAULT_PORT = Number(process.env.PORT || process.env.ADMIN_PORT || 3000);
const ADMIN_BUILD_ID = '2026-08-12-court-email-backlog-v12';
const SYNC_EMAIL_LIMIT = Number(process.env.ADMIN_SYNC_EMAIL_LIMIT || 100);
const AUTO_SYNC_INTERVAL_MS = Number(process.env.ADMIN_AUTO_SYNC_MS || 30_000);
const ADMIN_SYNC_ENABLED = !['0', 'false', 'no', 'off'].includes(
    (process.env.ADMIN_SYNC_ENABLED ?? 'true').trim().toLowerCase(),
);
const LUCIDE_BROWSER_SCRIPT = fs.readFileSync(
    require.resolve('lucide/dist/umd/lucide.min.js'),
);

interface SyncStatus {
    running: boolean;
    lastStartedAt: string | null;
    lastFinishedAt: string | null;
    lastError: string | null;
    lastSyncedEmails: number;
    lastMiFileDrafts: number;
}

const syncStatus: SyncStatus = {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: null,
    lastSyncedEmails: 0,
    lastMiFileDrafts: 0,
};

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
    });
    res.end(html);
}

function sendJavascript(res: http.ServerResponse, script: Buffer): void {
    res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': script.length,
        'Cache-Control': 'public, max-age=604800, immutable',
    });
    res.end(script);
}

function constantTimeEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hasAdminCredentials(): boolean {
    return !!process.env.ADMIN_USERNAME && !!process.env.ADMIN_PASSWORD;
}

function isAdminRequestAuthorized(req: http.IncomingMessage): boolean {
    if (!hasAdminCredentials()) {
        return process.env.NODE_ENV !== 'production';
    }

    const header = req.headers.authorization;
    if (!header?.startsWith('Basic ')) return false;

    try {
        const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator < 0) return false;

        return (
            constantTimeEquals(decoded.slice(0, separator), process.env.ADMIN_USERNAME!) &&
            constantTimeEquals(decoded.slice(separator + 1), process.env.ADMIN_PASSWORD!)
        );
    } catch {
        return false;
    }
}

function sendUnauthorized(res: http.ServerResponse): void {
    const body = 'Authentication required';
    res.writeHead(401, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'WWW-Authenticate': 'Basic realm="Legal Workflow Admin", charset="UTF-8"',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function parseDateBoundary(value: string | null | undefined, endExclusive = false): string | null {
    if (!value) return null;
    const normalized = value.trim();
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(normalized);
    const date = isDateOnly
        ? new Date(`${normalized}T00:00:00.000Z`)
        : new Date(normalized);
    if (Number.isNaN(date.getTime())) return null;
    if (endExclusive && isDateOnly) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
}

function parseEmailIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
        value
            .filter((id): id is string => typeof id === 'string')
            .map(id => id.trim())
            .filter(Boolean),
    )).slice(0, 200);
}

function bodyToText(msg: any): string {
    const content = String((msg as any).body?.content ?? '');
    return content
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function firstMatch(text: string, pattern: RegExp): string | null {
    const match = text.match(pattern);
    return match?.[1]?.trim() || null;
}

function parseProcessingReport(msg: any): ProcessingReportInput | null {
    const subject = String(msg.subject ?? '');
    if (!subject.startsWith('MiFILE/TrueFiling processed:')) return null;

    const text = bodyToText(msg);
    const documents: ProcessingReportInput['documents'] = [];
    const documentPattern = /^-\s*(.+?)\s*\n\s*OneDrive:\s*(https?:\/\/\S+)/gm;

    for (;;) {
        const match = documentPattern.exec(text);
        if (!match) break;
        documents.push({
            fileName: match[1].trim(),
            oneDriveUrl: match[2].trim(),
        });
    }

    return {
        originalSubject: firstMatch(text, /^Subject:\s*(.+)$/m),
        originalSender: firstMatch(text, /^From:\s*(.+)$/m),
        originalReceivedAt: firstMatch(text, /^Received:\s*(.+)$/m),
        caseNumber: firstMatch(text, /^Case:\s*(.+)$/m),
        caseTitle: firstMatch(text, /^Title:\s*(.+)$/m),
        documents,
        reportMessageId: String(msg.id ?? ''),
    };
}

function storagePathWithFileName(storagePath: string | null, fileName: string): string | null {
    if (!storagePath) return null;
    const slashIndex = storagePath.lastIndexOf('/');
    return slashIndex >= 0 ? `${storagePath.slice(0, slashIndex + 1)}${fileName}` : fileName;
}

async function applyPlaintiffMappingToExistingFiles(mappingId: string): Promise<{
    fullName: string;
    shortName: string;
    renamed: number;
    alreadyApplied: number;
    failed: Array<{ documentId: string; error: string }>;
}> {
    const db = getWorkflowDatabase();
    const plan = db.getPlaintiffFilenameRenamePlan(mappingId);
    const failed: Array<{ documentId: string; error: string }> = [];
    let renamed = 0;
    let alreadyApplied = 0;

    for (const target of plan.targets) {
        try {
            const sharedItem = await resolveSharedDriveItem(target.oneDriveUrl);
            if (sharedItem.fileName === target.nextFilename) {
                db.recordPlaintiffFilenameRenameSuccess({
                    documentId: target.documentId,
                    currentFilename: sharedItem.fileName,
                    storagePath: storagePathWithFileName(target.storagePath, sharedItem.fileName),
                    driveId: sharedItem.driveId,
                    itemId: sharedItem.itemId,
                });
                alreadyApplied += 1;
                continue;
            }
            if (sharedItem.fileName !== target.currentFilename) {
                throw new Error(
                    `OneDrive file name differs from the recorded name (${sharedItem.fileName})`,
                );
            }

            const renamedItem = await renameDriveItem(
                sharedItem.driveId,
                sharedItem.itemId,
                target.nextFilename,
            );
            db.recordPlaintiffFilenameRenameSuccess({
                documentId: target.documentId,
                currentFilename: renamedItem.fileName,
                storagePath: storagePathWithFileName(target.storagePath, renamedItem.fileName),
                driveId: renamedItem.driveId,
                itemId: renamedItem.itemId,
            });
            renamed += 1;
        } catch (error) {
            db.recordPlaintiffFilenameRenameFailure(target.documentId, error);
            failed.push({
                documentId: target.documentId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return {
        fullName: plan.fullName,
        shortName: plan.shortName,
        renamed,
        alreadyApplied,
        failed,
    };
}

async function syncRecentInboxMetadata(limit = SYNC_EMAIL_LIMIT): Promise<{
    syncedEmails: number;
    miFileDrafts: number;
}> {
    if (syncStatus.running) {
        return {
            syncedEmails: syncStatus.lastSyncedEmails,
            miFileDrafts: syncStatus.lastMiFileDrafts,
        };
    }

    syncStatus.running = true;
    syncStatus.lastStartedAt = new Date().toISOString();
    syncStatus.lastError = null;

    const db = getWorkflowDatabase();
    try {
        const emailHeaders = await fetchRecentCourtEmailHeaders(limit);
        emailHeaders.sort(
            (a: any, b: any) =>
                new Date(a.receivedDateTime).getTime() -
                new Date(b.receivedDateTime).getTime(),
        );

        let syncedEmails = 0;
        let miFileDrafts = 0;
        const checkedPlaintiffMappingIds = new Set<string>();

        for (const header of emailHeaders) {
            const externalMessageId = String(header.id);
            if (db.isEmailDeleted(externalMessageId)) continue;
            const emailRecord = db.registerEmail(header);
            syncedEmails += 1;
            if (emailRecord.processingStatus !== 'new') continue;

            let msg: any;
            try {
                msg = await fetchCourtEmailById(externalMessageId);
                db.registerEmail(msg);
            } catch (error) {
                console.error(
                    `Admin sync could not fetch Inbox message ${externalMessageId}; ` +
                    'leaving it in new status for the next pass:',
                    error,
                );
                continue;
            }

            if (isSelfProcessingReport(msg)) {
                const report = parseProcessingReport(msg);
                const applyResult = report ? db.applyProcessingReport(report) : null;
                if (
                    applyResult?.plaintiffMappingId &&
                    !checkedPlaintiffMappingIds.has(applyResult.plaintiffMappingId)
                ) {
                    checkedPlaintiffMappingIds.add(applyResult.plaintiffMappingId);
                    const fileSync = await applyPlaintiffMappingToExistingFiles(
                        applyResult.plaintiffMappingId,
                    );
                    if (fileSync.renamed || fileSync.alreadyApplied || fileSync.failed.length) {
                        console.log('Processing report Plaintiff filename sync:', {
                            reportMessageId: report?.reportMessageId,
                            targetEmailId: applyResult.targetEmailId,
                            fullName: fileSync.fullName,
                            shortName: fileSync.shortName,
                            renamed: fileSync.renamed,
                            alreadyApplied: fileSync.alreadyApplied,
                            failed: fileSync.failed.length,
                        });
                    }
                }
                db.markEmailIgnored(
                    emailRecord.id,
                    applyResult?.applied
                        ? 'Self processing report applied to original email'
                        : 'Self processing report',
                );
                continue;
            }

            const parsed = addEmailAttachmentSources(
                parseEmailBody((msg as any).body?.content ?? ''),
            );
            if (parsed.isMiFile) {
                db.createCaseDraft(emailRecord.id, parsed);
                miFileDrafts += 1;
            } else {
                db.markEmailIgnored(emailRecord.id, 'Not a MiFILE/TrueFiling email');
            }
        }

        syncStatus.lastSyncedEmails = syncedEmails;
        syncStatus.lastMiFileDrafts = miFileDrafts;
        return { syncedEmails, miFileDrafts };
    } catch (error) {
        syncStatus.lastError = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        syncStatus.running = false;
        syncStatus.lastFinishedAt = new Date().toISOString();
    }
}

function isSelfProcessingReport(msg: any): boolean {
    const fromAddr = msg.from?.emailAddress?.address?.toLowerCase() ?? '';
    const subject = (msg.subject ?? '') as string;
    const notifyTo = process.env.NOTIFY_TO_EMAIL?.toLowerCase();

    return !!notifyTo &&
        fromAddr === notifyTo &&
        subject.startsWith('MiFILE/TrueFiling processed:');
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Legal Workflow Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d8dde6;
      --text: #1d2633;
      --muted: #687386;
      --accent: #1b6ca8;
      --accent-strong: #124f7d;
      --bad: #b42318;
      --warn: #b76e00;
      --ok: #117044;
      --shadow: 0 1px 2px rgba(16, 24, 40, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      display: grid;
      grid-template-columns: minmax(500px, 1.3fr) minmax(360px, 0.7fr);
      gap: 16px;
      padding: 16px;
    }
    section {
      min-width: 0;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      box-shadow: var(--shadow);
    }
    .metric {
      padding: 12px;
      min-height: 72px;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .metric strong {
      font-size: 24px;
      line-height: 1;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px;
      border-bottom: 1px solid var(--line);
    }
    .toolbar h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
    }
    .controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .nav-tabs {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .nav-tabs button.active {
      border-color: var(--accent);
      color: var(--accent-strong);
      background: #e8f2fa;
      font-weight: 650;
    }
    .hidden {
      display: none !important;
    }
    .full-span {
      grid-column: 1 / -1;
    }
    .form-grid {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) minmax(180px, 0.45fr) auto auto;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--line);
      align-items: center;
    }
    .form-grid input {
      width: 100%;
    }
    .table-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .split-panels {
      display: grid;
      grid-template-columns: minmax(360px, 1fr) minmax(320px, 0.7fr);
      gap: 16px;
    }
    .livebar {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
      min-height: 22px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--ok);
      display: inline-block;
    }
    .dot.syncing {
      background: var(--warn);
    }
    .dot.error {
      background: var(--bad);
    }
    input, select, button {
      height: 32px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: #fff;
      color: var(--text);
      font: inherit;
    }
    input {
      width: 220px;
      padding: 0 9px;
    }
    textarea {
      width: 100%;
      min-height: 74px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 8px 9px;
      color: var(--text);
      font: inherit;
      line-height: 1.4;
    }
    select {
      padding: 0 8px;
    }
    button {
      padding: 0 10px;
      cursor: pointer;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button.primary:hover {
      background: var(--accent-strong);
    }
    button.danger {
      border-color: #f2b8b5;
      color: var(--bad);
      background: #fff;
    }
    button.danger:hover {
      background: #fdecec;
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      background: var(--panel);
    }
    th, td {
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      background: #fafbfc;
    }
    tr {
      cursor: pointer;
    }
    tr:hover td {
      background: #f1f6fb;
    }
    tr.selected td {
      background: #e8f2fa;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 650;
      background: #eef1f5;
      color: #384456;
      max-width: 100%;
    }
    .status.processed, .status.ready_to_file, .status.passed, .status.uploaded, .status.active, .status.mapped, .status.applied {
      background: #e6f4ee;
      color: var(--ok);
    }
    .status.pending, .status.retry_queued, .status.retrying, .status.parsed, .status.new, .status.processing {
      background: #e8f2fa;
      color: var(--accent-strong);
    }
    .status.failed, .status.validation_failed {
      background: #fdecec;
      color: var(--bad);
    }
    .status.partial_failure, .status.needs_review, .status.missing, .status.needs_short_name, .status.needs_application {
      background: #fff4dd;
      color: var(--warn);
    }
    .status.not_downloadable, .status.invalid, .status.inactive {
      background: #f1f3f6;
      color: var(--muted);
    }
    .detail {
      position: sticky;
      top: 76px;
      max-height: calc(100vh - 92px);
      overflow: auto;
    }
    .detail-body {
      padding: 12px;
    }
    .kv {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr);
      gap: 7px 12px;
      margin-bottom: 12px;
    }
    .kv b {
      color: var(--muted);
      font-weight: 600;
    }
    .doc, .audit {
      border-top: 1px solid var(--line);
      padding: 10px 0;
    }
    .doc:first-child, .audit:first-child {
      border-top: 0;
    }
    .doc-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
    }
    .doc-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }
    .icon-button {
      width: 30px;
      padding: 0;
      font-size: 18px;
      line-height: 1;
    }
    pre {
      margin: 8px 0 0;
      padding: 10px;
      background: #f1f3f6;
      border: 1px solid var(--line);
      border-radius: 5px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
    }
    .muted {
      color: var(--muted);
    }
    .error-text {
      color: var(--bad);
      overflow-wrap: anywhere;
    }
    .review-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .queue-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 10px;
      border-top: 1px solid var(--line);
      background: #fafbfc;
    }
    .pagination {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .pagination button {
      min-width: 32px;
      padding: 0 7px;
    }
    .pagination button.active {
      border-color: var(--accent);
      background: #e8f2fa;
      color: var(--accent-strong);
      font-weight: 650;
    }
    .failure-log summary {
      margin-top: 6px;
      color: var(--bad);
      cursor: pointer;
      font-weight: 600;
    }
    .date-input {
      width: 142px;
    }
    .empty {
      padding: 24px;
      color: var(--muted);
      text-align: center;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    @media (max-width: 980px) {
      main {
        grid-template-columns: 1fr;
      }
      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .detail {
        position: static;
        max-height: none;
      }
      .split-panels, .form-grid {
        grid-template-columns: 1fr;
      }
      .queue-footer {
        align-items: stretch;
        flex-direction: column;
      }
      .pagination {
        justify-content: flex-start;
      }
    }
    @media (max-width: 620px) {
      header, .toolbar {
        align-items: stretch;
        flex-direction: column;
      }
      .controls {
        flex-wrap: wrap;
      }
      input, select {
        width: 100%;
      }
      .summary {
        grid-template-columns: 1fr;
      }
      th:nth-child(3), td:nth-child(3),
      th:nth-child(5), td:nth-child(5) {
        display: none;
      }
    }

    /* Admin UI v2 */
    :root {
      --bg: #f4f6f8;
      --panel: #ffffff;
      --subtle: #f8f9fb;
      --line: #dde2e7;
      --line-strong: #c8d0d8;
      --text: #18212b;
      --muted: #66717f;
      --accent: #1769a6;
      --accent-strong: #10517f;
      --accent-soft: #eaf3f9;
      --bad: #b42318;
      --bad-soft: #fff0ef;
      --warn: #9a5b00;
      --warn-soft: #fff5df;
      --ok: #18724a;
      --ok-soft: #e9f5ef;
      --shadow: 0 1px 2px rgba(24, 33, 43, 0.05), 0 4px 12px rgba(24, 33, 43, 0.035);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      min-height: 100vh;
      background: var(--bg);
      font-size: 13px;
      line-height: 1.45;
    }
    header {
      min-height: 64px;
      padding: 10px 20px;
      box-shadow: 0 1px 0 rgba(24, 33, 43, 0.04);
      z-index: 10;
    }
    .brand-lockup {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .brand-icon {
      width: 34px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      border-radius: 7px;
      color: #fff;
      background: #202832;
    }
    .brand-icon svg {
      width: 18px;
      height: 18px;
    }
    .brand-copy {
      min-width: 0;
    }
    .brand-copy h1 {
      font-size: 15px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .brand-copy span {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .nav-tabs {
      gap: 2px;
      padding: 3px;
      border-radius: 7px;
      background: #f0f2f4;
    }
    .nav-tabs button {
      height: 30px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      border: 0;
      background: transparent;
      color: var(--muted);
    }
    .nav-tabs button svg {
      width: 15px;
      height: 15px;
    }
    .nav-tabs button.active {
      border-color: transparent;
      color: var(--text);
      background: #fff;
      box-shadow: 0 1px 3px rgba(24, 33, 43, 0.12);
    }
    .header-actions {
      justify-content: flex-end;
    }
    .livebar {
      min-height: 34px;
      max-width: 280px;
      padding: 0 10px;
      gap: 7px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--subtle);
    }
    .livebar span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dot {
      width: 7px;
      height: 7px;
      box-shadow: 0 0 0 3px var(--ok-soft);
    }
    main {
      grid-template-columns: minmax(620px, 1fr) minmax(390px, 430px);
      gap: 18px;
      padding: 18px 20px 28px;
    }
    .summary {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .metric, .panel {
      border-color: var(--line);
      border-radius: 7px;
      box-shadow: var(--shadow);
    }
    .metric {
      min-height: 74px;
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr);
      align-items: stretch;
      gap: 0;
      padding: 0;
      overflow: hidden;
    }
    .metric > .metric-icon {
      width: 100%;
      height: 100%;
      min-height: 74px;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      margin: 0;
      border-radius: 0;
      color: var(--accent);
      background: var(--accent-soft);
    }
    .metric > .metric-icon svg {
      width: 19px;
      height: 19px;
    }
    .metric.tone-danger .metric-icon {
      color: var(--bad);
      background: var(--bad-soft);
    }
    .metric.tone-warning .metric-icon {
      color: var(--warn);
      background: var(--warn-soft);
    }
    .metric.tone-success .metric-icon {
      color: var(--ok);
      background: var(--ok-soft);
    }
    .metric-copy {
      min-width: 0;
      align-self: center;
      padding: 10px 12px;
    }
    .metric .metric-copy > span {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .metric strong {
      display: block;
      font-size: 21px;
      line-height: 1;
      letter-spacing: 0;
    }
    .toolbar {
      min-height: 54px;
      padding: 10px 13px;
    }
    .toolbar h2 {
      font-size: 14px;
    }
    .section-heading {
      min-width: 0;
    }
    .section-heading h2 {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
    }
    .section-heading h2 svg {
      width: 16px;
      height: 16px;
      color: var(--muted);
    }
    .section-heading span {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
    }
    input, select, button {
      height: 34px;
      border-color: var(--line-strong);
      border-radius: 6px;
    }
    input, select, textarea {
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    input:hover, select:hover, textarea:hover {
      border-color: #adb7c1;
    }
    input:focus, select:focus, textarea:focus {
      outline: 0;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(23, 105, 166, 0.12);
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      font-weight: 600;
      transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
    }
    button svg {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
    }
    button:hover:not(:disabled) {
      border-color: #aeb8c2;
      background: #f7f8fa;
    }
    button.primary:hover:not(:disabled) {
      border-color: var(--accent-strong);
      background: var(--accent-strong);
    }
    button.danger:hover:not(:disabled) {
      border-color: #e8a8a3;
      background: var(--bad-soft);
    }
    button.ghost {
      border-color: transparent;
      background: transparent;
      color: var(--muted);
    }
    button.ghost:hover:not(:disabled) {
      border-color: transparent;
      color: var(--text);
      background: #eef1f4;
    }
    button.icon-button {
      width: 34px;
      min-width: 34px;
      padding: 0;
      font-size: inherit;
    }
    button.loading svg {
      animation: spin 900ms linear infinite;
    }
    button:focus-visible, a:focus-visible, summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .filter-bar {
      display: grid;
      grid-template-columns: minmax(220px, 1.4fr) minmax(118px, 0.65fr) minmax(150px, 0.8fr) minmax(110px, 0.6fr);
      gap: 8px;
      padding: 11px 13px;
      border-bottom: 1px solid var(--line);
      background: var(--subtle);
    }
    .filter-bar .date-field {
      width: min(100%, 410px);
      grid-column: 1 / -1;
    }
    .field {
      min-width: 0;
    }
    .field-label {
      display: block;
      margin: 0 0 5px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      text-transform: uppercase;
    }
    .field input, .field select {
      width: 100%;
    }
    .search-field {
      position: relative;
    }
    .search-field svg {
      position: absolute;
      left: 10px;
      bottom: 9px;
      width: 15px;
      height: 15px;
      color: #7a8795;
      pointer-events: none;
    }
    .search-field input {
      padding-left: 32px;
    }
    .date-range {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .date-boundary {
      min-width: 0;
    }
    .date-boundary > span {
      display: block;
      margin: 0 0 4px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 650;
    }
    .date-input {
      width: 100%;
    }
    #queue {
      min-height: 240px;
      overflow-x: auto;
    }
    .select-column {
      width: 38px;
      padding-right: 4px;
      text-align: center;
    }
    .queue-checkbox {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    #queue tr.bulk-selected td {
      background: #f2f8fc;
    }
    .selection-bar {
      display: flex;
      min-height: 46px;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 13px;
      border-bottom: 1px solid #c9dce9;
      color: var(--accent-strong);
      background: var(--accent-soft);
    }
    .selection-bar .controls {
      flex-wrap: wrap;
    }
    .selection-count {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      font-weight: 650;
    }
    .selection-count svg {
      width: 16px;
      height: 16px;
    }
    table {
      font-size: 12px;
    }
    th, td {
      padding: 10px 11px;
    }
    th {
      height: 36px;
      color: #66717f;
      font-size: 10px;
      font-weight: 750;
      line-height: 1.2;
      text-transform: uppercase;
      background: #fff;
    }
    tbody tr {
      border-left: 3px solid transparent;
    }
    tbody tr:hover td {
      background: #f7fafc;
    }
    tbody tr.selected {
      border-left-color: var(--accent);
    }
    tbody tr.selected td {
      background: #edf5fa;
    }
    .subject-main, .plaintiff-main {
      display: block;
      color: var(--text);
      font-weight: 700;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .cell-secondary {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .status {
      min-height: 21px;
      gap: 5px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      line-height: 1.2;
      text-transform: none;
    }
    .status::before {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      content: "";
      opacity: 0.75;
    }
    .status-line {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .document-progress {
      min-width: 76px;
    }
    .document-progress-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
    }
    .document-progress-head strong {
      color: var(--text);
      font-size: 12px;
    }
    .progress-track {
      height: 4px;
      margin-top: 6px;
      overflow: hidden;
      border-radius: 4px;
      background: #e7ebef;
    }
    .progress-fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--ok);
    }
    .progress-fill.has-failure {
      background: var(--bad);
    }
    .progress-fill.in-progress {
      background: var(--accent);
    }
    .document-flags {
      margin-top: 5px;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.25;
    }
    .queue-footer {
      min-height: 52px;
      padding: 9px 13px;
      background: #fff;
    }
    .retention-control {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .retention-control .date-input {
      width: 138px;
    }
    .pagination button {
      height: 30px;
      min-width: 30px;
      border-color: transparent;
      background: transparent;
      font-size: 11px;
    }
    .pagination button.active {
      border-color: var(--line-strong);
      color: var(--text);
      background: #fff;
      box-shadow: 0 1px 2px rgba(24, 33, 43, 0.08);
    }
    .detail {
      top: 82px;
      max-height: calc(100vh - 100px);
    }
    .detail .toolbar {
      position: sticky;
      top: 0;
      z-index: 3;
      background: rgba(255, 255, 255, 0.97);
    }
    .detail-body {
      padding: 0;
    }
    .detail-empty {
      min-height: 360px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 28px;
      color: var(--muted);
      text-align: center;
    }
    .detail-empty-icon {
      width: 42px;
      height: 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      color: #7b8793;
      background: #eef1f4;
    }
    .detail-empty-icon svg {
      width: 20px;
      height: 20px;
    }
    .detail-hero {
      padding: 15px 15px 13px;
      border-bottom: 1px solid var(--line);
    }
    .detail-subject {
      margin: 9px 0 4px;
      font-size: 16px;
      font-weight: 720;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .detail-meta {
      display: flex;
      align-items: center;
      gap: 7px 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 11px;
    }
    .detail-meta span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .detail-meta svg {
      width: 13px;
      height: 13px;
    }
    .error-callout {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 8px;
      margin-top: 11px;
      padding: 9px 10px;
      border-left: 3px solid var(--bad);
      border-radius: 4px;
      color: #85241c;
      background: var(--bad-soft);
      overflow-wrap: anywhere;
    }
    .error-callout svg {
      width: 16px;
      height: 16px;
      margin-top: 1px;
    }
    .detail-section {
      padding: 14px 15px;
      border-bottom: 1px solid var(--line);
    }
    .detail-section:last-child {
      border-bottom: 0;
    }
    .detail-section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 0 0 11px;
      font-size: 12px;
      font-weight: 750;
      text-transform: uppercase;
    }
    .detail-section-title > span {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .detail-section-title svg {
      width: 15px;
      height: 15px;
      color: var(--muted);
    }
    .kv {
      grid-template-columns: 124px minmax(0, 1fr);
      gap: 8px 11px;
      margin-bottom: 0;
      font-size: 12px;
    }
    .kv b {
      font-size: 11px;
    }
    .draft-status-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .draft-status-item span {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .collapsible {
      border-top: 1px solid var(--line);
    }
    .collapsible summary {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 10px 0 0;
      color: var(--muted);
      cursor: pointer;
      font-size: 11px;
      font-weight: 650;
      list-style: none;
    }
    .collapsible summary::-webkit-details-marker {
      display: none;
    }
    .collapsible summary svg {
      width: 14px;
      height: 14px;
    }
    .document-summary {
      margin-bottom: 6px;
    }
    .document-summary-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .document-summary-head strong {
      font-size: 16px;
    }
    .document-summary .progress-track {
      height: 6px;
      margin: 8px 0 7px;
    }
    .document-summary-meta {
      display: flex;
      gap: 6px 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 10px;
    }
    .doc {
      padding: 12px 0;
    }
    .doc-title {
      align-items: flex-start;
    }
    .doc-title b {
      min-width: 0;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .doc-links {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 7px;
    }
    .doc-link {
      height: 28px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 8px;
      border: 1px solid var(--line);
      border-radius: 5px;
      color: var(--text);
      background: #fff;
      font-size: 10px;
      font-weight: 650;
    }
    .doc-link:hover {
      border-color: #adb7c1;
      text-decoration: none;
      background: #f7f8fa;
    }
    .doc-link svg {
      width: 13px;
      height: 13px;
    }
    .retry-info {
      margin-top: 7px;
      font-size: 10px;
      line-height: 1.4;
    }
    .failure-log {
      margin-top: 8px;
      border-top: 0;
    }
    .failure-log summary {
      display: flex;
      align-items: center;
      gap: 6px;
      width: fit-content;
      margin-top: 0;
      padding: 4px 0;
      font-size: 10px;
    }
    .failure-log summary svg {
      width: 13px;
      height: 13px;
    }
    pre {
      border-color: var(--line);
      background: #f6f8fa;
      font-size: 10px;
    }
    .audit-list {
      position: relative;
      padding-left: 13px;
    }
    .audit {
      position: relative;
      padding: 7px 0 7px 12px;
      border-top: 0;
      border-left: 1px solid var(--line);
    }
    .audit::before {
      position: absolute;
      top: 13px;
      left: -4px;
      width: 7px;
      height: 7px;
      border: 2px solid #fff;
      border-radius: 50%;
      background: #8b98a5;
      content: "";
    }
    .audit b {
      font-size: 11px;
    }
    .review-actions button {
      height: 31px;
      font-size: 11px;
    }
    .mapping-form {
      display: grid;
      grid-template-columns: minmax(250px, 1.3fr) minmax(160px, 0.7fr) auto auto;
      gap: 9px;
      padding: 12px 13px;
      border-bottom: 1px solid var(--line);
      background: var(--subtle);
      align-items: end;
    }
    .mapping-form .field input {
      width: 100%;
    }
    #mappingSummary {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
    .table-scroll {
      width: 100%;
      overflow-x: auto;
    }
    .table-actions {
      flex-wrap: nowrap;
    }
    .table-actions .icon-button {
      width: 30px;
      min-width: 30px;
      height: 30px;
    }
    .mapping-name {
      display: block;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .mapping-short {
      display: inline-flex;
      min-width: 32px;
      align-items: center;
      justify-content: center;
      padding: 2px 6px;
      border: 1px solid #c9dce9;
      border-radius: 4px;
      color: var(--accent-strong);
      background: var(--accent-soft);
      font-weight: 750;
    }
    .activity-filter-bar {
      grid-template-columns: minmax(220px, 1.4fr) minmax(150px, 0.7fr) minmax(110px, 0.45fr);
    }
    .activity-filter-bar .date-field {
      width: min(100%, 410px);
    }
    #activityList {
      min-height: 300px;
      overflow-x: auto;
    }
    #activityList table {
      min-width: 900px;
    }
    .activity-event {
      display: block;
      font-weight: 700;
    }
    .activity-record {
      display: block;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .activity-mobile-record {
      display: none;
    }
    .activity-details summary {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--accent-strong);
      cursor: pointer;
      font-size: 11px;
      font-weight: 650;
      list-style: none;
    }
    .activity-details summary::-webkit-details-marker {
      display: none;
    }
    .activity-details pre {
      width: min(420px, 55vw);
      max-height: 220px;
      margin-top: 7px;
    }
    .toast-region {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 30;
      display: grid;
      width: min(360px, calc(100vw - 36px));
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 9px;
      padding: 11px 12px;
      border: 1px solid var(--line-strong);
      border-radius: 7px;
      color: var(--text);
      background: #fff;
      box-shadow: 0 8px 28px rgba(24, 33, 43, 0.16);
      pointer-events: auto;
      animation: toast-in 160ms ease-out;
    }
    .toast svg {
      width: 16px;
      height: 16px;
      color: var(--ok);
    }
    .toast.error svg {
      color: var(--bad);
    }
    .activity-section > summary {
      cursor: pointer;
      list-style: none;
    }
    .activity-section > summary::-webkit-details-marker {
      display: none;
    }
    @keyframes toast-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
    @media (max-width: 1100px) {
      #mappingSummary {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      main {
        grid-template-columns: minmax(0, 1fr);
      }
      .detail {
        position: static;
        max-height: none;
      }
      .split-panels {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    @media (max-width: 820px) {
      header {
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .header-actions {
        width: 100%;
        justify-content: flex-start;
      }
      .livebar {
        max-width: none;
        flex: 1 1 220px;
      }
      .filter-bar {
        grid-template-columns: minmax(0, 1fr) minmax(120px, 0.45fr);
      }
      .mapping-form {
        grid-template-columns: minmax(0, 1fr) minmax(150px, 0.55fr);
      }
      .mapping-form button:not(.icon-button) {
        width: 100%;
      }
      .mapping-form .icon-button {
        justify-self: end;
      }
    }
    @media (max-width: 620px) {
      header, .toolbar {
        flex-direction: row;
        align-items: center;
      }
      header {
        position: static;
        padding: 10px 12px;
      }
      .brand-copy span {
        display: none;
      }
      .nav-tabs {
        width: 100%;
        order: 3;
      }
      .nav-tabs button {
        flex: 1 1 0;
      }
      .header-actions {
        gap: 6px;
      }
      .header-actions select {
        width: auto;
      }
      .header-actions button:not(.icon-button) {
        width: auto;
      }
      main {
        gap: 12px;
        padding: 12px;
      }
      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      #mappingSummary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .metric {
        grid-template-columns: 42px minmax(0, 1fr);
        min-height: 68px;
        padding: 0;
      }
      .metric > .metric-icon {
        width: 100%;
        height: 100%;
        min-height: 68px;
      }
      .metric strong {
        font-size: 18px;
      }
      .toolbar {
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .filter-bar {
        grid-template-columns: minmax(0, 1fr);
      }
      .filter-bar .date-field {
        grid-column: auto;
      }
      #queue table {
        min-width: 758px;
      }
      .selection-bar {
        align-items: flex-start;
        flex-direction: column;
      }
      .selection-bar .controls {
        width: 100%;
      }
      .selection-bar .controls button {
        flex: 1 1 auto;
      }
      th:nth-child(3), td:nth-child(3),
      th:nth-child(5), td:nth-child(5) {
        display: table-cell;
      }
      .queue-footer {
        align-items: stretch;
        flex-direction: column;
      }
      .retention-control {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .retention-control .date-input {
        width: 100%;
      }
      .pagination {
        justify-content: flex-start;
      }
      #activityList table {
        min-width: 0;
        table-layout: fixed;
      }
      #activityList th:nth-child(3),
      #activityList td:nth-child(3),
      #activityList th:nth-child(4),
      #activityList td:nth-child(4),
      #activityList th:nth-child(5),
      #activityList td:nth-child(5) {
        display: none;
      }
      #activityList th:first-child {
        width: 92px !important;
      }
      #activityList th:last-child {
        width: 48px !important;
      }
      #activityList th:last-child,
      #activityList td:last-child {
        padding-right: 4px;
        padding-left: 4px;
      }
      #activityList td:last-child .table-actions {
        align-items: center;
        flex-direction: column;
        gap: 4px;
      }
      .activity-mobile-record {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 10px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .activity-details summary span {
        display: none;
      }
      .activity-details pre {
        width: 230px;
      }
      .mapping-form {
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .mapping-form .field {
        grid-column: 1 / -1;
      }
      #mappingsList table,
      #missingMappingsList table {
        min-width: 0;
        table-layout: fixed;
      }
      #mappingsList th:nth-child(3),
      #mappingsList td:nth-child(3),
      #missingMappingsList th:nth-child(2),
      #missingMappingsList td:nth-child(2),
      #missingMappingsList th:nth-child(3),
      #missingMappingsList td:nth-child(3) {
        display: none;
      }
      #mappingsList th:nth-child(2) {
        width: 104px !important;
      }
      #mappingsList th:nth-child(4) {
        width: 76px !important;
      }
      #missingMappingsList th:last-child {
        width: 82px !important;
      }
      #mappingsList input {
        min-width: 0;
        width: 100%;
      }
      #mappingsList .table-actions {
        flex-wrap: wrap;
      }
      .draft-status-grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    /* Draft review workspace */
    .draft-filter-bar {
      grid-template-columns: minmax(240px, 1fr) 170px 150px 110px minmax(290px, auto);
    }
    #draftList {
      overflow-x: auto;
    }
    #draftList table {
      min-width: 920px;
    }
    .draft-case {
      display: block;
      font-weight: 650;
      color: var(--text);
    }
    .draft-parties {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .draft-doc-count {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--text);
      font-weight: 600;
    }
    .draft-doc-count svg {
      width: 14px;
      height: 14px;
      color: var(--muted);
    }
    .draft-workspace-shell {
      min-height: 680px;
      height: calc(100vh - 112px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .draft-workspace-header {
      min-height: 62px;
      display: grid;
      grid-template-columns: auto minmax(190px, 1fr) auto auto;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .draft-workspace-title {
      min-width: 0;
    }
    .draft-workspace-title strong,
    .draft-workspace-title span {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .draft-workspace-title strong {
      font-size: 15px;
    }
    .draft-workspace-title span {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
    }
    .draft-workspace-statuses,
    .draft-workspace-actions,
    .draft-document-links {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
    }
    .draft-workspace {
      min-height: 0;
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(390px, 0.85fr);
    }
    .draft-document-panel,
    .draft-fields-panel {
      min-width: 0;
      min-height: 0;
    }
    .draft-document-panel {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--line);
      background: #30363d;
    }
    .draft-panel-toolbar {
      min-height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 12px;
      border-bottom: 1px solid #cfd5db;
      background: #f8f9fb;
    }
    .draft-document-select {
      min-width: 0;
      flex: 1 1 auto;
    }
    .draft-document-select > span {
      display: block;
      margin-bottom: 3px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 650;
      text-transform: uppercase;
    }
    .draft-document-select select {
      width: min(100%, 470px);
    }
    .button-link {
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 9px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      color: var(--text);
      background: #fff;
      font-weight: 600;
      white-space: nowrap;
    }
    .button-link:hover {
      border-color: #aeb8c2;
      background: #f2f4f6;
      text-decoration: none;
    }
    .button-link svg {
      width: 14px;
      height: 14px;
    }
    .button-link.is-disabled {
      display: none;
    }
    .draft-pdf-viewer {
      min-height: 0;
      flex: 1 1 auto;
      display: flex;
      align-items: stretch;
      justify-content: stretch;
      padding: 12px;
    }
    .draft-pdf-viewer iframe {
      width: 100%;
      height: 100%;
      min-height: 560px;
      border: 0;
      background: #fff;
      box-shadow: 0 1px 7px rgba(0, 0, 0, 0.25);
    }
    .draft-preview-empty {
      width: 100%;
      min-height: 360px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 8px;
      padding: 24px;
      color: #d6dbe0;
      text-align: center;
    }
    .draft-preview-empty svg {
      width: 32px;
      height: 32px;
    }
    .draft-preview-empty strong {
      color: #fff;
    }
    .draft-fields-panel {
      display: flex;
      flex-direction: column;
      overflow: auto;
      background: #fff;
    }
    .draft-fields-heading {
      min-height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--line);
      background: #fafbfc;
    }
    .draft-fields-heading strong,
    .draft-fields-heading span {
      display: block;
    }
    .draft-fields-heading strong {
      font-size: 14px;
    }
    .draft-fields-heading div > span {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
    }
    .unsaved-badge {
      padding: 3px 7px;
      border-radius: 999px;
      color: var(--warn);
      background: var(--warn-soft);
      font-size: 11px;
      font-weight: 650;
    }
    #draftFieldsForm {
      padding: 14px;
    }
    .draft-validation {
      display: grid;
      gap: 6px;
      margin-bottom: 14px;
      padding: 10px 11px;
      border: 1px solid #ead29f;
      border-radius: 6px;
      color: #704500;
      background: var(--warn-soft);
    }
    .draft-validation.has-errors {
      border-color: #e8aaa5;
      color: var(--bad);
      background: var(--bad-soft);
    }
    .draft-validation-row {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      font-size: 12px;
    }
    .draft-validation-row svg {
      width: 14px;
      height: 14px;
      margin-top: 1px;
      flex: 0 0 auto;
    }
    .draft-field-section {
      margin-bottom: 18px;
    }
    .draft-field-section > h3 {
      margin: 0 0 9px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .draft-field-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 11px;
    }
    .draft-field {
      min-width: 0;
    }
    .draft-field.wide {
      grid-column: 1 / -1;
    }
    .draft-field-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
      color: var(--text);
      font-size: 11px;
      font-weight: 650;
    }
    .draft-field input {
      width: 100%;
    }
    .field-source {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 9px;
      font-weight: 650;
      text-transform: uppercase;
    }
    .field-source.manual {
      color: var(--accent-strong);
    }
    .field-source.derived {
      color: var(--warn);
    }
    .field-source.empty {
      color: var(--bad);
    }
    .draft-field.has-error input {
      border-color: #db8881;
      background: #fffafa;
    }
    .draft-field.has-warning input {
      border-color: #dfc17e;
      background: #fffdf8;
    }
    .draft-field-message {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.3;
    }
    .draft-field.has-error .draft-field-message {
      color: var(--bad);
    }
    .draft-field select,
    .draft-field input[type="number"] {
      width: 100%;
    }
    .draft-field.checkbox-field {
      display: flex;
      align-items: center;
      gap: 9px;
      min-height: 38px;
      padding-top: 20px;
      font-size: 12px;
      font-weight: 600;
    }
    .draft-field.checkbox-field input {
      width: 16px;
      height: 16px;
      margin: 0;
    }
    .draft-section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 9px;
    }
    .draft-section-heading h3 {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .draft-section-heading button {
      min-height: 30px;
      padding: 0 8px;
      font-size: 11px;
    }
    .draft-party {
      padding: 11px 0 13px;
      border-top: 1px solid var(--line);
    }
    .draft-party:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
    .draft-party-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 9px;
      font-size: 12px;
      font-weight: 700;
    }
    .draft-party-title button {
      width: 30px;
      min-width: 30px;
      height: 30px;
      padding: 0;
    }
    .draft-document-mapping {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(150px, 1fr) 34px;
      gap: 8px;
      align-items: end;
      padding: 10px 0;
      border-top: 1px solid var(--line);
    }
    .draft-document-mapping:first-of-type {
      border-top: 0;
    }
    .draft-document-mapping .draft-field-label {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .draft-document-mapping input[type="text"] {
      width: 100%;
    }
    .draft-document-required {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: #fafbfc;
    }
    .draft-document-required input {
      width: 16px;
      height: 16px;
      margin: 0;
    }
    .draft-document-status {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      color: var(--muted);
      font-size: 10px;
    }
    .draft-document-status .status {
      font-size: 9px;
    }
    .draft-empty-section {
      padding: 10px 0;
      color: var(--muted);
      font-size: 12px;
    }
    .draft-notes-field {
      display: block;
      padding-top: 13px;
      border-top: 1px solid var(--line);
      color: var(--text);
      font-size: 11px;
      font-weight: 650;
    }
    .draft-notes-field textarea {
      margin-top: 5px;
      min-height: 88px;
      font-weight: 400;
    }
    .draft-mobile-switch {
      display: none;
      padding: 7px;
      border-bottom: 1px solid var(--line);
      background: #f4f6f8;
    }
    .draft-mobile-switch button {
      flex: 1 1 0;
      border-color: transparent;
      background: transparent;
      color: var(--muted);
    }
    .draft-mobile-switch button.active {
      color: var(--text);
      background: #fff;
      box-shadow: 0 1px 3px rgba(24, 33, 43, 0.12);
    }
    @media (max-width: 1080px) {
      .draft-filter-bar {
        grid-template-columns: minmax(220px, 1fr) 160px 145px 105px;
      }
      .draft-filter-bar .date-field {
        grid-column: 1 / -1;
      }
      .draft-workspace {
        grid-template-columns: minmax(0, 1.15fr) minmax(360px, 0.85fr);
      }
      .draft-workspace-header {
        grid-template-columns: auto minmax(180px, 1fr) auto;
      }
      .draft-workspace-statuses {
        display: none;
      }
    }
    @media (max-width: 820px) {
      .draft-workspace-shell {
        height: calc(100vh - 24px);
        min-height: 620px;
      }
      .draft-workspace-header {
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 8px;
      }
      .draft-workspace-actions button {
        width: 34px;
        min-width: 34px;
        padding: 0;
        font-size: 0;
      }
      .draft-workspace-actions button svg {
        width: 15px;
        height: 15px;
      }
      .draft-mobile-switch {
        display: flex;
      }
      .draft-workspace {
        display: block;
        overflow: hidden;
      }
      .draft-document-panel,
      .draft-fields-panel {
        display: none;
        width: 100%;
        height: 100%;
        border-right: 0;
      }
      .draft-document-panel.mobile-active,
      .draft-fields-panel.mobile-active {
        display: flex;
      }
      .draft-fields-panel.mobile-active {
        overflow: auto;
      }
    }
    @media (max-width: 620px) {
      .nav-tabs button {
        min-width: 0;
        gap: 4px;
        padding: 0 6px;
        font-size: 11px;
      }
      .draft-filter-bar {
        grid-template-columns: minmax(0, 1fr);
      }
      .draft-filter-bar .date-field {
        grid-column: auto;
      }
      #draftList table {
        min-width: 760px;
      }
      .draft-workspace-shell {
        height: calc(100dvh - 188px);
        min-height: 500px;
        border-radius: 0;
      }
      .draft-workspace-header {
        padding: 8px;
      }
      .draft-workspace-actions {
        gap: 4px;
      }
      .draft-workspace-title span {
        display: none;
      }
      .draft-panel-toolbar {
        align-items: stretch;
        flex-direction: column;
      }
      .draft-document-select select {
        width: 100%;
      }
      .draft-document-links {
        width: 100%;
      }
      .draft-document-links .button-link {
        flex: 1 1 0;
      }
      .draft-pdf-viewer {
        padding: 6px;
      }
      .draft-pdf-viewer iframe {
        min-height: 460px;
      }
      .draft-field-grid {
        grid-template-columns: minmax(0, 1fr);
      }
      .draft-field.wide {
        grid-column: auto;
      }
      .draft-document-mapping {
        grid-template-columns: minmax(0, 1fr) 34px;
      }
      .draft-document-mapping .filing-type-field {
        grid-column: 1 / -1;
      }
    }

    /* Admin UI v3: compact operations workspace */
    :root {
      --bg: #f2f3f5;
      --panel: #ffffff;
      --subtle: #f7f8f9;
      --line: #d9dde2;
      --line-strong: #bfc6ce;
      --text: #20252b;
      --muted: #626b75;
      --accent: #176b91;
      --accent-strong: #0f506d;
      --accent-soft: #e8f2f6;
      --bad: #a7332b;
      --bad-soft: #fbeceb;
      --warn: #8a5a00;
      --warn-soft: #fff4d6;
      --ok: #23734b;
      --ok-soft: #e8f4ed;
      --shadow: none;
    }
    body {
      background: var(--bg);
      font-size: 13px;
    }
    header.app-header {
      min-height: 58px;
      padding: 8px 18px;
      box-shadow: none;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      background: #252b31;
    }
    .nav-tabs {
      gap: 0;
      padding: 0;
      border-radius: 0;
      background: transparent;
    }
    .nav-tabs button {
      height: 40px;
      padding: 0 12px;
      border-bottom: 2px solid transparent;
      border-radius: 0;
    }
    .nav-tabs button.active {
      color: var(--accent-strong);
      background: transparent;
      border-bottom-color: var(--accent);
      box-shadow: none;
    }
    main {
      gap: 12px;
      padding: 14px 16px 24px;
    }
    .panel {
      border-radius: 4px;
      box-shadow: none;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0;
      margin-bottom: 10px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--panel);
    }
    .metric {
      min-height: 60px;
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      overflow: hidden;
      border: 0;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      box-shadow: none;
      background: transparent;
    }
    .metric:nth-child(4n) { border-right: 0; }
    .metric:nth-last-child(-n + 4) { border-bottom: 0; }
    .metric > .metric-icon {
      width: 30px;
      height: 30px;
      min-height: 30px;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      margin: 0;
      border-radius: 4px;
      color: var(--accent);
      background: transparent;
    }
    .metric > .metric-icon svg {
      width: 17px;
      height: 17px;
    }
    .metric.tone-danger .metric-icon,
    .metric.tone-warning .metric-icon,
    .metric.tone-success .metric-icon {
      background: transparent;
    }
    .metric-copy {
      align-self: center;
      min-width: 0;
      padding: 0;
    }
    .metric .metric-copy > span {
      margin: 0 0 2px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.2;
      white-space: normal;
    }
    .metric strong {
      font-size: 19px;
      line-height: 1.05;
    }
    .toolbar {
      min-height: 50px;
      padding: 9px 12px;
    }
    .filter-bar {
      padding: 10px 12px;
      background: #fafbfc;
    }
    table thead th {
      background: #f5f6f7;
      color: #515a64;
    }
    tbody tr:hover { background: #f7fafb; }
    tbody tr.selected { background: #eaf3f7; }
    tbody tr.selected td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    .queue-issue {
      display: block;
      max-width: 190px;
      margin-top: 4px;
      overflow: hidden;
      color: var(--bad);
      font-size: 10px;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .source-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 0 9px;
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--subtle);
      font-size: 11px;
    }
    .source-label svg {
      width: 14px;
      height: 14px;
    }
    #mappingSummary {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
    #mappingSummary .metric {
      border-bottom: 0;
    }
    #mappingSummary .metric:nth-child(4n) {
      border-right: 1px solid var(--line);
    }
    #mappingSummary .metric:last-child {
      border-right: 0;
    }
    @media (min-width: 1601px) {
      .filter-bar {
        grid-template-columns: minmax(280px, 1fr) 120px 170px 110px minmax(320px, 0.8fr);
      }
      .filter-bar .date-field {
        width: auto;
        grid-column: auto;
      }
    }
    @media (max-width: 1100px) {
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric:nth-child(4n) { border-right: 1px solid var(--line); }
      .metric:nth-child(2n) { border-right: 0; }
      .metric:nth-last-child(-n + 4) { border-bottom: 1px solid var(--line); }
      .metric:nth-last-child(-n + 2) { border-bottom: 0; }
    }
    @media (max-width: 620px) {
      header.app-header { padding: 8px 10px; }
      main { padding: 10px; }
      .metric {
        min-height: 56px;
        grid-template-columns: 26px minmax(0, 1fr);
        padding: 8px;
      }
      .metric > .metric-icon {
        width: 26px;
        height: 26px;
        min-height: 26px;
      }
      .metric strong { font-size: 17px; }
      #mappingSummary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #mappingSummary .metric { border-bottom: 1px solid var(--line); }
      #mappingSummary .metric:nth-child(2n) { border-right: 0; }
      #mappingSummary .metric:last-child { border-bottom: 0; }
      #queue { overflow: visible; }
      #queue table,
      #queue tbody {
        display: block;
        width: 100%;
        min-width: 0;
      }
      #queue thead { display: none; }
      #queue tr[data-id] {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px 14px;
        padding: 12px 12px 12px 42px;
        border-bottom: 1px solid var(--line);
      }
      #queue tr[data-id].selected {
        box-shadow: inset 3px 0 0 var(--accent);
      }
      #queue tr[data-id] td {
        display: block !important;
        width: auto;
        min-width: 0;
        padding: 0;
        border: 0;
        box-shadow: none;
      }
      #queue tr[data-id] td.select-column {
        position: absolute;
        top: 14px;
        left: 13px;
        width: 16px;
      }
      #queue tr[data-id] td:nth-child(3),
      #queue tr[data-id] td:nth-child(5) {
        grid-column: 1 / -1;
      }
      #queue tr[data-id] td:nth-child(3) { order: -1; }
      #queue tr[data-id] td[data-label]::before {
        display: block;
        margin-bottom: 3px;
        color: var(--muted);
        content: attr(data-label);
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
      }
      #queue tr[data-id] td:nth-child(3)::before { display: none; }
      #queue .queue-issue { max-width: none; }
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="controls">
      <div class="brand-lockup">
        <span class="brand-icon"><i data-lucide="scale"></i></span>
        <div class="brand-copy">
          <h1>Legal Workflow</h1>
          <span>Operations admin</span>
        </div>
      </div>
      <nav class="nav-tabs" aria-label="Admin sections">
        <button id="queueTab" class="active" type="button"><i data-lucide="inbox"></i>Queue</button>
        <button id="draftsTab" type="button"><i data-lucide="file-pen-line"></i>Drafts</button>
        <button id="mappingsTab" type="button"><i data-lucide="users"></i>Plaintiffs</button>
        <button id="activityTab" type="button"><i data-lucide="history"></i>Activity</button>
      </nav>
    </div>
    <div class="controls header-actions">
      <div class="livebar"><span id="liveDot" class="dot"></span><span id="liveStatus">Live</span></div>
      <select id="syncLimit" aria-label="Inbox sync limit" title="Inbox sync limit">
        <option value="50">Sync 50</option>
        <option value="100" selected>Sync 100</option>
        <option value="250">Sync 250</option>
        <option value="500">Sync 500</option>
        <option value="1000">Sync 1000</option>
      </select>
      <button id="syncBtn" type="button"><i data-lucide="mail-check"></i>Sync inbox</button>
      <button id="refreshBtn" class="primary icon-button" type="button" title="Refresh data" aria-label="Refresh data"><i data-lucide="refresh-cw"></i></button>
    </div>
  </header>
  <main>
    <section id="queuePane">
      <div class="summary" id="summary"></div>
      <div class="panel">
        <div class="toolbar">
          <div class="section-heading">
            <h2><i data-lucide="inbox"></i>Incoming queue</h2>
            <span id="queueMeta">Loading records...</span>
          </div>
        </div>
        <div class="filter-bar">
          <label class="field search-field">
            <span class="field-label">Search</span>
            <i data-lucide="search"></i>
            <input id="searchInput" type="search" placeholder="Subject, case, plaintiff">
          </label>
          <label class="field">
            <span class="field-label">View</span>
            <select id="scopeFilter">
              <option value="active">Active</option>
              <option value="all">All history</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Status</span>
            <select id="statusFilter">
              <option value="">All statuses</option>
              <option value="failed">Failed</option>
              <option value="partial_failure">Partial failure</option>
              <option value="processed">Processed</option>
              <option value="ignored">Ignored</option>
              <option value="new">New</option>
              <option value="processing">Processing</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Rows</span>
            <select id="pageSizeFilter">
              <option value="25">25 / page</option>
              <option value="50" selected>50 / page</option>
              <option value="100">100 / page</option>
            </select>
          </label>
          <div class="field date-field">
            <span class="field-label">Received date</span>
            <div class="date-range">
              <label class="date-boundary">
                <span>From</span>
                <input id="dateFromFilter" class="date-input" type="date" title="Received from" aria-label="Received from">
              </label>
              <label class="date-boundary">
                <span>Through (inclusive)</span>
                <input id="dateToFilter" class="date-input" type="date" title="Received through, inclusive" aria-label="Received through, inclusive">
              </label>
            </div>
          </div>
        </div>
        <div id="selectionBar" class="selection-bar hidden">
          <span class="selection-count"><i data-lucide="check-square-2"></i><strong id="selectionCount">0</strong> selected</span>
          <div class="controls">
            <button id="bulkRetryBtn" type="button"><i data-lucide="rotate-cw"></i>Reprocess selected</button>
            <button id="bulkDeleteBtn" class="danger" type="button"><i data-lucide="trash-2"></i>Delete selected</button>
            <button id="clearSelectionBtn" class="ghost" type="button">Clear</button>
          </div>
        </div>
        <div id="queue"></div>
        <div class="queue-footer">
          <div class="retention-control">
            <input id="deleteBeforeDate" class="date-input" type="date" title="Delete terminal records before date" aria-label="Delete records before date">
            <button id="purgeBtn" class="danger" type="button"><i data-lucide="calendar-x"></i>Delete older</button>
          </div>
          <div class="controls">
            <span id="pageInfo" class="muted"></span>
            <div id="pagination" class="pagination" aria-label="Queue pages"></div>
          </div>
        </div>
      </div>
    </section>
    <section id="detailPane" class="panel detail">
      <div class="toolbar">
        <div class="section-heading">
          <h2><i data-lucide="file-search"></i>Record detail</h2>
          <span id="detailContext">No record selected</span>
        </div>
        <div class="controls">
          <button id="retryBtn" type="button" disabled title="Reprocess the whole email"><i data-lucide="rotate-cw"></i>Reprocess</button>
          <button id="deleteEmailBtn" class="danger icon-button" type="button" disabled title="Delete this database record only" aria-label="Delete record"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <div class="detail-body" id="detail">
        <div class="detail-empty"><span class="detail-empty-icon"><i data-lucide="mouse-pointer-2"></i></span><b>No record selected</b></div>
      </div>
    </section>
    <section id="draftsPane" class="full-span hidden">
      <div id="draftListView" class="panel">
        <div class="toolbar">
          <div class="section-heading">
            <h2><i data-lucide="file-pen-line"></i>Case drafts</h2>
            <span id="draftMeta">Loading drafts...</span>
          </div>
        </div>
        <div class="filter-bar draft-filter-bar">
          <label class="field search-field">
            <span class="field-label">Search</span>
            <i data-lucide="search"></i>
            <input id="draftSearch" type="search" placeholder="Case, party, subject">
          </label>
          <label class="field">
            <span class="field-label">Draft status</span>
            <select id="draftStatusFilter">
              <option value="">All statuses</option>
              <option value="needs_review">Needs review</option>
              <option value="parsed">Parsed</option>
              <option value="ready_to_file">Ready to file</option>
              <option value="validation_failed">Validation failed</option>
              <option value="rejected">Rejected</option>
              <option value="filed_successfully">Filed successfully</option>
              <option value="filing_failed">Filing failed</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Validation</span>
            <select id="draftValidationFilter">
              <option value="">All validation</option>
              <option value="failed">Failed</option>
              <option value="warnings">Warnings</option>
              <option value="passed">Passed</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Rows</span>
            <select id="draftPageSize">
              <option value="10">10 / page</option>
              <option value="25" selected>25 / page</option>
              <option value="50">50 / page</option>
            </select>
          </label>
          <div class="field date-field">
            <span class="field-label">Received date</span>
            <div class="date-range">
              <label class="date-boundary">
                <span>From</span>
                <input id="draftDateFrom" class="date-input" type="date" aria-label="Draft received from">
              </label>
              <label class="date-boundary">
                <span>Through (inclusive)</span>
                <input id="draftDateTo" class="date-input" type="date" aria-label="Draft received through, inclusive">
              </label>
            </div>
          </div>
        </div>
        <div id="draftList"></div>
        <div class="queue-footer">
          <span id="draftPageInfo" class="muted"></span>
          <div id="draftPagination" class="pagination" aria-label="Draft pages"></div>
        </div>
      </div>
      <div id="draftWorkspaceView" class="draft-workspace-shell hidden">
        <div class="draft-workspace-header">
          <button id="closeDraftBtn" class="icon-button" type="button" title="Back to drafts" aria-label="Back to drafts"><i data-lucide="arrow-left"></i></button>
          <div class="draft-workspace-title">
            <strong id="draftWorkspaceCase">Draft</strong>
            <span id="draftWorkspaceSubject"></span>
          </div>
          <div id="draftWorkspaceStatuses" class="draft-workspace-statuses"></div>
          <div class="draft-workspace-actions">
            <button id="draftRejectBtn" class="danger" type="button"><i data-lucide="x"></i>Reject</button>
            <button id="draftApproveBtn" type="button"><i data-lucide="check-check"></i>Approve</button>
            <button id="draftSaveBtn" class="primary" type="button"><i data-lucide="save"></i>Save changes</button>
          </div>
        </div>
        <div class="draft-mobile-switch" role="group" aria-label="Draft workspace view">
          <button type="button" data-draft-mobile-mode="document" class="active"><i data-lucide="file-text"></i>Document</button>
          <button type="button" data-draft-mobile-mode="fields"><i data-lucide="clipboard-list"></i>Fields</button>
        </div>
        <div class="draft-workspace">
          <section id="draftDocumentPanel" class="draft-document-panel">
            <div class="draft-panel-toolbar">
              <label class="draft-document-select">
                <span>Document</span>
                <select id="draftDocumentSelect" aria-label="Preview document"></select>
              </label>
              <div class="draft-document-links">
                <a id="draftOneDriveLink" class="button-link" target="_blank" rel="noopener"><i data-lucide="cloud"></i>OneDrive</a>
                <a id="draftSourceLink" class="button-link" target="_blank" rel="noopener"><i data-lucide="download"></i>MiFILE</a>
              </div>
            </div>
            <div id="draftPdfViewer" class="draft-pdf-viewer"></div>
          </section>
          <section id="draftFieldsPanel" class="draft-fields-panel">
            <div class="draft-fields-heading">
              <div>
                <strong>Filing fields</strong>
                <span>Review extracted values before approval</span>
              </div>
              <span id="draftUnsavedBadge" class="unsaved-badge hidden">Unsaved</span>
            </div>
            <form id="draftFieldsForm">
              <div id="draftValidationSummary"></div>
              <div id="draftFieldGroups"></div>
              <label class="draft-notes-field">
                <span>Reviewer notes</span>
                <textarea id="draftReviewerNotes" placeholder="Internal review notes"></textarea>
              </label>
            </form>
          </section>
        </div>
      </div>
    </section>
    <section id="mappingsPane" class="full-span hidden">
      <div class="summary" id="mappingSummary"></div>
      <div class="split-panels">
        <div class="panel">
          <div class="toolbar">
            <div class="section-heading">
              <h2><i data-lucide="book-user"></i>Plaintiff mappings</h2>
              <span id="mappingMeta">Loading mappings...</span>
            </div>
            <div class="controls">
              <input id="mappingSearch" type="search" placeholder="Search mappings">
            </div>
          </div>
          <div class="mapping-form">
            <label class="field">
              <span class="field-label">Full Plaintiff name</span>
              <input id="mappingFullName" type="text" placeholder="Example Property Management LLC">
            </label>
            <label class="field">
              <span class="field-label">Short name</span>
              <input id="mappingShortName" type="text" placeholder="EPM">
            </label>
            <button id="addMappingBtn" class="primary" type="button"><i data-lucide="plus"></i>Add Plaintiff</button>
            <button id="clearMappingBtn" class="ghost icon-button" type="button" title="Clear fields" aria-label="Clear fields"><i data-lucide="x"></i></button>
          </div>
          <div id="mappingsList"></div>
        </div>
        <div class="panel">
          <div class="toolbar">
            <div class="section-heading">
              <h2><i data-lucide="circle-alert"></i>Missing mappings</h2>
              <span id="missingMappingMeta">Loading candidates...</span>
            </div>
          </div>
          <div id="missingMappingsList"></div>
        </div>
      </div>
    </section>
    <section id="activityPane" class="full-span hidden">
      <div class="panel">
        <div class="toolbar">
          <div class="section-heading">
            <h2><i data-lucide="history"></i>Activity log</h2>
            <span id="activityMeta">Loading events...</span>
          </div>
        </div>
        <div class="filter-bar activity-filter-bar">
          <label class="field search-field">
            <span class="field-label">Search</span>
            <i data-lucide="search"></i>
            <input id="activitySearch" type="search" placeholder="Event, subject, sender">
          </label>
          <label class="field">
            <span class="field-label">Record type</span>
            <select id="activityEntityFilter">
              <option value="">All record types</option>
              <option value="email_record">Email</option>
              <option value="document_record">Document</option>
              <option value="case_draft">Draft case</option>
              <option value="plaintiff_mapping">Plaintiff mapping</option>
              <option value="filing_job">Filing job</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">Rows</span>
            <select id="activityPageSize">
              <option value="25">25 / page</option>
              <option value="50" selected>50 / page</option>
              <option value="100">100 / page</option>
            </select>
          </label>
          <div class="field date-field">
            <span class="field-label">Event date</span>
            <div class="date-range">
              <label class="date-boundary">
                <span>From</span>
                <input id="activityDateFrom" class="date-input" type="date" aria-label="Activity from">
              </label>
              <label class="date-boundary">
                <span>Through (inclusive)</span>
                <input id="activityDateTo" class="date-input" type="date" aria-label="Activity through, inclusive">
              </label>
            </div>
          </div>
        </div>
        <div id="activityList"></div>
        <div class="queue-footer">
          <span id="activityPageInfo" class="muted"></span>
          <div id="activityPagination" class="pagination" aria-label="Activity pages"></div>
        </div>
      </div>
    </section>
  </main>
  <div id="toastRegion" class="toast-region" aria-live="polite"></div>
  <script src="/assets/lucide.js"></script>
  <script>
    const state = {
      summary: null,
      queue: [],
      selectedId: null,
      selectedIds: new Set(),
      detail: null,
      live: null,
      plaintiffMappings: { mappings: [], missing: [] },
      activity: [],
      drafts: [],
      selectedDraftId: null,
      draftDetail: null,
      activeDraftDocumentId: null,
      draftDirty: false,
      draftMobileMode: 'document',
      editingMappingId: null,
      view: 'queue',
      pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 },
      activityPagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 },
      draftPagination: { page: 1, pageSize: 25, totalItems: 0, totalPages: 1 },
      loadPromise: null,
      activityLoadPromise: null,
      draftLoadPromise: null,
    };

    const STATUS_LABELS = {
      partial_failure: 'Partial failure',
      validation_failed: 'Validation failed',
      ready_to_file: 'Ready to file',
      needs_review: 'Needs review',
      needs_short_name: 'Needs short name',
      needs_application: 'Needs application',
      not_downloadable: 'Not downloadable',
      retry_queued: 'Retry queued',
      filing_in_progress: 'Filing in progress',
      filed_successfully: 'Filed successfully',
      filing_failed: 'Filing failed',
      not_started: 'Not started',
      legacy_processed: 'Legacy processed',
    };
    const DRAFT_FIELD_GROUPS = [
      {
        title: 'Case identifiers',
        fields: [
          { key: 'courtName', label: 'Court', wide: true },
          { key: 'caseNumber', label: 'Case number' },
          { key: 'temporaryCaseNumber', label: 'Temporary case number' },
          { key: 'newCaseNumber', label: 'New case number' },
          { key: 'caseTitle', label: 'Case title', wide: true },
        ],
      },
      {
        title: 'Source references',
        fields: [
          { key: 'bundleNumber', label: 'Bundle number' },
          { key: 'filedAt', label: 'Filed / submitted at' },
          { key: 'submitterName', label: 'Submitter name' },
        ],
      },
    ];
    const MIFILE_CASE_TYPES = [
      'LT - Landlord-Tenant Summary Proceedings',
      'SP - Land Contract Summary Proceedings',
    ];
    const MIFILE_FILING_TYPES = [
      'Advice of Rights and Information (Landlord-Tenant)',
      'Local Rental and Housing Information',
      'Complaint for Possession and Supplemental Money Judgment (Fee Varies)',
      'Complaint for Possession Only',
      'Other',
      'Request for Court Mailing and Record (Landlord-Tenant)',
      'Summons, Landlord-Tenant/Land Contract',
    ];
    const DRAFT_SOURCE_LABELS = {
      email: 'Email',
      manual: 'Manual',
      derived: 'Case title',
      empty: 'Missing',
    };
    const statusClass = value => String(value || 'unknown').replace(/[^a-z0-9_ -]/gi, '_');
    const statusLabel = value => {
      const normalized = String(value || 'unknown');
      return STATUS_LABELS[normalized] ||
        normalized.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
    };
    const fmtDate = value => value ? new Date(value).toLocaleString() : '';
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
    const icon = name => '<i data-lucide="' + escapeHtml(name) + '"></i>';
    const statusPill = value => '<span class="status ' + statusClass(value) + '">' + escapeHtml(statusLabel(value)) + '</span>';

    function renderIcons() {
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons({
          attrs: {
            'stroke-width': 1.8,
          },
        });
      }
    }

    function showToast(message, tone) {
      const root = document.getElementById('toastRegion');
      const toast = document.createElement('div');
      toast.className = 'toast' + (tone === 'error' ? ' error' : '');
      toast.innerHTML = icon(tone === 'error' ? 'circle-alert' : 'circle-check') +
        '<div>' + escapeHtml(message) + '</div>';
      root.appendChild(toast);
      renderIcons();
      setTimeout(() => toast.remove(), 4200);
    }

    function setButtonBusy(button, busy, label) {
      if (!button) return;
      if (busy) {
        button.dataset.idleHtml = button.innerHTML;
        button.disabled = true;
        button.classList.add('loading');
        button.innerHTML = icon('loader-circle') + (label ? escapeHtml(label) : '');
      } else {
        button.disabled = false;
        button.classList.remove('loading');
        if (button.dataset.idleHtml) {
          button.innerHTML = button.dataset.idleHtml;
          delete button.dataset.idleHtml;
        }
      }
      renderIcons();
    }

    async function api(path, options) {
      const res = await fetch(path, options);
      const text = await res.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (!res.ok) {
        throw new Error(payload && payload.error ? payload.error : String(payload || res.statusText));
      }
      return payload;
    }

    function setView(view) {
      state.view = view;
      document.getElementById('queuePane').classList.toggle('hidden', view !== 'queue');
      document.getElementById('detailPane').classList.toggle('hidden', view !== 'queue');
      document.getElementById('draftsPane').classList.toggle('hidden', view !== 'drafts');
      document.getElementById('mappingsPane').classList.toggle('hidden', view !== 'mappings');
      document.getElementById('activityPane').classList.toggle('hidden', view !== 'activity');
      document.getElementById('queueTab').classList.toggle('active', view === 'queue');
      document.getElementById('draftsTab').classList.toggle('active', view === 'drafts');
      document.getElementById('mappingsTab').classList.toggle('active', view === 'mappings');
      document.getElementById('activityTab').classList.toggle('active', view === 'activity');
      document.getElementById('queueTab').setAttribute('aria-current', view === 'queue' ? 'page' : 'false');
      document.getElementById('draftsTab').setAttribute('aria-current', view === 'drafts' ? 'page' : 'false');
      document.getElementById('mappingsTab').setAttribute('aria-current', view === 'mappings' ? 'page' : 'false');
      document.getElementById('activityTab').setAttribute('aria-current', view === 'activity' ? 'page' : 'false');
      renderIcons();

      if (view === 'drafts') {
        if (state.selectedDraftId && state.draftDetail) {
          renderDraftWorkspace();
        } else {
          loadDrafts().catch(showDraftError);
        }
      } else if (view === 'mappings') {
        loadPlaintiffMappings().catch(showMappingError);
      } else if (view === 'activity') {
        loadActivity().catch(showActivityError);
      }
    }

    function metric(label, value, iconName, tone) {
      return '<div class="metric ' + escapeHtml(tone ? 'tone-' + tone : '') + '">' +
        '<span class="metric-icon">' + icon(iconName) + '</span>' +
        '<div class="metric-copy"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>' +
      '</div>';
    }

    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function localDateBoundaryIso(value, endExclusive) {
      if (!value) return '';
      const date = new Date(value + 'T00:00:00');
      if (endExclusive) date.setDate(date.getDate() + 1);
      return date.toISOString();
    }

    function renderSummary() {
      const s = state.summary;
      if (!s) return;
      const email = s.emailStatuses || {};
      const drafts = s.draftStatuses || {};
      const docs = s.documentStatuses || {};
      document.getElementById('summary').innerHTML = [
        metric('Needs attention', (email.failed || 0) + (email.partial_failure || 0) + (drafts.needs_review || 0), 'triangle-alert', 'warning'),
        metric('Failed files', docs.failed || 0, 'file-x-2', 'danger'),
        metric('Waiting to download', (docs.pending || 0) + (docs.retry_queued || 0) + (docs.retrying || 0), 'clock-3'),
        metric('Downloaded', docs.uploaded || 0, 'circle-check-big', 'success'),
        metric('Active drafts', (drafts.parsed || 0) + (drafts.needs_review || 0) + (drafts.ready_to_file || 0), 'files'),
        metric('Not downloadable', docs.not_downloadable || 0, 'file-warning'),
        metric('Plaintiff names needed', s.missingPlaintiffMappings, 'user-round-search', 'warning'),
        metric('Database', formatBytes(s.databaseBytes), 'database'),
      ].join('');
      renderIcons();
    }

    function renderLiveStatus() {
      const live = state.live;
      const dot = document.getElementById('liveDot');
      const label = document.getElementById('liveStatus');
      if (!live) {
        dot.className = 'dot';
        label.textContent = 'Live';
        label.removeAttribute('title');
        return;
      }

      dot.className = 'dot' + (live.running ? ' syncing' : '') + (live.lastError ? ' error' : '');
      if (live.dbPath) {
        label.title = 'Workflow DB: ' + live.dbPath;
      } else {
        label.removeAttribute('title');
      }
      if (live.running) {
        label.textContent = 'Syncing inbox...';
      } else if (live.lastError) {
        label.textContent = 'Sync error: ' + live.lastError;
      } else if (live.lastFinishedAt) {
        label.textContent = 'Last sync ' + fmtDate(live.lastFinishedAt) + ' · ' + live.lastSyncedEmails + ' emails';
      } else {
        label.textContent = 'Waiting for first sync';
      }
    }

    function filteredQueue() {
      return state.queue;
    }

    function renderQueueIssue(value) {
      if (!value) return '';
      const full = String(value).trim();
      const firstLine = full.split(/\r?\n/)[0];
      const preview = firstLine.length > 90 ? firstLine.slice(0, 87) + '...' : firstLine;
      return '<span class="queue-issue" title="' + escapeHtml(full) + '">' +
        escapeHtml(preview) + '</span>';
    }

    function renderQueue() {
      const items = filteredQueue();
      const root = document.getElementById('queue');
      renderPagination();
      renderSelectionBar();
      if (!items.length) {
        root.innerHTML = '<div class="empty">No queue records match the current filters.</div>';
        return;
      }

      root.innerHTML = '<table><thead><tr>' +
        '<th class="select-column"><input class="queue-checkbox" type="checkbox" data-select-page aria-label="Select all records on this page"></th>' +
        '<th style="width: 108px;">Received</th>' +
        '<th>Subject</th>' +
        '<th style="width: 104px;">Case</th>' +
        '<th style="width: 132px;">Plaintiff</th>' +
        '<th style="width: 92px;">Documents</th>' +
        '<th style="width: 172px;">Status</th>' +
        '</tr></thead><tbody>' +
        items.map(item => '<tr data-id="' + escapeHtml(item.emailId) + '" class="' +
          (item.emailId === state.selectedId ? 'selected ' : '') +
          (state.selectedIds.has(item.emailId) ? 'bulk-selected' : '') + '">' +
          '<td class="select-column"><input class="queue-checkbox" type="checkbox" data-select-email="' + escapeHtml(item.emailId) + '" ' +
            (state.selectedIds.has(item.emailId) ? 'checked' : '') + ' aria-label="Select email"></td>' +
          '<td data-label="Received"><span class="cell-secondary">' + escapeHtml(fmtDate(item.receivedAt)) + '</span></td>' +
          '<td data-label="Subject"><span class="subject-main">' + escapeHtml(item.subject || '(no subject)') + '</span><span class="cell-secondary">' + escapeHtml(item.sender || '') + '</span></td>' +
          '<td data-label="Case"><span class="subject-main">' + escapeHtml(item.caseNumber || '—') + '</span></td>' +
          '<td data-label="Plaintiff">' + renderPlaintiffCell(item) + '</td>' +
          '<td data-label="Documents">' + renderDocCount(item) + '</td>' +
          '<td data-label="Status"><div class="status-line">' + statusPill(item.processingStatus) + '</div><span class="cell-secondary">' +
            escapeHtml(item.draftStatus ? statusLabel(item.draftStatus) : '') +
            (item.validationStatus ? ' · ' + escapeHtml(statusLabel(item.validationStatus)) : '') +
          '</span>' + renderQueueIssue(item.processingError) + '</td>' +
        '</tr>').join('') +
        '</tbody></table>';

      root.querySelectorAll('tr[data-id]').forEach(row => {
        row.addEventListener('click', event => {
          if (event.target.closest('input, button, a')) return;
          selectRecord(row.dataset.id).catch(showQueueError);
        });
      });
      root.querySelectorAll('[data-select-email]').forEach(checkbox => {
        checkbox.addEventListener('change', () => {
          const emailId = checkbox.dataset.selectEmail;
          if (checkbox.checked) {
            state.selectedIds.add(emailId);
          } else {
            state.selectedIds.delete(emailId);
          }
          checkbox.closest('tr').classList.toggle('bulk-selected', checkbox.checked);
          updatePageSelectionControl(root, items);
          renderSelectionBar();
        });
      });
      const pageCheckbox = root.querySelector('[data-select-page]');
      pageCheckbox.addEventListener('change', () => {
        items.forEach(item => {
          if (pageCheckbox.checked) {
            state.selectedIds.add(item.emailId);
          } else {
            state.selectedIds.delete(item.emailId);
          }
        });
        renderQueue();
      });
      updatePageSelectionControl(root, items);
      renderIcons();
    }

    function updatePageSelectionControl(root, items) {
      const checkbox = root.querySelector('[data-select-page]');
      if (!checkbox) return;
      const selectedOnPage = items.filter(item => state.selectedIds.has(item.emailId)).length;
      checkbox.checked = items.length > 0 && selectedOnPage === items.length;
      checkbox.indeterminate = selectedOnPage > 0 && selectedOnPage < items.length;
    }

    function renderSelectionBar() {
      const count = state.selectedIds.size;
      document.getElementById('selectionBar').classList.toggle('hidden', count === 0);
      document.getElementById('selectionCount').textContent = String(count);
      renderIcons();
    }

    function renderPagination() {
      const pagination = state.pagination;
      const pageInfo = document.getElementById('pageInfo');
      const root = document.getElementById('pagination');
      document.getElementById('queueMeta').textContent =
        pagination.totalItems + ' record' + (pagination.totalItems === 1 ? '' : 's') +
        ' · Page ' + pagination.page + ' of ' + pagination.totalPages;
      const first = pagination.totalItems
        ? ((pagination.page - 1) * pagination.pageSize) + 1
        : 0;
      const last = Math.min(pagination.page * pagination.pageSize, pagination.totalItems);
      pageInfo.textContent = first + '-' + last + ' of ' + pagination.totalItems;

      const pageNumbers = new Set([1, pagination.totalPages]);
      for (let page = pagination.page - 2; page <= pagination.page + 2; page++) {
        if (page >= 1 && page <= pagination.totalPages) pageNumbers.add(page);
      }
      const sorted = Array.from(pageNumbers).sort((a, b) => a - b);
      const parts = [
        '<button type="button" data-page="' + (pagination.page - 1) + '" ' +
          (pagination.page <= 1 ? 'disabled' : '') + ' title="Previous page" aria-label="Previous page">' + icon('chevron-left') + '</button>',
      ];
      let previous = 0;
      sorted.forEach(page => {
        if (previous && page - previous > 1) parts.push('<span class="muted">...</span>');
        parts.push(
          '<button type="button" data-page="' + page + '" class="' +
          (page === pagination.page ? 'active' : '') + '">' + page + '</button>',
        );
        previous = page;
      });
      parts.push(
        '<button type="button" data-page="' + (pagination.page + 1) + '" ' +
        (pagination.page >= pagination.totalPages ? 'disabled' : '') +
        ' title="Next page" aria-label="Next page">' + icon('chevron-right') + '</button>',
      );
      root.innerHTML = parts.join('');
      renderIcons();
      root.querySelectorAll('button[data-page]').forEach(button => {
        button.addEventListener('click', () => {
          const nextPage = Number(button.dataset.page);
          if (nextPage >= 1 && nextPage <= pagination.totalPages) {
            state.pagination.page = nextPage;
            loadData().catch(showQueueError);
          }
        });
      });
    }

    function showQueueError(error) {
      document.getElementById('queue').innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + '</div>';
      showToast(error.message || String(error), 'error');
    }

    function renderDraftList() {
      const root = document.getElementById('draftList');
      renderDraftPagination();
      if (!state.drafts.length) {
        root.innerHTML = '<div class="empty">No drafts match the current filters.</div>';
        return;
      }

      root.innerHTML = '<table><thead><tr>' +
        '<th style="width: 118px;">Received</th>' +
        '<th style="width: 145px;">Case</th>' +
        '<th>Parties</th>' +
        '<th style="width: 110px;">Documents</th>' +
        '<th style="width: 110px;">Validation</th>' +
        '<th style="width: 130px;">Draft status</th>' +
        '<th style="width: 118px;">Updated</th>' +
        '</tr></thead><tbody>' +
        state.drafts.map(item => '<tr data-open-draft="' + escapeHtml(item.draftId) + '">' +
          '<td><span class="cell-secondary">' + escapeHtml(fmtDate(item.receivedAt)) + '</span></td>' +
          '<td><span class="draft-case">' + escapeHtml(item.caseNumber || 'Unassigned') + '</span>' +
            '<span class="cell-secondary">' + escapeHtml(item.subject || '(no subject)') + '</span></td>' +
          '<td><span class="draft-parties">' + escapeHtml(
            [item.plaintiff, item.defendant].filter(Boolean).join(' v. ') ||
            item.caseTitle ||
            'Parties not extracted',
          ) + '</span><span class="cell-secondary">' + escapeHtml(item.sender || '') + '</span></td>' +
          '<td><span class="draft-doc-count">' + icon('files') +
            escapeHtml(item.viewableDocumentCount + ' / ' + item.documentCount) + '</span>' +
            (item.failedDocumentCount
              ? '<span class="cell-secondary error-text">' + escapeHtml(item.failedDocumentCount) + ' failed</span>'
              : '<span class="cell-secondary">viewable</span>') + '</td>' +
          '<td>' + statusPill(item.validationStatus) + '</td>' +
          '<td>' + statusPill(item.status) + '</td>' +
          '<td><span class="cell-secondary">' + escapeHtml(fmtDate(item.updatedAt)) + '</span></td>' +
        '</tr>').join('') +
        '</tbody></table>';

      root.querySelectorAll('[data-open-draft]').forEach(row => {
        row.addEventListener('click', () => {
          openDraft(row.dataset.openDraft).catch(showDraftError);
        });
      });
      renderIcons();
    }

    function renderDraftPagination() {
      const pagination = state.draftPagination;
      const root = document.getElementById('draftPagination');
      const first = pagination.totalItems
        ? ((pagination.page - 1) * pagination.pageSize) + 1
        : 0;
      const last = Math.min(pagination.page * pagination.pageSize, pagination.totalItems);
      document.getElementById('draftMeta').textContent =
        pagination.totalItems + ' draft' + (pagination.totalItems === 1 ? '' : 's') +
        ' В· Page ' + pagination.page + ' of ' + pagination.totalPages;
      document.getElementById('draftPageInfo').textContent =
        first + '-' + last + ' of ' + pagination.totalItems;

      const pageNumbers = new Set([1, pagination.totalPages]);
      for (let page = pagination.page - 2; page <= pagination.page + 2; page++) {
        if (page >= 1 && page <= pagination.totalPages) pageNumbers.add(page);
      }
      const sorted = Array.from(pageNumbers).sort((a, b) => a - b);
      const parts = [
        '<button type="button" data-draft-page="' + (pagination.page - 1) + '" ' +
          (pagination.page <= 1 ? 'disabled' : '') +
          ' title="Previous page" aria-label="Previous page">' + icon('chevron-left') + '</button>',
      ];
      let previous = 0;
      sorted.forEach(page => {
        if (previous && page - previous > 1) parts.push('<span class="muted">...</span>');
        parts.push('<button type="button" data-draft-page="' + page + '" class="' +
          (page === pagination.page ? 'active' : '') + '">' + page + '</button>');
        previous = page;
      });
      parts.push('<button type="button" data-draft-page="' + (pagination.page + 1) + '" ' +
        (pagination.page >= pagination.totalPages ? 'disabled' : '') +
        ' title="Next page" aria-label="Next page">' + icon('chevron-right') + '</button>');
      root.innerHTML = parts.join('');
      root.querySelectorAll('[data-draft-page]').forEach(button => {
        button.addEventListener('click', () => {
          const page = Number(button.dataset.draftPage);
          if (page >= 1 && page <= pagination.totalPages) {
            state.draftPagination.page = page;
            loadDrafts().catch(showDraftError);
          }
        });
      });
      renderIcons();
    }

    async function loadDrafts(force) {
      if (state.draftLoadPromise) {
        try {
          await state.draftLoadPromise;
        } catch {
          // The caller that started the request reports the error.
        }
        if (!force) return;
      }

      const task = (async () => {
        const params = new URLSearchParams({
          page: String(state.draftPagination.page),
          pageSize: document.getElementById('draftPageSize').value,
        });
        const search = document.getElementById('draftSearch').value.trim();
        const status = document.getElementById('draftStatusFilter').value;
        const validation = document.getElementById('draftValidationFilter').value;
        const dateFrom = document.getElementById('draftDateFrom').value;
        const dateTo = document.getElementById('draftDateTo').value;
        if (search) params.set('q', search);
        if (status) params.set('status', status);
        if (validation) params.set('validation', validation);
        if (dateFrom) params.set('dateFrom', localDateBoundaryIso(dateFrom, false));
        if (dateTo) params.set('dateTo', localDateBoundaryIso(dateTo, true));

        const page = await api('/api/drafts?' + params.toString());
        state.drafts = page.items || [];
        state.draftPagination = {
          page: Number(page.page || 1),
          pageSize: Number(page.pageSize || 25),
          totalItems: Number(page.totalItems || 0),
          totalPages: Number(page.totalPages || 1),
        };
        renderDraftList();
      })();
      state.draftLoadPromise = task;
      try {
        await task;
      } finally {
        if (state.draftLoadPromise === task) state.draftLoadPromise = null;
      }
    }

    function showDraftError(error) {
      const message = error && error.message ? error.message : String(error);
      if (!state.selectedDraftId) {
        document.getElementById('draftList').innerHTML =
          '<div class="empty error-text">' + escapeHtml(message) + '</div>';
      }
      showToast(message, 'error');
    }

    async function openDraft(draftId) {
      if (!draftId) return;
      if (state.draftDirty && !window.confirm('Discard unsaved draft changes?')) return;
      const detail = await api('/api/drafts/' + encodeURIComponent(draftId));
      if (!detail.caseDraft) throw new Error('Draft data is not available');
      state.selectedDraftId = draftId;
      state.draftDetail = detail;
      state.draftDirty = false;
      const viewable = (detail.documents || []).find(document => document.oneDriveUrl);
      state.activeDraftDocumentId = viewable
        ? viewable.id
        : (detail.documents && detail.documents[0] ? detail.documents[0].id : null);
      document.getElementById('draftListView').classList.add('hidden');
      document.getElementById('draftWorkspaceView').classList.remove('hidden');
      renderDraftWorkspace();
    }

    function closeDraft() {
      if (state.draftDirty && !window.confirm('Discard unsaved draft changes?')) return;
      state.selectedDraftId = null;
      state.draftDetail = null;
      state.activeDraftDocumentId = null;
      state.draftDirty = false;
      document.getElementById('draftWorkspaceView').classList.add('hidden');
      document.getElementById('draftListView').classList.remove('hidden');
      loadDrafts(true).catch(showDraftError);
    }

    function renderDraftWorkspace() {
      const detail = state.draftDetail;
      const draft = detail && detail.caseDraft;
      if (!detail || !draft) return;
      const data = draft.editableData || {};
      const caseNumber = data.caseNumber || data.newCaseNumber ||
        data.temporaryCaseNumber || 'Unassigned draft';
      document.getElementById('draftWorkspaceCase').textContent = caseNumber;
      document.getElementById('draftWorkspaceSubject').textContent =
        detail.email.subject || '(no subject)';
      document.getElementById('draftWorkspaceStatuses').innerHTML =
        statusPill(draft.status) + statusPill(draft.validationStatus);
      document.getElementById('draftReviewerNotes').value = draft.reviewerNotes || '';
      renderDraftFields(draft);
      renderDraftDocuments(detail.documents || []);
      setDraftDirty(false);
      setDraftMobileMode(state.draftMobileMode);
      document.getElementById('draftApproveBtn').disabled =
        (draft.validationIssues || []).some(issue => issue.severity === 'error');
      renderIcons();
    }

    function renderDraftFields(draft) {
      const issues = draft.validationIssues || [];
      const issueByField = new Map(issues.map(issue => [issue.field, issue]));
      const sourceMap = draft.fieldSources || {};
      const data = draft.editableData || {};
      const filing = draft.filingData || {};
      const documents = (state.draftDetail && state.draftDetail.documents) || [];
      const validationRoot = document.getElementById('draftValidationSummary');

      if (issues.length) {
        const hasErrors = issues.some(issue => issue.severity === 'error');
        validationRoot.innerHTML = '<div class="draft-validation ' +
          (hasErrors ? 'has-errors' : '') + '">' +
          issues.map(issue => '<div class="draft-validation-row">' +
            icon(issue.severity === 'error' ? 'circle-x' : 'triangle-alert') +
            '<span>' + escapeHtml(issue.message) + '</span></div>').join('') +
          '</div>';
      } else {
        validationRoot.innerHTML = '';
      }

      const legacyGroups = DRAFT_FIELD_GROUPS.map(group =>
        '<section class="draft-field-section"><h3>' + escapeHtml(group.title) + '</h3>' +
          '<div class="draft-field-grid">' +
          group.fields.map(field => {
            const issue = issueByField.get(field.key);
            const source = sourceMap[field.key] || 'empty';
            return '<label class="draft-field ' + (field.wide ? 'wide ' : '') +
              (issue ? 'has-' + escapeHtml(issue.severity) : '') + '">' +
              '<span class="draft-field-label"><span>' + escapeHtml(field.label) + '</span>' +
                '<span class="field-source ' + escapeHtml(source) + '">' +
                  escapeHtml(DRAFT_SOURCE_LABELS[source] || source) + '</span></span>' +
              '<input type="text" data-draft-field="' + escapeHtml(field.key) + '" value="' +
                escapeHtml(data[field.key] || '') + '">' +
              (issue ? '<span class="draft-field-message">' + escapeHtml(issue.message) + '</span>' : '') +
            '</label>';
          }).join('') +
          '</div></section>'
      ).join('');

      const filingSetup =
        '<section class="draft-field-section">' +
          '<div class="draft-section-heading"><h3>MiFILE setup</h3></div>' +
          '<div class="draft-field-grid">' +
            renderDraftInput('District number', 'data-filing-field="courtDistrict"',
              filing.courtDistrict, false, 'text') +
            renderDraftSelect('Action', 'data-filing-field="action"', filing.action,
              ['Initiate a new case']) +
            renderDraftInput('Case type', 'data-filing-field="caseType"',
              filing.caseType, true, 'text', 'mifileCaseTypes') +
          '</div>' +
        '</section>';

      const caseDetails =
        '<section class="draft-field-section">' +
          '<div class="draft-section-heading"><h3>Case details</h3></div>' +
          '<div class="draft-field-grid">' +
            renderDraftSelect(
              'Related civil action',
              'data-filing-field="relatedCivilAction"',
              filing.relatedCivilAction || 'unknown',
              [
                { value: 'unknown', label: 'Review required' },
                { value: 'none', label: 'No related civil action' },
                { value: 'previously_filed', label: 'Previously filed action' },
              ],
              true,
            ) +
            renderDraftInput(
              'Claim amount',
              'data-filing-field="claimAmount"',
              filing.claimAmount,
              false,
              'number',
            ) +
            renderDraftInput(
              'Related court',
              'data-filing-field="relatedCaseCourt"',
              filing.relatedCaseCourt,
              false,
              'text',
            ) +
            renderDraftInput(
              'Related docket number',
              'data-filing-field="relatedCaseDocketNumber"',
              filing.relatedCaseDocketNumber,
              false,
              'text',
            ) +
            renderDraftInput(
              'Assigned judge',
              'data-filing-field="relatedCaseJudge"',
              filing.relatedCaseJudge,
              false,
              'text',
            ) +
            renderDraftSelect(
              'Related action status',
              'data-filing-field="relatedCasePending"',
              filing.relatedCasePending === true
                ? 'true'
                : filing.relatedCasePending === false
                  ? 'false'
                  : '',
              [
                { value: '', label: 'Not applicable / unknown' },
                { value: 'true', label: 'Pending' },
                { value: 'false', label: 'No longer pending' },
              ],
            ) +
            renderDraftCheckbox(
              'Request court service by mail',
              'data-filing-field="mailingRequested"',
              filing.mailingRequested !== false,
            ) +
            renderDraftCheckbox(
              'Complaint includes "all other occupants"',
              'data-filing-field="includeAllOtherOccupants"',
              filing.includeAllOtherOccupants === true,
            ) +
          '</div>' +
        '</section>';

      const plaintiff =
        '<section class="draft-field-section">' +
          '<div class="draft-section-heading"><h3>Plaintiff</h3></div>' +
          renderDraftParty('plaintiff', 0, filing.plaintiff || {}, 'Plaintiff', false) +
        '</section>';

      const defendants = Array.isArray(filing.defendants) ? filing.defendants : [];
      const defendantSection =
        '<section class="draft-field-section">' +
          '<div class="draft-section-heading"><h3>Defendants</h3>' +
            '<button type="button" data-add-defendant>' + icon('plus') +
              'Add Defendant</button></div>' +
          (defendants.length
            ? defendants.map((party, index) =>
              renderDraftParty(
                'defendant',
                index,
                party,
                'Defendant ' + (index + 1),
                true,
              )).join('')
            : '<div class="draft-empty-section">No Defendants have been added.</div>') +
        '</section>';

      const attorney =
        '<section class="draft-field-section">' +
          '<div class="draft-section-heading"><h3>Attorney / filer</h3></div>' +
          '<div class="draft-field-grid">' +
            renderDraftInput('Name', 'data-attorney-field="name"',
              filing.attorney && filing.attorney.name, true) +
            renderDraftInput('Bar number', 'data-attorney-field="barNumber"',
              filing.attorney && filing.attorney.barNumber) +
            renderDraftInput('Address', 'data-attorney-field="address1"',
              filing.attorney && filing.attorney.address1, true) +
            renderDraftInput('Address line 2', 'data-attorney-field="address2"',
              filing.attorney && filing.attorney.address2, true) +
            renderDraftInput('City', 'data-attorney-field="city"',
              filing.attorney && filing.attorney.city) +
            renderDraftInput('State', 'data-attorney-field="state"',
              filing.attorney && filing.attorney.state) +
            renderDraftInput('ZIP', 'data-attorney-field="postalCode"',
              filing.attorney && filing.attorney.postalCode) +
            renderDraftInput('Phone', 'data-attorney-field="phone"',
              filing.attorney && filing.attorney.phone) +
            renderDraftInput('Email', 'data-attorney-field="email"',
              filing.attorney && filing.attorney.email, true, 'email') +
          '</div>' +
        '</section>';

      const documentMappings =
        '<section class="draft-field-section">' +
          '<div class="draft-section-heading"><h3>MiFILE document types</h3></div>' +
          (documents.length
            ? documents.map((document, index) =>
              renderDraftDocumentMapping(document, index, issueByField)).join('')
            : '<div class="draft-empty-section">No documents are attached.</div>') +
        '</section>' +
        '<datalist id="mifileCaseTypes">' +
          MIFILE_CASE_TYPES.map(value => '<option value="' + escapeHtml(value) + '"></option>').join('') +
        '</datalist>' +
        '<datalist id="mifileFilingTypes">' +
          MIFILE_FILING_TYPES.map(value => '<option value="' + escapeHtml(value) + '"></option>').join('') +
        '</datalist>';

      document.getElementById('draftFieldGroups').innerHTML =
        legacyGroups + filingSetup + caseDetails + plaintiff + defendantSection +
        attorney + documentMappings;

      document.querySelectorAll(
        '#draftFieldsForm input, #draftFieldsForm select, #draftFieldsForm textarea',
      ).forEach(input => {
        input.addEventListener('input', () => setDraftDirty(true));
        input.addEventListener('change', () => setDraftDirty(true));
      });
      document.getElementById('draftReviewerNotes').oninput = () => setDraftDirty(true);
      const addDefendant = document.querySelector('[data-add-defendant]');
      if (addDefendant) {
        addDefendant.addEventListener('click', () => {
          snapshotDraftForm();
          const filingData = state.draftDetail.caseDraft.filingData;
          filingData.defendants.push({
            id: 'defendant-' + Date.now(),
            partyType: 'person',
            displayName: null,
            entityName: null,
            firstName: null,
            middleName: null,
            lastName: null,
            suffix: null,
            address1: null,
            address2: null,
            city: null,
            state: null,
            postalCode: null,
            phone: null,
            email: null,
          });
          renderDraftFields(state.draftDetail.caseDraft);
          setDraftDirty(true);
        });
      }
      document.querySelectorAll('[data-remove-defendant]').forEach(button => {
        button.addEventListener('click', () => {
          snapshotDraftForm();
          state.draftDetail.caseDraft.filingData.defendants.splice(
            Number(button.dataset.removeDefendant),
            1,
          );
          renderDraftFields(state.draftDetail.caseDraft);
          setDraftDirty(true);
        });
      });
      renderIcons();
    }

    function renderDraftInput(label, attributes, value, wide, type, listId) {
      const inputType = type || 'text';
      return '<label class="draft-field ' + (wide ? 'wide' : '') + '">' +
        '<span class="draft-field-label"><span>' + escapeHtml(label) + '</span></span>' +
        '<input type="' + escapeHtml(inputType) + '" ' + attributes +
          (inputType === 'number' ? ' min="0" step="0.01"' : '') +
          (listId ? ' list="' + escapeHtml(listId) + '"' : '') +
          ' value="' + escapeHtml(value || '') + '">' +
      '</label>';
    }

    function renderDraftSelect(label, attributes, value, options, wide) {
      const normalizedOptions = options.map(option => typeof option === 'string'
        ? { value: option, label: option }
        : option);
      return '<label class="draft-field ' + (wide ? 'wide' : '') + '">' +
        '<span class="draft-field-label"><span>' + escapeHtml(label) + '</span></span>' +
        '<select ' + attributes + '>' +
          normalizedOptions.map(option =>
            '<option value="' + escapeHtml(option.value) + '"' +
              (String(value || '') === option.value ? ' selected' : '') + '>' +
              escapeHtml(option.label) + '</option>'
          ).join('') +
        '</select>' +
      '</label>';
    }

    function renderDraftCheckbox(label, attributes, checked) {
      return '<label class="draft-field checkbox-field">' +
        '<input type="checkbox" ' + attributes + (checked ? ' checked' : '') + '>' +
        '<span>' + escapeHtml(label) + '</span>' +
      '</label>';
    }

    function renderDraftParty(role, index, party, title, removable) {
      const prefix = 'data-party-role="' + escapeHtml(role) + '" data-party-index="' +
        index + '"';
      return '<div class="draft-party" ' + prefix + '>' +
        '<div class="draft-party-title"><span>' + escapeHtml(title) + '</span>' +
          (removable
            ? '<button type="button" class="icon-button danger" data-remove-defendant="' +
              index + '" title="Remove Defendant" aria-label="Remove Defendant">' +
              icon('trash-2') + '</button>'
            : '') +
        '</div>' +
        '<div class="draft-field-grid">' +
          renderDraftSelect(
            'Party type',
            'data-party-field="partyType"',
            party.partyType || (role === 'plaintiff' ? 'entity' : 'person'),
            [
              { value: 'person', label: 'Person' },
              { value: 'entity', label: 'Entity' },
            ],
          ) +
          renderDraftInput('Original / display name', 'data-party-field="displayName"',
            party.displayName, false) +
          renderDraftInput('Entity name', 'data-party-field="entityName"',
            party.entityName, true) +
          renderDraftInput('First name', 'data-party-field="firstName"',
            party.firstName) +
          renderDraftInput('Middle name', 'data-party-field="middleName"',
            party.middleName) +
          renderDraftInput('Last name', 'data-party-field="lastName"',
            party.lastName) +
          renderDraftInput('Suffix', 'data-party-field="suffix"',
            party.suffix) +
          renderDraftInput('Address', 'data-party-field="address1"',
            party.address1, true) +
          renderDraftInput('Apartment / address line 2', 'data-party-field="address2"',
            party.address2, true) +
          renderDraftInput('City', 'data-party-field="city"', party.city) +
          renderDraftInput('State', 'data-party-field="state"', party.state) +
          renderDraftInput('ZIP', 'data-party-field="postalCode"', party.postalCode) +
          renderDraftInput('Phone', 'data-party-field="phone"', party.phone) +
          renderDraftInput('Email', 'data-party-field="email"', party.email, true, 'email') +
        '</div>' +
      '</div>';
    }

    function renderDraftDocumentMapping(document, index, issueByField) {
      const issue = issueByField.get('document.' + document.id);
      return '<div class="draft-document-mapping" data-draft-document-id="' +
        escapeHtml(document.id) + '">' +
        '<label class="draft-field">' +
          '<span class="draft-field-label" title="' +
            escapeHtml(document.currentFilename || document.documentType || '') + '">' +
            escapeHtml(document.filingName || document.currentFilename ||
              document.documentType || ('Document ' + (index + 1))) +
          '</span>' +
          '<input type="text" data-document-field="filingName" value="' +
            escapeHtml(document.filingName || document.currentFilename || '') + '">' +
          '<span class="draft-document-status">' + statusPill(document.status) +
            (document.filingTypeSource
              ? '<span>' + escapeHtml(statusLabel(document.filingTypeSource)) + ' type</span>'
              : '') + '</span>' +
        '</label>' +
        '<label class="draft-field filing-type-field ' +
          (issue ? 'has-' + escapeHtml(issue.severity) : '') + '">' +
          '<span class="draft-field-label"><span>Filing Type</span></span>' +
          '<input type="text" list="mifileFilingTypes" data-document-field="filingType" value="' +
            escapeHtml(document.filingType || '') + '">' +
          (issue
            ? '<span class="draft-field-message">' + escapeHtml(issue.message) + '</span>'
            : '') +
        '</label>' +
        '<label class="draft-document-required" title="Required for filing">' +
          '<input type="checkbox" data-document-field="requiredForFiling"' +
            (document.requiredForFiling ? ' checked' : '') + '>' +
        '</label>' +
      '</div>';
    }

    function renderDraftDocuments(documents) {
      const select = document.getElementById('draftDocumentSelect');
      if (
        state.activeDraftDocumentId &&
        !documents.some(document => document.id === state.activeDraftDocumentId)
      ) {
        state.activeDraftDocumentId = null;
      }
      if (!state.activeDraftDocumentId && documents.length) {
        const viewable = documents.find(document => document.oneDriveUrl);
        state.activeDraftDocumentId = (viewable || documents[0]).id;
      }
      select.innerHTML = documents.length
        ? documents.map((document, index) =>
          '<option value="' + escapeHtml(document.id) + '" ' +
            (document.id === state.activeDraftDocumentId ? 'selected' : '') + '>' +
            escapeHtml(document.currentFilename || document.documentType || ('Document ' + (index + 1))) +
            (document.oneDriveUrl ? '' : ' (not available)') +
          '</option>'
        ).join('')
        : '<option value="">No documents</option>';
      select.disabled = documents.length === 0;
      renderActiveDraftDocument(documents);
    }

    function renderActiveDraftDocument(documents) {
      const activeDocument = documents.find(
        item => item.id === state.activeDraftDocumentId,
      ) || null;
      const viewer = window.document.getElementById('draftPdfViewer');
      const oneDriveLink = window.document.getElementById('draftOneDriveLink');
      const sourceLink = window.document.getElementById('draftSourceLink');

      updateDraftDocumentLink(oneDriveLink, activeDocument && activeDocument.oneDriveUrl);
      updateDraftDocumentLink(sourceLink, activeDocument && activeDocument.sourceUrl);
      if (activeDocument && activeDocument.oneDriveUrl) {
        viewer.innerHTML = '<iframe title="' +
          escapeHtml(activeDocument.currentFilename || activeDocument.documentType || 'PDF document') +
          '" src="/api/documents/' + encodeURIComponent(activeDocument.id) +
          '/content?v=' + encodeURIComponent(activeDocument.updatedAt || '') + '"></iframe>';
      } else {
        viewer.innerHTML = '<div class="draft-preview-empty">' + icon('file-question') +
          '<strong>PDF preview is not available</strong>' +
          '<span>' + escapeHtml(activeDocument
            ? 'This document has not been uploaded to OneDrive.'
            : 'No documents are attached to this draft.') + '</span></div>';
      }
      renderIcons();
    }

    function updateDraftDocumentLink(link, href) {
      link.classList.toggle('is-disabled', !href);
      if (href) {
        link.href = href;
      } else {
        link.removeAttribute('href');
      }
    }

    function setDraftDirty(dirty) {
      state.draftDirty = !!dirty;
      document.getElementById('draftUnsavedBadge').classList.toggle('hidden', !dirty);
      document.getElementById('draftSaveBtn').disabled = !dirty;
    }

    function collectDraftFields() {
      const fields = {};
      document.querySelectorAll('[data-draft-field]').forEach(input => {
        fields[input.dataset.draftField] = input.value;
      });
      return fields;
    }

    function collectDraftParty(role, index) {
      const root = document.querySelector(
        '[data-party-role="' + role + '"][data-party-index="' + index + '"]',
      );
      if (!root) return null;
      const current = role === 'plaintiff'
        ? state.draftDetail.caseDraft.filingData.plaintiff
        : state.draftDetail.caseDraft.filingData.defendants[index];
      const party = { ...(current || {}) };
      root.querySelectorAll('[data-party-field]').forEach(input => {
        party[input.dataset.partyField] = input.value;
      });
      return party;
    }

    function collectDraftFilingData() {
      const current = state.draftDetail.caseDraft.filingData || {};
      const result = {
        ...current,
        plaintiff: collectDraftParty('plaintiff', 0),
        defendants: [],
        attorney: { ...(current.attorney || {}) },
      };
      document.querySelectorAll('[data-party-role="defendant"]').forEach(root => {
        const index = Number(root.dataset.partyIndex);
        const party = collectDraftParty('defendant', index);
        if (party) result.defendants.push(party);
      });
      document.querySelectorAll('[data-filing-field]').forEach(input => {
        const key = input.dataset.filingField;
        if (input.type === 'checkbox') {
          result[key] = input.checked;
        } else if (key === 'relatedCasePending') {
          result[key] = input.value === '' ? null : input.value === 'true';
        } else {
          result[key] = input.value;
        }
      });
      document.querySelectorAll('[data-attorney-field]').forEach(input => {
        result.attorney[input.dataset.attorneyField] = input.value;
      });
      return result;
    }

    function collectDraftDocumentMappings() {
      return Array.from(document.querySelectorAll('[data-draft-document-id]')).map(
        (root, index) => {
          const filingName = root.querySelector('[data-document-field="filingName"]');
          const filingType = root.querySelector('[data-document-field="filingType"]');
          const required = root.querySelector('[data-document-field="requiredForFiling"]');
          return {
            id: root.dataset.draftDocumentId,
            filingName: filingName ? filingName.value : '',
            filingType: filingType ? filingType.value : '',
            filingSequence: index + 1,
            requiredForFiling: required ? required.checked : true,
          };
        },
      );
    }

    function snapshotDraftForm() {
      if (!state.draftDetail || !state.draftDetail.caseDraft) return;
      Object.assign(state.draftDetail.caseDraft.editableData, collectDraftFields());
      state.draftDetail.caseDraft.filingData = collectDraftFilingData();
      const mappings = new Map(
        collectDraftDocumentMappings().map(mapping => [mapping.id, mapping]),
      );
      state.draftDetail.documents.forEach(document => {
        const mapping = mappings.get(document.id);
        if (!mapping) return;
        document.filingName = mapping.filingName;
        document.filingType = mapping.filingType;
        document.filingSequence = mapping.filingSequence;
        document.requiredForFiling = mapping.requiredForFiling;
      });
    }

    async function saveDraft(silent) {
      const detail = state.draftDetail;
      if (!detail || !detail.caseDraft) return;
      const button = document.getElementById('draftSaveBtn');
      setButtonBusy(button, true, 'Saving');
      let saved = false;
      try {
        state.draftDetail = await api('/api/drafts/' +
          encodeURIComponent(detail.caseDraft.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: collectDraftFields(),
            filingData: collectDraftFilingData(),
            documents: collectDraftDocumentMappings(),
            reviewerNotes: document.getElementById('draftReviewerNotes').value,
          }),
        });
        state.draftDirty = false;
        saved = true;
        renderDraftWorkspace();
        await loadDrafts(true);
        if (!silent) showToast('Draft changes saved.');
      } finally {
        setButtonBusy(button, false);
        setDraftDirty(saved ? false : true);
      }
    }

    async function reviewDraft(action) {
      const detail = state.draftDetail;
      if (!detail || !detail.caseDraft) return;
      if (action === 'reject' && !window.confirm('Reject this draft?')) return;
      if (state.draftDirty) await saveDraft(true);

      await api('/api/cases/' + encodeURIComponent(detail.caseDraft.id) + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          notes: document.getElementById('draftReviewerNotes').value,
        }),
      });
      state.draftDetail = await api('/api/drafts/' +
        encodeURIComponent(detail.caseDraft.id));
      renderDraftWorkspace();
      await loadDrafts(true);
      showToast(action === 'approve' ? 'Draft approved.' : 'Draft rejected.');
    }

    function setDraftMobileMode(mode) {
      state.draftMobileMode = mode === 'fields' ? 'fields' : 'document';
      document.querySelectorAll('[data-draft-mobile-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.draftMobileMode === state.draftMobileMode);
      });
      document.getElementById('draftDocumentPanel').classList.toggle(
        'mobile-active',
        state.draftMobileMode === 'document',
      );
      document.getElementById('draftFieldsPanel').classList.toggle(
        'mobile-active',
        state.draftMobileMode === 'fields',
      );
      const activePanel = document.getElementById(
        state.draftMobileMode === 'fields' ? 'draftFieldsPanel' : 'draftDocumentPanel',
      );
      if (window.matchMedia('(max-width: 820px)').matches) {
        activePanel.scrollTop = 0;
      }
      renderIcons();
    }

    function resetDraftPageAndLoad() {
      state.draftPagination.page = 1;
      loadDrafts(true).catch(showDraftError);
    }

    function renderPlaintiffCell(item) {
      if (!item.plaintiffName) return '';
      const primary = item.plaintiffShortName || item.plaintiffName;
      const secondary = item.plaintiffShortName ? item.plaintiffName : item.plaintiffMappingStatus;
      return '<span class="plaintiff-main">' + escapeHtml(primary) + '</span>' +
        '<span class="cell-secondary">' + escapeHtml(item.plaintiffShortName ? secondary : statusLabel(secondary)) + '</span>';
    }

    function renderPlaintiffMappingStatus(mapping) {
      if (!mapping || mapping.status === 'unknown') return statusPill('unknown');
      if (mapping.status === 'mapped') {
        return statusPill('mapped') + ' <b>' + escapeHtml(mapping.shortName || '') + '</b><br><span class="muted">' + escapeHtml(mapping.fullName || '') + '</span>';
      }
      return statusPill(mapping.status) + '<br><span class="muted">' + escapeHtml(mapping.fullName || '') + '</span>';
    }

    async function loadPlaintiffMappings() {
      state.plaintiffMappings = await api('/api/plaintiff-mappings');
      renderPlaintiffMappings();
    }

    function filteredMappings() {
      const q = document.getElementById('mappingSearch').value.trim().toLowerCase();
      const rows = state.plaintiffMappings.mappings || [];
      if (!q) return rows;
      return rows.filter(row => [
        row.fullName,
        row.shortName,
        row.status,
      ].some(value => String(value || '').toLowerCase().includes(q)));
    }

    function renderPlaintiffMappings() {
      const mappings = filteredMappings();
      const missing = state.plaintiffMappings.missing || [];
      document.getElementById('mappingSummary').innerHTML = [
        metric('Active mappings', (state.plaintiffMappings.mappings || []).filter(row => row.status === 'active').length, 'badge-check', 'success'),
        metric('Need short name', (state.plaintiffMappings.mappings || []).filter(row => row.status === 'needs_short_name').length, 'user-round-search', 'warning'),
        metric('Inactive mappings', (state.plaintiffMappings.mappings || []).filter(row => row.status === 'inactive').length, 'circle-pause'),
        metric('Missing mappings', missing.length, 'circle-alert', 'danger'),
        metric('Mapped usages', (state.plaintiffMappings.mappings || []).reduce((sum, row) => sum + Number(row.usageCount || 0), 0), 'files'),
      ].join('');
      document.getElementById('mappingMeta').textContent =
        mappings.length + ' mapping' + (mappings.length === 1 ? '' : 's');
      document.getElementById('missingMappingMeta').textContent =
        missing.length + ' candidate' + (missing.length === 1 ? '' : 's');

      const mappingsRoot = document.getElementById('mappingsList');
      mappingsRoot.innerHTML = mappings.length ? '<div class="table-scroll"><table><thead><tr>' +
        '<th>Full Plaintiff</th>' +
        '<th style="width: 145px;">Short Name</th>' +
        '<th style="width: 112px;">Status</th>' +
        '<th style="width: 146px;">Actions</th>' +
        '</tr></thead><tbody>' +
        mappings.map(renderPlaintiffMappingRow).join('') +
        '</tbody></table></div>' : '<div class="empty">No mappings.</div>';

      const missingRoot = document.getElementById('missingMappingsList');
      missingRoot.innerHTML = missing.length ? '<div class="table-scroll"><table><thead><tr>' +
        '<th>Full Plaintiff</th>' +
        '<th style="width: 74px;">Usage</th>' +
        '<th style="width: 118px;">Last Used</th>' +
        '<th style="width: 82px;">Action</th>' +
        '</tr></thead><tbody>' +
        missing.map(row => '<tr>' +
          '<td><span class="mapping-name">' + escapeHtml(row.fullName) + '</span></td>' +
          '<td>' + escapeHtml(row.usageCount || 0) + '</td>' +
          '<td>' + escapeHtml(fmtDate(row.lastUsedAt)) + '</td>' +
          '<td><button type="button" data-use-plaintiff="' + escapeHtml(row.fullName) + '">' + icon('plus') + 'Map</button></td>' +
        '</tr>').join('') +
        '</tbody></table></div>' : '<div class="empty">No missing mappings.</div>';

      bindMappingActions();
      renderIcons();
    }

    function renderPlaintiffMappingRow(row) {
      const editing = state.editingMappingId === row.id;
      const id = escapeHtml(row.id);
      const fullName = editing
        ? '<input data-inline-full-name type="text" value="' + escapeHtml(row.fullName) + '">'
        : '<span class="mapping-name">' + escapeHtml(row.fullName) + '</span>' +
          '<span class="cell-secondary">' + escapeHtml(row.usageCount || 0) + ' usage' +
          (Number(row.usageCount || 0) === 1 ? '' : 's') +
          (row.lastUsedAt ? ' · Last used ' + escapeHtml(fmtDate(row.lastUsedAt)) : '') +
          '</span>';
      const shortName = editing
        ? '<input data-inline-short-name type="text" value="' + escapeHtml(row.shortName) + '" placeholder="Short name">'
        : (row.shortName
          ? '<span class="mapping-short">' + escapeHtml(row.shortName) + '</span>'
          : '<span class="muted">Not set</span>');
      const actions = editing
        ? '<button type="button" class="primary icon-button" data-save-inline-mapping="' + id + '" title="Save mapping" aria-label="Save mapping">' + icon('check') + '</button>' +
          '<button type="button" class="ghost icon-button" data-cancel-inline-mapping="' + id + '" title="Cancel editing" aria-label="Cancel editing">' + icon('x') + '</button>'
        : '<button type="button" class="icon-button" data-edit-mapping="' + id + '" title="Edit mapping" aria-label="Edit mapping">' + icon('pencil') + '</button>' +
          (row.shortName ? '<button type="button" class="icon-button" data-clear-short-name="' + id + '" title="Remove short name" aria-label="Remove short name">' + icon('eraser') + '</button>' : '') +
          (row.shortName ? '<button type="button" class="icon-button" data-toggle-mapping="' + id + '" data-active="' + escapeHtml(!row.isActive) + '" title="' + escapeHtml(row.isActive ? 'Deactivate mapping' : 'Activate mapping') + '" aria-label="' + escapeHtml(row.isActive ? 'Deactivate mapping' : 'Activate mapping') + '">' + icon(row.isActive ? 'circle-pause' : 'circle-play') + '</button>' : '') +
          (row.isActive && row.shortName ? '<button type="button" class="icon-button" data-apply-plaintiff-files="' + id + '" title="Apply to existing OneDrive files" aria-label="Apply to existing OneDrive files">' + icon('files') + '</button>' : '');

      return '<tr data-mapping-row="' + id + '">' +
        '<td>' + fullName + '</td>' +
        '<td>' + shortName + '</td>' +
        '<td>' + statusPill(row.status || (row.isActive ? 'active' : 'inactive')) + '</td>' +
        '<td><div class="table-actions">' + actions + '</div></td>' +
      '</tr>';
    }

    function bindMappingActions() {
      document.querySelectorAll('[data-edit-mapping]').forEach(button => {
        button.addEventListener('click', () => {
          state.editingMappingId = button.dataset.editMapping || null;
          renderPlaintiffMappings();
          const input = document.querySelector('[data-mapping-row="' + state.editingMappingId + '"] [data-inline-full-name]');
          if (input) input.focus();
        });
      });

      document.querySelectorAll('[data-save-inline-mapping]').forEach(button => {
        button.addEventListener('click', () => {
          saveInlineMapping(button.dataset.saveInlineMapping).catch(showMappingError);
        });
      });

      document.querySelectorAll('[data-cancel-inline-mapping]').forEach(button => {
        button.addEventListener('click', () => {
          state.editingMappingId = null;
          renderPlaintiffMappings();
        });
      });

      document.querySelectorAll('[data-clear-short-name]').forEach(button => {
        button.addEventListener('click', () => {
          clearPlaintiffShortName(button.dataset.clearShortName).catch(showMappingError);
        });
      });

      document.querySelectorAll('[data-toggle-mapping]').forEach(button => {
        button.addEventListener('click', () => {
          setMappingActive(button.dataset.toggleMapping, button.dataset.active === 'true').catch(showMappingError);
        });
      });

      document.querySelectorAll('[data-apply-plaintiff-files]').forEach(button => {
        button.addEventListener('click', () => {
          applyPlaintiffFiles(button.dataset.applyPlaintiffFiles).catch(showMappingError);
        });
      });

      document.querySelectorAll('[data-use-plaintiff]').forEach(button => {
        button.addEventListener('click', () => fillMappingForm({
          fullName: button.dataset.usePlaintiff || '',
          shortName: '',
        }));
      });
    }

    function fillMappingForm(row) {
      document.getElementById('mappingFullName').value = row.fullName || '';
      document.getElementById('mappingShortName').value = row.shortName || '';
      document.getElementById('mappingFullName').focus();
    }

    function clearMappingForm() {
      fillMappingForm({ fullName: '', shortName: '' });
      document.getElementById('mappingFullName').focus();
    }

    function showMappingError(error) {
      document.getElementById('mappingsList').innerHTML = '<div class="empty error-text">' + escapeHtml(error.message || error) + '</div>';
      showToast(error.message || String(error), 'error');
    }

    async function addMapping() {
      const payload = {
        fullName: document.getElementById('mappingFullName').value,
        shortName: document.getElementById('mappingShortName').value,
        isActive: true,
      };
      await api('/api/plaintiff-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      clearMappingForm();
      await Promise.all([loadPlaintiffMappings(), loadData()]);
      showToast('Plaintiff mapping added.');
    }

    async function saveInlineMapping(id) {
      if (!id) return;
      const row = document.querySelector('[data-mapping-row="' + id + '"]');
      if (!row) return;
      const fullName = row.querySelector('[data-inline-full-name]').value;
      const shortName = row.querySelector('[data-inline-short-name]').value;
      const current = (state.plaintiffMappings.mappings || []).find(item => item.id === id);
      await api('/api/plaintiff-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          fullName,
          shortName,
          isActive: current ? current.isActive : true,
        }),
      });
      state.editingMappingId = null;
      await Promise.all([loadPlaintiffMappings(), loadData()]);
      showToast(shortName.trim() ? 'Plaintiff mapping saved.' : 'Plaintiff short name removed.');
    }

    async function clearPlaintiffShortName(id) {
      if (!id) return;
      const mapping = (state.plaintiffMappings.mappings || []).find(item => item.id === id);
      if (!mapping || !window.confirm('Remove the short name for ' + mapping.fullName + '? The Plaintiff record and history will remain.')) return;
      await api('/api/plaintiff-mappings/' + encodeURIComponent(id) + '/short-name', {
        method: 'DELETE',
      });
      if (state.editingMappingId === id) state.editingMappingId = null;
      await Promise.all([loadPlaintiffMappings(), loadData()]);
      showToast('Plaintiff short name removed.');
    }

    async function setMappingActive(id, isActive) {
      if (!id) return;
      await api('/api/plaintiff-mappings/' + encodeURIComponent(id) + '/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      await Promise.all([loadPlaintiffMappings(), loadData()]);
      showToast(isActive ? 'Plaintiff mapping activated.' : 'Plaintiff mapping deactivated.');
    }

    async function applyPlaintiffFiles(id) {
      if (!id) return;
      await api('/api/plaintiff-mappings/' + encodeURIComponent(id) + '/apply-existing-files', {
        method: 'POST',
      });
      await Promise.all([loadPlaintiffMappings(), loadData()]);
      showToast('Existing OneDrive filenames updated.');
    }

    function renderDocCount(item) {
      const expected = Number(item.expectedDocumentCount || 0);
      const uploaded = Number(item.oneDriveDocumentCount || item.uploadedDocumentCount || 0);
      const pending = Number(item.pendingDocumentCount || 0);
      const retryQueued = Number(item.retryQueuedDocumentCount || 0);
      const retrying = Number(item.retryingDocumentCount || 0);
      const failed = Number(item.failedDocumentCount || 0);
      const notDownloadable = Number(item.notDownloadableDocumentCount || 0);
      if (!expected) {
        return '<span class="cell-secondary">' +
          (notDownloadable
            ? escapeHtml(notDownloadable) + ' not downloadable'
            : 'No files') +
        '</span>';
      }
      const percent = Math.min(Math.max(Math.round((uploaded / expected) * 100), 0), 100);
      const parts = [];
      if (pending) parts.push(escapeHtml(pending) + ' pending');
      if (retryQueued) parts.push(escapeHtml(retryQueued) + ' queued');
      if (retrying) parts.push(escapeHtml(retrying) + ' retrying');
      if (failed) parts.push('<span class="error-text">' + escapeHtml(failed) + ' failed</span>');
      if (notDownloadable) parts.push(escapeHtml(notDownloadable) + ' not downloadable');
      const progressTone = failed ? ' has-failure' : (pending || retryQueued || retrying ? ' in-progress' : '');
      return '<div class="document-progress">' +
        '<div class="document-progress-head"><strong>' + escapeHtml(uploaded) + ' / ' + escapeHtml(expected) + '</strong><span class="muted">' + percent + '%</span></div>' +
        '<div class="progress-track"><span class="progress-fill' + progressTone + '" style="width: ' + percent + '%"></span></div>' +
        (parts.length ? '<div class="document-flags">' + parts.join(' · ') + '</div>' : '') +
      '</div>';
    }

    function renderDetail() {
      const root = document.getElementById('detail');
      const retryBtn = document.getElementById('retryBtn');
      const deleteBtn = document.getElementById('deleteEmailBtn');
      const detailContext = document.getElementById('detailContext');
      const detail = state.detail;
      const hasActiveRetry = detail && detail.documents.some(doc =>
        ['retry_queued', 'retrying'].includes(doc.status)
      );
      retryBtn.disabled = !detail ||
        detail.email.processingStatus === 'processing' ||
        hasActiveRetry;
      deleteBtn.disabled = !detail ||
        detail.email.processingStatus === 'processing' ||
        hasActiveRetry;

      if (!detail) {
        detailContext.textContent = 'No record selected';
        root.innerHTML = '<div class="detail-empty">' +
          '<span class="detail-empty-icon">' + icon('mouse-pointer-2') + '</span>' +
          '<b>No record selected</b>' +
        '</div>';
        renderIcons();
        return;
      }

      const email = detail.email;
      const draft = detail.caseDraft;
      detailContext.textContent = statusLabel(email.processingStatus) + ' · ' + fmtDate(email.receivedAt);
      root.innerHTML =
        '<div class="detail-hero">' +
          '<div class="status-line">' + statusPill(email.processingStatus) + '</div>' +
          '<div class="detail-subject">' + escapeHtml(email.subject || '(no subject)') + '</div>' +
          '<div class="detail-meta">' +
            '<span>' + icon('mail') + escapeHtml(email.sender || 'Unknown sender') + '</span>' +
            '<span>' + icon('calendar-clock') + escapeHtml(fmtDate(email.receivedAt)) + '</span>' +
            '<span>' + icon('repeat-2') + escapeHtml(email.processingAttempts || 0) + ' attempt' + (Number(email.processingAttempts || 0) === 1 ? '' : 's') + '</span>' +
          '</div>' +
          (email.processingError ? '<div class="error-callout">' + icon('triangle-alert') + '<div>' + escapeHtml(email.processingError) + '</div></div>' : '') +
        '</div>' +
        (draft ? '<div class="detail-section">' +
          '<div class="detail-section-title"><span>' + icon('file-text') + 'Draft</span></div>' +
          '<div class="draft-status-grid">' +
            '<div class="draft-status-item"><span>Draft status</span>' + statusPill(draft.status) + '</div>' +
            '<div class="draft-status-item"><span>Validation</span>' + statusPill(draft.validationStatus) + '</div>' +
            '<div class="draft-status-item"><span>Filing</span>' + statusPill(draft.filingStatus) + '</div>' +
          '</div>' +
          '<div class="kv">' +
            '<b>Workflow</b><div>' + escapeHtml(statusLabel(draft.workflowMode)) + '</div>' +
            '<b>Plaintiff mapping</b><div>' + renderPlaintiffMappingStatus(detail.plaintiffMapping) + '</div>' +
            '<b>OneDrive names</b><div>' + renderPlaintiffFilenameMapping(detail.plaintiffFilenameMapping) + '</div>' +
          '</div>' +
          '<details class="collapsible">' +
            '<summary>' + icon('braces') + 'Parsed data</summary>' +
            '<pre>' + escapeHtml(formatJson(draft.normalizedDataJson)) + '</pre>' +
          '</details>' +
          renderReviewControls(draft) +
        '</div>' : '') +
        '<div class="detail-section">' +
          '<div class="detail-section-title"><span>' + icon('files') + 'Documents</span><span class="muted">' + escapeHtml(detail.documents.length) + '</span></div>' +
          renderDocumentSummary(detail.documents) +
          (detail.documents.length ? detail.documents.map(doc => '<div class="doc">' +
            '<div class="doc-title"><b>' + escapeHtml(doc.currentFilename || doc.originalFilename || doc.documentType || 'Document') + '</b><div class="doc-actions">' + statusPill(doc.status) + renderDocumentRetryAction(doc) + '</div></div>' +
            '<div class="cell-secondary">' + escapeHtml(doc.documentType || 'Document') + (doc.storagePath ? ' · ' + escapeHtml(doc.storagePath) : '') + '</div>' +
            renderDocumentLinks(doc) +
            renderDocumentRetryInfo(doc, detail.retryPolicy) +
            (doc.errorMessage ? '<div class="error-callout">' + icon('circle-alert') + '<div>' + escapeHtml(doc.errorMessage) + '</div></div>' : '') +
            renderDocumentFailureLog(doc) +
          '</div>').join('') : '<div class="empty">No documents recorded.</div>') +
        '</div>' +
        '<details class="detail-section activity-section">' +
          '<summary class="detail-section-title"><span>' + icon('history') + 'Activity log</span><span class="muted">' + escapeHtml(detail.auditLogs.length) + '</span></summary>' +
          (detail.auditLogs.length ? '<div class="audit-list">' + detail.auditLogs.map(log => '<div class="audit">' +
            '<b>' + escapeHtml(statusLabel(log.action)) + '</b><br>' +
            '<span class="muted">' + escapeHtml(fmtDate(log.createdAt)) + ' · ' + escapeHtml(statusLabel(log.entityType)) + '</span>' +
          '</div>').join('') + '</div>' : '<div class="empty">No activity recorded.</div>') +
        '</details>';

      bindDetailActions();
      renderIcons();
    }

    function renderReviewControls(draft) {
      return '<div class="collapsible">' +
        '<div class="detail-section-title"><span>' + icon('clipboard-check') + 'Review</span></div>' +
        '<textarea id="reviewerNotes" placeholder="Reviewer note">' + escapeHtml(draft.reviewerNotes || '') + '</textarea>' +
        '<div class="review-actions">' +
          '<button type="button" data-open-detail-draft="' + escapeHtml(draft.id) + '">' + icon('panel-right-open') + 'Open editor</button>' +
          '<button type="button" data-review-action="save_note">' + icon('save') + 'Save note</button>' +
          '<button type="button" data-review-action="move_to_review">' + icon('clipboard-list') + 'Review</button>' +
          '<button type="button" class="primary" data-review-action="approve">' + icon('check') + 'Approve</button>' +
          '<button type="button" class="danger" data-review-action="reject">' + icon('x') + 'Reject</button>' +
        '</div>' +
      '</div>';
    }

    function renderPlaintiffFilenameMapping(mapping) {
      if (!mapping || !mapping.shortName) return '<span class="muted">No active short name</span>';
      const total = Number(mapping.eligibleDocumentCount || 0);
      const applied = Number(mapping.appliedDocumentCount || 0);
      const needsApplication = Number(mapping.needsApplicationCount || 0);
      if (!total) return '<span class="muted">No OneDrive files</span>';
      if (needsApplication) {
        return statusPill('needs_application') + ' <span class="muted">' + escapeHtml(needsApplication) + ' of ' + escapeHtml(total) + ' file(s) still use the full name</span>';
      }
      return statusPill('applied') + ' <span class="muted">' + escapeHtml(applied) + ' of ' + escapeHtml(total) + ' file(s) use ' + escapeHtml(mapping.shortName) + '</span>';
    }

    function bindDetailActions() {
      document.querySelectorAll('[data-retry-document]').forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          retryDocument(button.dataset.retryDocument).catch(showQueueError);
        });
      });

      const draft = state.detail && state.detail.caseDraft;
      if (!draft) return;

      document.querySelectorAll('[data-open-detail-draft]').forEach(button => {
        button.addEventListener('click', () => {
          setView('drafts');
          openDraft(button.dataset.openDetailDraft).catch(showDraftError);
        });
      });
      document.querySelectorAll('[data-review-action]').forEach(button => {
        button.addEventListener('click', () => {
          submitReviewAction(button.dataset.reviewAction).catch(showQueueError);
        });
      });
    }

    function renderDocumentSummary(documents) {
      if (!documents.length) return '';
      const expected = documents.filter(doc => ['pending', 'retry_queued', 'retrying', 'uploaded', 'failed'].includes(doc.status)).length;
      const uploaded = documents.filter(doc => doc.oneDriveUrl || doc.status === 'uploaded').length;
      const failed = documents.filter(doc => doc.status === 'failed').length;
      const pending = documents.filter(doc => doc.status === 'pending').length;
      const retryQueued = documents.filter(doc => doc.status === 'retry_queued').length;
      const retrying = documents.filter(doc => doc.status === 'retrying').length;
      const notDownloadable = documents.filter(doc => doc.status === 'not_downloadable').length;
      const percent = expected ? Math.min(Math.round((uploaded / expected) * 100), 100) : 0;
      const progressTone = failed ? ' has-failure' : (pending || retryQueued || retrying ? ' in-progress' : '');
      return '<div class="document-summary">' +
        '<div class="document-summary-head"><strong>' + escapeHtml(uploaded) + ' / ' + escapeHtml(expected) + '</strong><span class="muted">downloaded</span></div>' +
        '<div class="progress-track"><span class="progress-fill' + progressTone + '" style="width: ' + percent + '%"></span></div>' +
        '<div class="document-summary-meta">' +
          (pending ? '<span>' + escapeHtml(pending) + ' pending</span>' : '') +
          (retryQueued ? '<span>' + escapeHtml(retryQueued) + ' queued</span>' : '') +
          (retrying ? '<span>' + escapeHtml(retrying) + ' retrying</span>' : '') +
          (failed ? '<span class="error-text">' + escapeHtml(failed) + ' failed</span>' : '') +
          (notDownloadable ? '<span>' + escapeHtml(notDownloadable) + ' not downloadable</span>' : '') +
        '</div>' +
      '</div>';
    }

    function renderDocumentRetryAction(doc) {
      if (!['pending', 'failed'].includes(doc.status) || !doc.sourceUrl) return '';
      return '<button type="button" class="icon-button" data-retry-document="' + escapeHtml(doc.id) + '" title="Retry document download" aria-label="Retry document download">' + icon('rotate-cw') + '</button>';
    }

    function renderDocumentRetryInfo(doc, policy) {
      const parts = ['Download attempts: ' + escapeHtml(doc.downloadAttempts || 0)];
      const maxRetries = Number(policy && policy.maxAutomaticRetries || 0);
      if (maxRetries) {
        parts.push('Automatic retries: ' + escapeHtml(doc.automaticRetryCount || 0) + ' / ' + escapeHtml(maxRetries));
      }
      if (doc.status === 'retrying') {
        parts.push('Retry in progress');
      } else if (doc.status === 'retry_queued') {
        parts.push('Manual retry queued');
      } else if (doc.status === 'pending') {
        parts.push('Waiting for the download worker');
      } else if (doc.nextRetryAt) {
        parts.push('Next automatic retry: ' + escapeHtml(fmtDate(doc.nextRetryAt)));
      } else if (doc.status === 'failed' && maxRetries && Number(doc.automaticRetryCount || 0) >= maxRetries) {
        parts.push('Automatic retry limit reached; use the retry button to try again');
      }
      return '<div class="muted retry-info">' + parts.join(' &middot; ') + '</div>';
    }

    function renderDocumentFailureLog(doc) {
      const entries = Array.isArray(doc.failureLog) ? doc.failureLog : [];
      if (!entries.length) return '';
      const lines = entries.map(entry =>
        'Attempt ' + escapeHtml(entry.attempt || 0) +
        ' · ' + escapeHtml(fmtDate(entry.at)) +
        ' · ' + escapeHtml(entry.stage || 'download') +
        '\n' + escapeHtml(entry.message || 'Unknown failure')
      ).join('\n\n');
      return '<details class="failure-log" open>' +
        '<summary>' + icon('terminal') + 'Failure log (' + escapeHtml(entries.length) + ')</summary>' +
        '<pre>' + lines + '</pre>' +
      '</details>';
    }

    function renderDocumentLinks(doc) {
      const links = [];
      if (doc.oneDriveUrl) {
        links.push('<a class="doc-link" href="' + escapeHtml(doc.oneDriveUrl) + '" target="_blank" rel="noreferrer">' + icon('cloud') + 'OneDrive</a>');
      }
      if (doc.sourceUrl && /^https?:\/\//i.test(doc.sourceUrl)) {
        const sourceLabel = doc.sourceUrl.includes('truecertify.com')
          ? 'TrueCertify'
          : doc.sourceUrl.includes('mifile.courts.michigan.gov')
            ? 'MiFILE'
            : 'Source file';
        links.push('<a class="doc-link" href="' + escapeHtml(doc.sourceUrl) + '" target="_blank" rel="noreferrer">' + icon('download') + escapeHtml(sourceLabel) + '</a>');
      } else if (doc.sourceUrl && doc.sourceUrl.startsWith('email-attachment://')) {
        links.push('<span class="source-label">' + icon('paperclip') + 'Email attachment</span>');
      }
      if (!links.length && doc.fileUrl) {
        links.push('<a class="doc-link" href="' + escapeHtml(doc.fileUrl) + '" target="_blank" rel="noreferrer">' + icon('external-link') + 'Legacy file</a>');
      }
      return links.length ? '<div class="doc-links">' + links.join('') + '</div>' : '';
    }

    function formatJson(value) {
      if (!value) return '';
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value;
      }
    }

    async function selectRecord(id) {
      state.selectedId = id;
      state.detail = await api('/api/emails/' + encodeURIComponent(id));
      renderQueue();
      renderDetail();
      if (window.matchMedia('(max-width: 1100px)').matches) {
        document.getElementById('detailPane').scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }
    }

    async function retrySelected() {
      if (!state.selectedId || !state.detail) return;
      if (state.detail.email.processingStatus === 'processed') {
        const confirmed = window.confirm(
          'Reprocess this completed email?\n\n' +
          'The worker will parse it again and may upload new document copies to OneDrive.',
        );
        if (!confirmed) return;
      }
      await api('/api/emails/' + encodeURIComponent(state.selectedId) + '/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Queued from admin UI' }),
      });
      await loadData(true);
      await selectRecord(state.selectedId);
      showToast('Email reprocessing queued.');
    }

    async function retrySelectedEmails() {
      const emailIds = Array.from(state.selectedIds);
      if (!emailIds.length) return;
      const confirmed = window.confirm(
        'Reprocess ' + emailIds.length + ' selected email(s)?\n\n' +
        'Each email will be parsed again and may upload new document copies to OneDrive. ' +
        'Emails already processing or retrying will be skipped.',
      );
      if (!confirmed) return;

      const result = await api('/api/emails/bulk-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailIds,
          reason: 'Queued from bulk admin action',
        }),
      });
      result.succeeded.forEach(emailId => state.selectedIds.delete(emailId));
      await loadData(true);
      renderSelectionBar();
      if (result.failed.length) {
        showToast(
          result.succeeded.length + ' queued; ' + result.failed.length +
          ' skipped. ' + result.failed[0].error,
          'error',
        );
      } else {
        showToast(result.succeeded.length + ' email(s) queued for reprocessing.');
      }
    }

    async function deleteSelectedEmails() {
      const emailIds = Array.from(state.selectedIds);
      if (!emailIds.length) return;
      const confirmed = window.confirm(
        'Delete ' + emailIds.length + ' selected email record(s) from the admin database?\n\n' +
        'The original mailbox messages and all OneDrive files will be kept. ' +
        'Emails currently processing or retrying will be skipped.',
      );
      if (!confirmed) return;

      const result = await api('/api/emails/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailIds, confirm: true }),
      });
      result.succeeded.forEach(emailId => state.selectedIds.delete(emailId));
      if (state.selectedId && result.succeeded.includes(state.selectedId)) {
        state.selectedId = null;
        state.detail = null;
        renderDetail();
      }
      await loadData(true);
      renderSelectionBar();
      if (result.failed.length) {
        showToast(
          result.succeeded.length + ' deleted; ' + result.failed.length +
          ' skipped. ' + result.failed[0].error,
          'error',
        );
      } else {
        showToast(
          result.totals.emailRecords + ' email record(s) deleted. OneDrive files were kept.',
        );
      }
    }

    function clearSelectedEmails() {
      state.selectedIds.clear();
      renderQueue();
    }

    async function deleteSelectedEmail() {
      if (!state.selectedId || !state.detail) return;
      const subject = state.detail.email.subject || '(no subject)';
      const confirmed = window.confirm(
        'Delete "' + subject + '" and its related records from this database?\n\n' +
        'Files in OneDrive will not be deleted.',
      );
      if (!confirmed) return;

      await api('/api/emails/' + encodeURIComponent(state.selectedId), {
        method: 'DELETE',
      });
      state.selectedId = null;
      state.detail = null;
      renderDetail();
      await loadData(true);
      showToast('Email record deleted. OneDrive files were kept.');
    }

    async function purgeOlderEmails() {
      const dateInput = document.getElementById('deleteBeforeDate');
      const beforeDate = dateInput.value;
      if (!beforeDate) {
        showToast('Choose a cutoff date first.', 'error');
        return;
      }

      const preview = await api('/api/emails/purge-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beforeDate }),
      });
      if (!preview.emailRecords) {
        showToast('No eligible records were found before this date.');
        return;
      }

      const confirmed = window.confirm(
        'Delete ' + preview.emailRecords + ' database record(s) before ' + beforeDate + '?\n\n' +
        'Processing and active retry records are protected. OneDrive files will not be deleted.',
      );
      if (!confirmed) return;

      const result = await api('/api/emails/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beforeDate, confirm: true }),
      });
      state.selectedId = null;
      state.detail = null;
      state.pagination.page = 1;
      renderDetail();
      await loadData(true);
      showToast(
        'Deleted ' + result.emailRecords + ' email record(s), ' +
        result.documentRecords + ' document record(s), and 0 OneDrive files.',
      );
    }

    async function retryDocument(documentId) {
      if (!documentId) return;
      await api('/api/documents/' + encodeURIComponent(documentId) + '/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Queued from document retry button' }),
      });
      await loadData(true);
      if (state.selectedId) await selectRecord(state.selectedId);
      showToast('Document retry queued.');
    }

    async function submitReviewAction(action) {
      const draft = state.detail && state.detail.caseDraft;
      if (!draft || !action) return;

      const notesInput = document.getElementById('reviewerNotes');
      await api('/api/cases/' + encodeURIComponent(draft.id) + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          notes: notesInput ? notesInput.value : '',
        }),
      });
      await loadData(true);
      showToast(action === 'save_note' ? 'Reviewer note saved.' : 'Draft updated.');
    }

    async function syncInbox() {
      const btn = document.getElementById('syncBtn');
      const limit = document.getElementById('syncLimit').value;
      setButtonBusy(btn, true, 'Syncing');
      try {
        await api('/api/sync-inbox?limit=' + encodeURIComponent(limit), { method: 'POST' });
        await loadData(true);
        if (state.view === 'drafts' && !state.selectedDraftId) await loadDrafts(true);
        showToast('Inbox sync completed.');
      } finally {
        setButtonBusy(btn, false);
      }
    }

    async function refreshNow() {
      const btn = document.getElementById('refreshBtn');
      setButtonBusy(btn, true);
      try {
        await loadData(true);
        if (state.view === 'activity') await loadActivity(true);
        if (state.view === 'drafts') {
          if (state.selectedDraftId && !state.draftDirty) {
            state.draftDetail = await api('/api/drafts/' +
              encodeURIComponent(state.selectedDraftId));
            renderDraftWorkspace();
          } else if (!state.selectedDraftId) {
            await loadDrafts(true);
          }
        }
        if (state.view === 'mappings') await loadPlaintiffMappings();
        showToast(
          state.view === 'activity' ? 'Activity refreshed.' :
          state.view === 'drafts' ? 'Drafts refreshed.' :
          state.view === 'mappings' ? 'Plaintiffs refreshed.' :
          'Queue refreshed.',
        );
      } finally {
        setButtonBusy(btn, false);
      }
    }

    function renderActivityDetails(item) {
      const sections = [
        ['Metadata', item.metadataJson],
        ['Previous value', item.oldValueJson],
        ['New value', item.newValueJson],
      ].filter(section => section[1]);
      if (!sections.length) return '<span class="muted">No details</span>';
      const text = sections.map(section =>
        section[0] + '\n' + formatJson(section[1])
      ).join('\n\n');
      return '<details class="activity-details">' +
        '<summary title="View event details" aria-label="View event details">' + icon('braces') + '<span>View details</span></summary>' +
        '<pre>' + escapeHtml(text) + '</pre>' +
      '</details>';
    }

    function renderActivity() {
      const root = document.getElementById('activityList');
      const items = state.activity;
      renderActivityPagination();
      if (!items.length) {
        root.innerHTML = '<div class="empty">No activity events match the current filters.</div>';
        return;
      }

      root.innerHTML = '<table><thead><tr>' +
        '<th style="width: 150px;">Time</th>' +
        '<th style="width: 190px;">Event</th>' +
        '<th style="width: 145px;">Record type</th>' +
        '<th>Related email</th>' +
        '<th style="width: 100px;">Actor</th>' +
        '<th style="width: 110px;">Details</th>' +
        '</tr></thead><tbody>' +
        items.map(item => '<tr>' +
          '<td><span class="cell-secondary">' + escapeHtml(fmtDate(item.createdAt)) + '</span></td>' +
          '<td><span class="activity-event">' + escapeHtml(statusLabel(item.action)) + '</span>' +
            '<span class="cell-secondary">' + escapeHtml(item.entityId) + '</span>' +
            '<span class="activity-mobile-record">' + escapeHtml(item.subject || 'No linked email') + '</span></td>' +
          '<td>' + statusPill(item.entityType) + '</td>' +
          '<td><span class="activity-record">' + escapeHtml(item.subject || 'No linked email') + '</span>' +
            '<span class="cell-secondary">' + escapeHtml(item.sender || '') + '</span></td>' +
          '<td><span class="cell-secondary">' + escapeHtml(statusLabel(item.actorType || 'system')) + '</span></td>' +
          '<td><div class="table-actions">' +
            (item.emailId ? '<button type="button" class="icon-button" data-open-activity-email="' + escapeHtml(item.emailId) + '" title="Open related email" aria-label="Open related email">' + icon('external-link') + '</button>' : '') +
            renderActivityDetails(item) +
          '</div></td>' +
        '</tr>').join('') +
        '</tbody></table>';

      root.querySelectorAll('[data-open-activity-email]').forEach(button => {
        button.addEventListener('click', () => {
          setView('queue');
          selectRecord(button.dataset.openActivityEmail).catch(showQueueError);
        });
      });
      renderIcons();
    }

    function renderActivityPagination() {
      const pagination = state.activityPagination;
      const root = document.getElementById('activityPagination');
      const first = pagination.totalItems
        ? ((pagination.page - 1) * pagination.pageSize) + 1
        : 0;
      const last = Math.min(pagination.page * pagination.pageSize, pagination.totalItems);
      document.getElementById('activityMeta').textContent =
        pagination.totalItems + ' event' + (pagination.totalItems === 1 ? '' : 's') +
        ' · Page ' + pagination.page + ' of ' + pagination.totalPages;
      document.getElementById('activityPageInfo').textContent =
        first + '-' + last + ' of ' + pagination.totalItems;

      const pageNumbers = new Set([1, pagination.totalPages]);
      for (let page = pagination.page - 2; page <= pagination.page + 2; page++) {
        if (page >= 1 && page <= pagination.totalPages) pageNumbers.add(page);
      }
      const sorted = Array.from(pageNumbers).sort((a, b) => a - b);
      const parts = [
        '<button type="button" data-activity-page="' + (pagination.page - 1) + '" ' +
          (pagination.page <= 1 ? 'disabled' : '') + ' title="Previous page" aria-label="Previous page">' + icon('chevron-left') + '</button>',
      ];
      let previous = 0;
      sorted.forEach(page => {
        if (previous && page - previous > 1) parts.push('<span class="muted">...</span>');
        parts.push(
          '<button type="button" data-activity-page="' + page + '" class="' +
          (page === pagination.page ? 'active' : '') + '">' + page + '</button>',
        );
        previous = page;
      });
      parts.push(
        '<button type="button" data-activity-page="' + (pagination.page + 1) + '" ' +
        (pagination.page >= pagination.totalPages ? 'disabled' : '') +
        ' title="Next page" aria-label="Next page">' + icon('chevron-right') + '</button>',
      );
      root.innerHTML = parts.join('');
      root.querySelectorAll('[data-activity-page]').forEach(button => {
        button.addEventListener('click', () => {
          const page = Number(button.dataset.activityPage);
          if (page >= 1 && page <= pagination.totalPages) {
            state.activityPagination.page = page;
            loadActivity().catch(showActivityError);
          }
        });
      });
      renderIcons();
    }

    async function loadActivity(force) {
      if (state.activityLoadPromise) {
        try {
          await state.activityLoadPromise;
        } catch {
          // The caller that started the request reports the error.
        }
        if (!force) return;
      }

      const task = (async () => {
        const params = new URLSearchParams({
          page: String(state.activityPagination.page),
          pageSize: document.getElementById('activityPageSize').value,
        });
        const search = document.getElementById('activitySearch').value.trim();
        const entityType = document.getElementById('activityEntityFilter').value;
        const dateFrom = document.getElementById('activityDateFrom').value;
        const dateTo = document.getElementById('activityDateTo').value;
        if (search) params.set('q', search);
        if (entityType) params.set('entityType', entityType);
        if (dateFrom) params.set('dateFrom', localDateBoundaryIso(dateFrom, false));
        if (dateTo) params.set('dateTo', localDateBoundaryIso(dateTo, true));

        const page = await api('/api/activity?' + params.toString());
        state.activity = page.items || [];
        state.activityPagination = {
          page: Number(page.page || 1),
          pageSize: Number(page.pageSize || 50),
          totalItems: Number(page.totalItems || 0),
          totalPages: Number(page.totalPages || 1),
        };
        renderActivity();
      })();
      state.activityLoadPromise = task;
      try {
        await task;
      } finally {
        if (state.activityLoadPromise === task) state.activityLoadPromise = null;
      }
    }

    function showActivityError(error) {
      document.getElementById('activityList').innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message || error) + '</div>';
      showToast(error.message || String(error), 'error');
    }

    async function loadData(force) {
      if (state.loadPromise) {
        try {
          await state.loadPromise;
        } catch {
          // The caller that started the request reports the error.
        }
        if (!force) return;
      }

      const task = (async () => {
        const params = new URLSearchParams({
          scope: document.getElementById('scopeFilter').value,
          page: String(state.pagination.page),
          pageSize: document.getElementById('pageSizeFilter').value,
        });
        const search = document.getElementById('searchInput').value.trim();
        const status = document.getElementById('statusFilter').value;
        const dateFrom = document.getElementById('dateFromFilter').value;
        const dateTo = document.getElementById('dateToFilter').value;
        if (search) params.set('q', search);
        if (status) params.set('status', status);
        if (dateFrom) params.set('dateFrom', localDateBoundaryIso(dateFrom, false));
        if (dateTo) params.set('dateTo', localDateBoundaryIso(dateTo, true));

        const [summary, queuePage, live] = await Promise.all([
          api('/api/summary'),
          api('/api/queue?' + params.toString()),
          api('/api/live-status'),
        ]);
        state.summary = summary;
        state.queue = queuePage.items || [];
        state.pagination = {
          page: Number(queuePage.page || 1),
          pageSize: Number(queuePage.pageSize || 50),
          totalItems: Number(queuePage.totalItems || 0),
          totalPages: Number(queuePage.totalPages || 1),
        };
        state.live = live;
        renderSummary();
        renderQueue();
        renderLiveStatus();

        if (state.selectedId) {
          try {
            state.detail = await api('/api/emails/' + encodeURIComponent(state.selectedId));
            renderDetail();
          } catch {
            state.selectedId = null;
            state.detail = null;
            renderDetail();
          }
        }
      })();

      state.loadPromise = task;
      try {
        await task;
      } finally {
        if (state.loadPromise === task) state.loadPromise = null;
      }
    }

    function resetPageAndLoad() {
      state.pagination.page = 1;
      loadData(true).catch(showQueueError);
    }

    function resetActivityPageAndLoad() {
      state.activityPagination.page = 1;
      loadActivity(true).catch(showActivityError);
    }

    let searchTimer = null;
    let activitySearchTimer = null;
    let draftSearchTimer = null;
    document.getElementById('refreshBtn').addEventListener('click', () => refreshNow().catch(showQueueError));
    document.getElementById('syncBtn').addEventListener('click', () => syncInbox().catch(showQueueError));
    document.getElementById('retryBtn').addEventListener('click', () => retrySelected().catch(showQueueError));
    document.getElementById('bulkRetryBtn').addEventListener('click', () => {
      retrySelectedEmails().catch(showQueueError);
    });
    document.getElementById('bulkDeleteBtn').addEventListener('click', () => {
      deleteSelectedEmails().catch(showQueueError);
    });
    document.getElementById('clearSelectionBtn').addEventListener('click', clearSelectedEmails);
    document.getElementById('deleteEmailBtn').addEventListener('click', () => {
      deleteSelectedEmail().catch(showQueueError);
    });
    document.getElementById('purgeBtn').addEventListener('click', () => {
      purgeOlderEmails().catch(showQueueError);
    });
    document.getElementById('queueTab').addEventListener('click', () => setView('queue'));
    document.getElementById('draftsTab').addEventListener('click', () => setView('drafts'));
    document.getElementById('mappingsTab').addEventListener('click', () => setView('mappings'));
    document.getElementById('activityTab').addEventListener('click', () => setView('activity'));
    document.getElementById('closeDraftBtn').addEventListener('click', closeDraft);
    document.getElementById('draftSaveBtn').addEventListener('click', () => {
      saveDraft(false).catch(showDraftError);
    });
    document.getElementById('draftApproveBtn').addEventListener('click', () => {
      reviewDraft('approve').catch(showDraftError);
    });
    document.getElementById('draftRejectBtn').addEventListener('click', () => {
      reviewDraft('reject').catch(showDraftError);
    });
    document.getElementById('draftDocumentSelect').addEventListener('change', event => {
      state.activeDraftDocumentId = event.target.value || null;
      renderActiveDraftDocument((state.draftDetail && state.draftDetail.documents) || []);
    });
    document.querySelectorAll('[data-draft-mobile-mode]').forEach(button => {
      button.addEventListener('click', () => setDraftMobileMode(button.dataset.draftMobileMode));
    });
    document.getElementById('searchInput').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(resetPageAndLoad, 300);
    });
    document.getElementById('scopeFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('pageSizeFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('statusFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('dateFromFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('dateToFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('activitySearch').addEventListener('input', () => {
      clearTimeout(activitySearchTimer);
      activitySearchTimer = setTimeout(resetActivityPageAndLoad, 300);
    });
    document.getElementById('activityEntityFilter').addEventListener('change', resetActivityPageAndLoad);
    document.getElementById('activityPageSize').addEventListener('change', resetActivityPageAndLoad);
    document.getElementById('activityDateFrom').addEventListener('change', resetActivityPageAndLoad);
    document.getElementById('activityDateTo').addEventListener('change', resetActivityPageAndLoad);
    document.getElementById('draftSearch').addEventListener('input', () => {
      clearTimeout(draftSearchTimer);
      draftSearchTimer = setTimeout(resetDraftPageAndLoad, 300);
    });
    document.getElementById('draftStatusFilter').addEventListener('change', resetDraftPageAndLoad);
    document.getElementById('draftValidationFilter').addEventListener('change', resetDraftPageAndLoad);
    document.getElementById('draftPageSize').addEventListener('change', resetDraftPageAndLoad);
    document.getElementById('draftDateFrom').addEventListener('change', resetDraftPageAndLoad);
    document.getElementById('draftDateTo').addEventListener('change', resetDraftPageAndLoad);
    document.getElementById('mappingSearch').addEventListener('input', renderPlaintiffMappings);
    document.getElementById('addMappingBtn').addEventListener('click', () => {
      addMapping().catch(showMappingError);
    });
    document.getElementById('clearMappingBtn').addEventListener('click', clearMappingForm);

    renderIcons();
    loadData().catch(showQueueError);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        loadData(true).catch(showQueueError);
        if (state.view === 'activity') loadActivity(true).catch(showActivityError);
        if (state.view === 'drafts' && !state.selectedDraftId) {
          loadDrafts(true).catch(showDraftError);
        }
      }
    });
    window.addEventListener('beforeunload', event => {
      if (!state.draftDirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
    setInterval(() => {
      if (document.hidden) return;
      loadData().catch(error => {
        state.live = { running: false, lastError: error.message, lastFinishedAt: null, lastStartedAt: null, lastSyncedEmails: 0, lastMiFileDrafts: 0 };
        renderLiveStatus();
      });
      if (state.view === 'activity') loadActivity().catch(showActivityError);
      if (state.view === 'drafts' && !state.selectedDraftId) {
        loadDrafts().catch(showDraftError);
      }
    }, 3000);
  </script>
</body>
</html>`;

export interface CreateAdminServerOptions {
    handleSignals?: boolean;
    closeDatabaseOnShutdown?: boolean;
}

export function createAdminServer(
    port = DEFAULT_PORT,
    options: CreateAdminServerOptions = {},
): http.Server {
    if (process.env.NODE_ENV === 'production' && !hasAdminCredentials()) {
        throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD are required in production');
    }

    const db = getWorkflowDatabase();
    let syncTimer: NodeJS.Timeout | null = null;

    loadLegacyProcessed()
        .then(state => {
            const imported = db.migrateLegacyProcessedIds(state.messageIds ?? []);
            if (imported > 0) {
                console.log(`Imported ${imported} legacy processed email id(s) into SQLite.`);
            }
        })
        .catch(error => {
            console.error('Failed to import legacy processed email ids:', error);
        });

    const runBackgroundSync = () => {
        syncRecentInboxMetadata()
            .catch(error => {
                console.error('Background inbox sync failed:', error);
            });
    };

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

            if (req.method === 'GET' && url.pathname === '/healthz') {
                sendJson(res, 200, { ok: true, buildId: ADMIN_BUILD_ID });
                return;
            }

            if (!isAdminRequestAuthorized(req)) {
                sendUnauthorized(res);
                return;
            }

            if (req.method === 'GET' && url.pathname === '/assets/lucide.js') {
                sendJavascript(res, LUCIDE_BROWSER_SCRIPT);
                return;
            }

            if (req.method === 'GET' && url.pathname === '/') {
                sendHtml(res, html);
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/summary') {
                sendJson(res, 200, db.getDashboardSummary());
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/live-status') {
                sendJson(res, 200, { ...syncStatus, dbPath: db.getPath() });
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/queue') {
                const page = Number(url.searchParams.get('page') || 1);
                const pageSize = Number(url.searchParams.get('pageSize') || 50);
                const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'active';
                const requestedStatus = url.searchParams.get('status') || '';
                const allowedStatuses = new Set<EmailProcessingStatus>([
                    'new',
                    'processing',
                    'ignored',
                    'processed',
                    'failed',
                    'partial_failure',
                    'legacy_processed',
                ]);
                const status = allowedStatuses.has(requestedStatus as EmailProcessingStatus)
                    ? requestedStatus as EmailProcessingStatus
                    : '';
                sendJson(res, 200, db.listQueue({
                    page,
                    pageSize,
                    scope,
                    status,
                    search: url.searchParams.get('q') || '',
                    dateFrom: parseDateBoundary(url.searchParams.get('dateFrom')),
                    dateTo: parseDateBoundary(url.searchParams.get('dateTo'), true),
                }));
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/drafts') {
                const requestedStatus = url.searchParams.get('status') || '';
                const requestedValidation = url.searchParams.get('validation') || '';
                const allowedStatuses = new Set<CaseDraftStatus>([
                    'new',
                    'parsed',
                    'validation_failed',
                    'needs_review',
                    'ready_to_file',
                    'filing_in_progress',
                    'filed_successfully',
                    'filing_failed',
                    'rejected',
                    'archived',
                ]);
                const allowedValidationStatuses = new Set<ValidationStatus>([
                    'unknown',
                    'passed',
                    'warnings',
                    'failed',
                ]);
                sendJson(res, 200, db.listDrafts({
                    page: Number(url.searchParams.get('page') || 1),
                    pageSize: Number(url.searchParams.get('pageSize') || 25),
                    status: allowedStatuses.has(requestedStatus as CaseDraftStatus)
                        ? requestedStatus as CaseDraftStatus
                        : '',
                    validationStatus: allowedValidationStatuses.has(
                        requestedValidation as ValidationStatus,
                    )
                        ? requestedValidation as ValidationStatus
                        : '',
                    search: url.searchParams.get('q') || '',
                    dateFrom: parseDateBoundary(url.searchParams.get('dateFrom')),
                    dateTo: parseDateBoundary(url.searchParams.get('dateTo'), true),
                }));
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/activity') {
                sendJson(res, 200, db.listActivity({
                    page: Number(url.searchParams.get('page') || 1),
                    pageSize: Number(url.searchParams.get('pageSize') || 50),
                    entityType: url.searchParams.get('entityType') || '',
                    search: url.searchParams.get('q') || '',
                    dateFrom: parseDateBoundary(url.searchParams.get('dateFrom')),
                    dateTo: parseDateBoundary(url.searchParams.get('dateTo'), true),
                }));
                return;
            }

            if (req.method === 'POST' && url.pathname === '/api/emails/bulk-retry') {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const emailIds = parseEmailIds(parsed.emailIds);
                if (!emailIds.length) {
                    sendJson(res, 400, { error: 'At least one emailId is required' });
                    return;
                }

                const succeeded: string[] = [];
                const failed: Array<{ emailId: string; error: string }> = [];
                for (const emailId of emailIds) {
                    try {
                        db.queueEmailRetry(emailId, parsed.reason || 'Queued from bulk admin action');
                        succeeded.push(emailId);
                    } catch (error) {
                        failed.push({
                            emailId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                sendJson(res, 200, {
                    requested: emailIds.length,
                    succeeded,
                    failed,
                });
                return;
            }

            if (req.method === 'POST' && url.pathname === '/api/emails/bulk-delete') {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const emailIds = parseEmailIds(parsed.emailIds);
                if (!emailIds.length || parsed.confirm !== true) {
                    sendJson(res, 400, {
                        error: 'At least one emailId and confirm=true are required',
                    });
                    return;
                }

                const succeeded: string[] = [];
                const failed: Array<{ emailId: string; error: string }> = [];
                const totals = {
                    emailRecords: 0,
                    caseDrafts: 0,
                    documentRecords: 0,
                    filingJobs: 0,
                    auditLogs: 0,
                    oneDriveFilesDeleted: 0,
                };
                for (const emailId of emailIds) {
                    try {
                        const result = db.deleteEmailRecord(emailId);
                        succeeded.push(emailId);
                        totals.emailRecords += result.emailRecords;
                        totals.caseDrafts += result.caseDrafts;
                        totals.documentRecords += result.documentRecords;
                        totals.filingJobs += result.filingJobs;
                        totals.auditLogs += result.auditLogs;
                    } catch (error) {
                        failed.push({
                            emailId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                sendJson(res, 200, {
                    requested: emailIds.length,
                    succeeded,
                    failed,
                    totals,
                });
                return;
            }

            if (req.method === 'POST' && url.pathname === '/api/emails/purge-preview') {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const cutoff = parseDateBoundary(parsed.beforeDate);
                if (!cutoff) {
                    sendJson(res, 400, { error: 'A valid beforeDate is required' });
                    return;
                }
                sendJson(res, 200, {
                    cutoff,
                    emailRecords: db.countDeletableEmailsBefore(cutoff),
                    oneDriveFilesDeleted: 0,
                });
                return;
            }

            if (req.method === 'POST' && url.pathname === '/api/emails/purge') {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const cutoff = parseDateBoundary(parsed.beforeDate);
                if (!cutoff || parsed.confirm !== true) {
                    sendJson(res, 400, {
                        error: 'A valid beforeDate and confirm=true are required',
                    });
                    return;
                }
                sendJson(res, 200, db.purgeEmailRecordsBefore(cutoff));
                return;
            }

            if (req.method === 'POST' && url.pathname === '/api/sync-inbox') {
                const limit = Number(url.searchParams.get('limit') || SYNC_EMAIL_LIMIT);
                sendJson(res, 200, await syncRecentInboxMetadata(limit));
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/plaintiff-mappings') {
                sendJson(res, 200, db.listPlaintiffMappings());
                return;
            }

            if (req.method === 'POST' && url.pathname === '/api/plaintiff-mappings') {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const mapping = db.savePlaintiffMapping({
                    id: parsed.id || null,
                    fullName: parsed.fullName,
                    shortName: parsed.shortName,
                    isActive: parsed.isActive !== false,
                });
                const fileSync = mapping.isActive
                    ? await applyPlaintiffMappingToExistingFiles(mapping.id)
                    : null;
                sendJson(res, 200, { mapping, fileSync });
                return;
            }

            const plaintiffShortNameMatch = url.pathname.match(/^\/api\/plaintiff-mappings\/([^/]+)\/short-name$/);
            if (req.method === 'DELETE' && plaintiffShortNameMatch) {
                const mapping = db.clearPlaintiffShortName(
                    decodeURIComponent(plaintiffShortNameMatch[1]),
                );
                sendJson(res, 200, { mapping });
                return;
            }

            const plaintiffStatusMatch = url.pathname.match(/^\/api\/plaintiff-mappings\/([^/]+)\/active$/);
            if (req.method === 'POST' && plaintiffStatusMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const mapping = db.setPlaintiffMappingActive(
                    decodeURIComponent(plaintiffStatusMatch[1]),
                    parsed.isActive !== false,
                );
                const fileSync = mapping.isActive
                    ? await applyPlaintiffMappingToExistingFiles(mapping.id)
                    : null;
                sendJson(res, 200, { mapping, fileSync });
                return;
            }

            const applyPlaintiffFilesMatch = url.pathname.match(/^\/api\/plaintiff-mappings\/([^/]+)\/apply-existing-files$/);
            if (req.method === 'POST' && applyPlaintiffFilesMatch) {
                sendJson(
                    res,
                    200,
                    await applyPlaintiffMappingToExistingFiles(
                        decodeURIComponent(applyPlaintiffFilesMatch[1]),
                    ),
                );
                return;
            }

            const detailMatch = url.pathname.match(/^\/api\/emails\/([^/]+)$/);
            if (req.method === 'DELETE' && detailMatch) {
                sendJson(
                    res,
                    200,
                    db.deleteEmailRecord(decodeURIComponent(detailMatch[1])),
                );
                return;
            }

            if (req.method === 'GET' && detailMatch) {
                const detail = db.getEmailDetail(decodeURIComponent(detailMatch[1]));
                if (!detail) {
                    sendJson(res, 404, { error: 'Email record not found' });
                    return;
                }
                sendJson(res, 200, detail);
                return;
            }

            const retryMatch = url.pathname.match(/^\/api\/emails\/([^/]+)\/retry$/);
            if (req.method === 'POST' && retryMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                db.queueEmailRetry(
                    decodeURIComponent(retryMatch[1]),
                    parsed.reason || 'Queued from admin API',
                );
                sendJson(res, 200, { ok: true });
                return;
            }

            const documentRetryMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/retry$/);
            if (req.method === 'POST' && documentRetryMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                db.queueDocumentRetry(
                    decodeURIComponent(documentRetryMatch[1]),
                    parsed.reason || 'Queued from admin API',
                );
                sendJson(res, 200, { ok: true });
                return;
            }

            const documentContentMatch = url.pathname.match(
                /^\/api\/documents\/([^/]+)\/content$/,
            );
            if (req.method === 'GET' && documentContentMatch) {
                const document = db.getDocumentAccess(
                    decodeURIComponent(documentContentMatch[1]),
                );
                if (!document) {
                    sendJson(res, 404, { error: 'Viewable document not found' });
                    return;
                }

                const sharedItem = await resolveSharedDriveItem(document.oneDriveUrl);
                const content = await downloadDriveItemBuffer(
                    sharedItem.driveId,
                    sharedItem.itemId,
                );
                if (content.length < 5 || content.subarray(0, 5).toString('ascii') !== '%PDF-') {
                    sendJson(res, 415, { error: 'The stored OneDrive file is not a valid PDF' });
                    return;
                }

                const fileName = document.currentFilename || sharedItem.fileName || 'document.pdf';
                res.writeHead(200, {
                    'Content-Type': 'application/pdf',
                    'Content-Length': content.length,
                    'Content-Disposition':
                        `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
                    'Cache-Control': 'private, max-age=300',
                    'X-Content-Type-Options': 'nosniff',
                    'X-Frame-Options': 'SAMEORIGIN',
                });
                res.end(content);
                return;
            }

            const draftMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)$/);
            if (req.method === 'GET' && draftMatch) {
                const detail = db.getDraftDetail(decodeURIComponent(draftMatch[1]));
                if (!detail) {
                    sendJson(res, 404, { error: 'Case draft not found' });
                    return;
                }
                sendJson(res, 200, detail);
                return;
            }

            if (req.method === 'PATCH' && draftMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const detail = db.updateCaseDraft(
                    decodeURIComponent(draftMatch[1]),
                    parsed.fields ?? {},
                    typeof parsed.reviewerNotes === 'string'
                        ? parsed.reviewerNotes
                        : undefined,
                    parsed.filingData,
                    Array.isArray(parsed.documents) ? parsed.documents : [],
                );
                sendJson(res, 200, detail);
                return;
            }

            const reviewMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/review$/);
            if (req.method === 'POST' && reviewMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                const action = parsed.action as ReviewAction;
                if (!['save_note', 'move_to_review', 'approve', 'reject'].includes(action)) {
                    sendJson(res, 400, { error: 'Invalid review action' });
                    return;
                }

                db.reviewCaseDraft(
                    decodeURIComponent(reviewMatch[1]),
                    action,
                    typeof parsed.notes === 'string' ? parsed.notes : undefined,
                );
                sendJson(res, 200, { ok: true });
                return;
            }

            sendJson(res, 404, { error: 'Not found' });
        } catch (error) {
            console.error('Admin server error:', error);
            sendJson(res, 500, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });

    server.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
            console.error(
                `Port ${port} is already in use. Stop the existing admin server or set ADMIN_PORT to another port.`,
            );
            process.exit(1);
        }

        throw error;
    });

    server.once('close', () => {
        if (syncTimer) clearInterval(syncTimer);
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(`Legal Workflow Admin listening on http://localhost:${port}`);
        console.log(`Workflow DB: ${db.getPath()}`);
        if (ADMIN_SYNC_ENABLED) {
            runBackgroundSync();
            syncTimer = setInterval(runBackgroundSync, AUTO_SYNC_INTERVAL_MS);
        } else {
            console.log('Admin inbox synchronization is disabled by ADMIN_SYNC_ENABLED.');
        }
    });

    const handleSignals = options.handleSignals ?? require.main === module;
    if (handleSignals) {
        const shutdown = () => {
            if (syncTimer) clearInterval(syncTimer);
            server.close(() => {
                if (options.closeDatabaseOnShutdown !== false) {
                    db.close();
                }
                process.exit(0);
            });
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    }

    return server;
}

if (require.main === module) {
    createAdminServer();
}
