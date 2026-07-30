import http from 'http';
import { URL } from 'url';
import { timingSafeEqual } from 'crypto';
import {
    EmailProcessingStatus,
    getWorkflowDatabase,
    ProcessingReportInput,
    ReviewAction,
} from './database';
import {
    fetchCourtEmailById,
    fetchRecentCourtEmailHeaders,
    parseEmailBody,
} from './emailProcessor';
import { loadLegacyProcessed } from './legacyState';
import { renameDriveItem, resolveSharedDriveItem } from './oneDriveClient';

const DEFAULT_PORT = Number(process.env.PORT || process.env.ADMIN_PORT || 3000);
const SYNC_EMAIL_LIMIT = Number(process.env.ADMIN_SYNC_EMAIL_LIMIT || 100);
const AUTO_SYNC_INTERVAL_MS = Number(process.env.ADMIN_AUTO_SYNC_MS || 30_000);
const ADMIN_SYNC_ENABLED = !['0', 'false', 'no', 'off'].includes(
    (process.env.ADMIN_SYNC_ENABLED ?? 'true').trim().toLowerCase(),
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

            const parsed = parseEmailBody((msg as any).body?.content ?? '');
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
  </style>
</head>
<body>
  <header>
    <div class="controls">
      <h1>Legal Workflow Admin</h1>
      <nav class="nav-tabs" aria-label="Admin sections">
        <button id="queueTab" class="active" type="button">Queue</button>
        <button id="mappingsTab" type="button">Plaintiff mappings</button>
      </nav>
    </div>
    <div class="controls">
      <div class="livebar"><span id="liveDot" class="dot"></span><span id="liveStatus">Live</span></div>
      <select id="syncLimit">
        <option value="50">Sync 50</option>
        <option value="100" selected>Sync 100</option>
        <option value="250">Sync 250</option>
        <option value="500">Sync 500</option>
        <option value="1000">Sync 1000</option>
      </select>
      <button id="syncBtn" type="button">Sync Inbox</button>
      <button id="refreshBtn" class="primary" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <section id="queuePane">
      <div class="summary" id="summary"></div>
      <div class="panel">
        <div class="toolbar">
          <h2>Incoming Queue</h2>
          <div class="controls">
            <input id="searchInput" type="search" placeholder="Search subject, case, plaintiff">
            <select id="scopeFilter">
              <option value="active">Active</option>
              <option value="all">All history</option>
            </select>
            <select id="pageSizeFilter">
              <option value="25">25 / page</option>
              <option value="50" selected>50 / page</option>
              <option value="100">100 / page</option>
            </select>
            <select id="statusFilter">
              <option value="">All statuses</option>
              <option value="failed">Failed</option>
              <option value="partial_failure">Partial failure</option>
              <option value="processed">Processed</option>
              <option value="ignored">Ignored</option>
              <option value="new">New</option>
              <option value="processing">Processing</option>
            </select>
            <input id="dateFromFilter" class="date-input" type="date" title="Received from">
            <input id="dateToFilter" class="date-input" type="date" title="Received through">
          </div>
        </div>
        <div id="queue"></div>
        <div class="queue-footer">
          <div class="controls">
            <input id="deleteBeforeDate" class="date-input" type="date" title="Delete terminal records before date">
            <button id="purgeBtn" class="danger" type="button">Delete older records</button>
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
        <h2>Record Detail</h2>
        <div class="controls">
          <button id="retryBtn" type="button" disabled title="Retry the whole email when parsing or all document processing failed">Retry email</button>
          <button id="deleteEmailBtn" class="danger" type="button" disabled title="Delete this database record only">Delete record</button>
        </div>
      </div>
      <div class="detail-body" id="detail">
        <div class="empty">Select a queue row.</div>
      </div>
    </section>
    <section id="mappingsPane" class="full-span hidden">
      <div class="summary" id="mappingSummary"></div>
      <div class="split-panels">
        <div class="panel">
          <div class="toolbar">
            <h2>Plaintiff Mappings</h2>
            <div class="controls">
              <input id="mappingSearch" type="search" placeholder="Search mappings">
            </div>
          </div>
          <div class="form-grid">
            <input id="mappingFullName" type="text" placeholder="Full Plaintiff name">
            <input id="mappingShortName" type="text" placeholder="Short name">
            <button id="addMappingBtn" class="primary" type="button">Add Plaintiff</button>
            <button id="clearMappingBtn" type="button">Clear fields</button>
          </div>
          <div id="mappingsList"></div>
        </div>
        <div class="panel">
          <div class="toolbar">
            <h2>Missing Mappings</h2>
          </div>
          <div id="missingMappingsList"></div>
        </div>
      </div>
    </section>
  </main>
  <script>
    const state = {
      summary: null,
      queue: [],
      selectedId: null,
      detail: null,
      live: null,
      plaintiffMappings: { mappings: [], missing: [] },
      editingMappingId: null,
      view: 'queue',
      pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 },
      loadPromise: null,
    };

    const statusClass = value => String(value || 'unknown').replace(/[^a-z0-9_ -]/gi, '_');
    const fmtDate = value => value ? new Date(value).toLocaleString() : '';
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
    const statusPill = value => '<span class="status ' + statusClass(value) + '">' + escapeHtml(value || 'unknown') + '</span>';

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
      document.getElementById('mappingsPane').classList.toggle('hidden', view !== 'mappings');
      document.getElementById('queueTab').classList.toggle('active', view === 'queue');
      document.getElementById('mappingsTab').classList.toggle('active', view === 'mappings');

      if (view === 'mappings') {
        loadPlaintiffMappings().catch(error => {
          document.getElementById('mappingsList').innerHTML = '<div class="empty error-text">' + escapeHtml(error.message) + '</div>';
        });
      }
    }

    function metric(label, value) {
      return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
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
        metric('Active drafts', (drafts.parsed || 0) + (drafts.needs_review || 0) + (drafts.ready_to_file || 0)),
        metric('Downloaded docs', docs.uploaded || 0),
        metric('Pending docs', docs.pending || 0),
        metric('Failed docs', docs.failed || 0),
        metric('No file link', docs.not_downloadable || 0),
        metric('Needs attention', (email.failed || 0) + (email.partial_failure || 0) + (drafts.needs_review || 0)),
        metric('Missing plaintiff mappings', s.missingPlaintiffMappings),
        metric('Database storage', formatBytes(s.databaseBytes)),
      ].join('');
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

    function renderQueue() {
      const items = filteredQueue();
      const root = document.getElementById('queue');
      renderPagination();
      if (!items.length) {
        root.innerHTML = '<div class="empty">No queue records match the current filters.</div>';
        return;
      }

      root.innerHTML = '<table><thead><tr>' +
        '<th style="width: 108px;">Received</th>' +
        '<th>Subject</th>' +
        '<th style="width: 104px;">Case</th>' +
        '<th style="width: 132px;">Plaintiff</th>' +
        '<th style="width: 92px;">Documents</th>' +
        '<th style="width: 128px;">Status</th>' +
        '</tr></thead><tbody>' +
        items.map(item => '<tr data-id="' + escapeHtml(item.emailId) + '" class="' + (item.emailId === state.selectedId ? 'selected' : '') + '">' +
          '<td>' + escapeHtml(fmtDate(item.receivedAt)) + '</td>' +
          '<td><b>' + escapeHtml(item.subject || '(no subject)') + '</b><br><span class="muted">' + escapeHtml(item.sender || '') + '</span></td>' +
          '<td>' + escapeHtml(item.caseNumber || '') + '</td>' +
          '<td>' + renderPlaintiffCell(item) + '</td>' +
          '<td>' + renderDocCount(item) + '</td>' +
          '<td>' + statusPill(item.processingStatus) + '<br><span class="muted">' + escapeHtml(item.draftStatus || '') + (item.validationStatus ? ' · ' + escapeHtml(item.validationStatus) : '') + '</span></td>' +
        '</tr>').join('') +
        '</tbody></table>';

      root.querySelectorAll('tr[data-id]').forEach(row => {
        row.addEventListener('click', () => selectRecord(row.dataset.id));
      });
    }

    function renderPagination() {
      const pagination = state.pagination;
      const pageInfo = document.getElementById('pageInfo');
      const root = document.getElementById('pagination');
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
          (pagination.page <= 1 ? 'disabled' : '') + ' title="Previous page" aria-label="Previous page">&#8249;</button>',
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
        ' title="Next page" aria-label="Next page">&#8250;</button>',
      );
      root.innerHTML = parts.join('');
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
    }

    function renderPlaintiffCell(item) {
      if (!item.plaintiffName) return '';
      const primary = item.plaintiffShortName || item.plaintiffName;
      const secondary = item.plaintiffShortName ? item.plaintiffName : item.plaintiffMappingStatus;
      return '<b>' + escapeHtml(primary) + '</b><br><span class="muted">' + escapeHtml(secondary || '') + '</span>';
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
        metric('Active mappings', (state.plaintiffMappings.mappings || []).filter(row => row.status === 'active').length),
        metric('Need short name', (state.plaintiffMappings.mappings || []).filter(row => row.status === 'needs_short_name').length),
        metric('Inactive mappings', (state.plaintiffMappings.mappings || []).filter(row => row.status === 'inactive').length),
        metric('Missing mappings', missing.length),
        metric('Mapped usages', (state.plaintiffMappings.mappings || []).reduce((sum, row) => sum + Number(row.usageCount || 0), 0)),
      ].join('');

      const mappingsRoot = document.getElementById('mappingsList');
      mappingsRoot.innerHTML = mappings.length ? '<table><thead><tr>' +
        '<th>Full Plaintiff</th>' +
        '<th style="width: 170px;">Short Name</th>' +
        '<th style="width: 94px;">Status</th>' +
        '<th style="width: 88px;">Usage</th>' +
        '<th style="width: 132px;">Last Used</th>' +
        '<th style="width: 250px;">Actions</th>' +
        '</tr></thead><tbody>' +
        mappings.map(renderPlaintiffMappingRow).join('') +
        '</tbody></table>' : '<div class="empty">No mappings.</div>';

      const missingRoot = document.getElementById('missingMappingsList');
      missingRoot.innerHTML = missing.length ? '<table><thead><tr>' +
        '<th>Full Plaintiff</th>' +
        '<th style="width: 74px;">Usage</th>' +
        '<th style="width: 118px;">Last Used</th>' +
        '<th style="width: 70px;">Action</th>' +
        '</tr></thead><tbody>' +
        missing.map(row => '<tr>' +
          '<td><b>' + escapeHtml(row.fullName) + '</b></td>' +
          '<td>' + escapeHtml(row.usageCount || 0) + '</td>' +
          '<td>' + escapeHtml(fmtDate(row.lastUsedAt)) + '</td>' +
          '<td><button type="button" data-use-plaintiff="' + escapeHtml(row.fullName) + '">Use</button></td>' +
        '</tr>').join('') +
        '</tbody></table>' : '<div class="empty">No missing mappings.</div>';

      bindMappingActions();
    }

    function renderPlaintiffMappingRow(row) {
      const editing = state.editingMappingId === row.id;
      const id = escapeHtml(row.id);
      const fullName = editing
        ? '<input data-inline-full-name type="text" value="' + escapeHtml(row.fullName) + '">'
        : '<b>' + escapeHtml(row.fullName) + '</b>';
      const shortName = editing
        ? '<input data-inline-short-name type="text" value="' + escapeHtml(row.shortName) + '" placeholder="Short name">'
        : escapeHtml(row.shortName);
      const actions = editing
        ? '<button type="button" class="primary" data-save-inline-mapping="' + id + '">Save</button>' +
          '<button type="button" data-cancel-inline-mapping="' + id + '">Cancel</button>'
        : '<button type="button" data-edit-mapping="' + id + '">Edit</button>' +
          (row.shortName ? '<button type="button" data-clear-short-name="' + id + '" title="Remove the short name and keep this Plaintiff as an unmapped candidate">Clear short</button>' : '') +
          (row.shortName ? '<button type="button" data-toggle-mapping="' + id + '" data-active="' + escapeHtml(!row.isActive) + '">' + escapeHtml(row.isActive ? 'Deactivate' : 'Activate') + '</button>' : '') +
          (row.isActive && row.shortName ? '<button type="button" data-apply-plaintiff-files="' + id + '" title="Apply this short name to existing OneDrive files">Apply files</button>' : '');

      return '<tr data-mapping-row="' + id + '">' +
        '<td>' + fullName + '</td>' +
        '<td>' + shortName + '</td>' +
        '<td>' + statusPill(row.status || (row.isActive ? 'active' : 'inactive')) + '</td>' +
        '<td>' + escapeHtml(row.usageCount || 0) + '</td>' +
        '<td>' + escapeHtml(fmtDate(row.lastUsedAt)) + '</td>' +
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
        button.addEventListener('click', () => setMappingActive(button.dataset.toggleMapping, button.dataset.active === 'true'));
      });

      document.querySelectorAll('[data-apply-plaintiff-files]').forEach(button => {
        button.addEventListener('click', () => applyPlaintiffFiles(button.dataset.applyPlaintiffFiles));
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
    }

    async function setMappingActive(id, isActive) {
      if (!id) return;
      await api('/api/plaintiff-mappings/' + encodeURIComponent(id) + '/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      await Promise.all([loadPlaintiffMappings(), loadData()]);
    }

    async function applyPlaintiffFiles(id) {
      if (!id) return;
      await api('/api/plaintiff-mappings/' + encodeURIComponent(id) + '/apply-existing-files', {
        method: 'POST',
      });
      await Promise.all([loadPlaintiffMappings(), loadData()]);
    }

    function renderDocCount(item) {
      const expected = Number(item.expectedDocumentCount || 0);
      const uploaded = Number(item.oneDriveDocumentCount || item.uploadedDocumentCount || 0);
      const pending = Number(item.pendingDocumentCount || 0);
      const retryQueued = Number(item.retryQueuedDocumentCount || 0);
      const retrying = Number(item.retryingDocumentCount || 0);
      const failed = Number(item.failedDocumentCount || 0);
      const notDownloadable = Number(item.notDownloadableDocumentCount || 0);
      if (!expected) return '<span class="muted">0</span>';
      const main = '<b>' + escapeHtml(uploaded) + '</b><span class="muted"> / ' + escapeHtml(expected) + '</span>';
      const parts = [];
      if (pending) parts.push(escapeHtml(pending) + ' pending');
      if (retryQueued) parts.push(escapeHtml(retryQueued) + ' retry queued');
      if (retrying) parts.push(escapeHtml(retrying) + ' retrying');
      if (failed) parts.push('<span class="error-text">' + escapeHtml(failed) + ' failed</span>');
      if (notDownloadable) parts.push(escapeHtml(notDownloadable) + ' no file link');
      return main + (parts.length ? '<br><span class="muted">' + parts.join(' · ') + '</span>' : '');
    }

    function renderDetail() {
      const root = document.getElementById('detail');
      const retryBtn = document.getElementById('retryBtn');
      const deleteBtn = document.getElementById('deleteEmailBtn');
      const detail = state.detail;
      retryBtn.disabled = !detail || !['failed', 'partial_failure'].includes(detail.email.processingStatus);
      const hasActiveRetry = detail && detail.documents.some(doc =>
        ['retry_queued', 'retrying'].includes(doc.status)
      );
      deleteBtn.disabled = !detail ||
        detail.email.processingStatus === 'processing' ||
        hasActiveRetry;

      if (!detail) {
        root.innerHTML = '<div class="empty">Select a queue row.</div>';
        return;
      }

      const email = detail.email;
      const draft = detail.caseDraft;
      root.innerHTML =
        '<div class="kv">' +
          '<b>Status</b><div>' + statusPill(email.processingStatus) + '</div>' +
          '<b>Subject</b><div>' + escapeHtml(email.subject || '') + '</div>' +
          '<b>Sender</b><div>' + escapeHtml(email.sender || '') + '</div>' +
          '<b>Received</b><div>' + escapeHtml(fmtDate(email.receivedAt)) + '</div>' +
          '<b>Attempts</b><div>' + escapeHtml(email.processingAttempts) + '</div>' +
          '<b>Error</b><div class="error-text">' + escapeHtml(email.processingError || '') + '</div>' +
        '</div>' +
        (draft ? '<h3>Draft</h3><div class="kv">' +
          '<b>Status</b><div>' + statusPill(draft.status) + '</div>' +
          '<b>Validation</b><div>' + statusPill(draft.validationStatus) + '</div>' +
          '<b>Filing</b><div>' + statusPill(draft.filingStatus) + '</div>' +
          '<b>Workflow</b><div>' + escapeHtml(draft.workflowMode) + '</div>' +
          '<b>Plaintiff mapping</b><div>' + renderPlaintiffMappingStatus(detail.plaintiffMapping) + '</div>' +
          '<b>File names</b><div>' + renderPlaintiffFilenameMapping(detail.plaintiffFilenameMapping) + '</div>' +
        '</div><pre>' + escapeHtml(formatJson(draft.normalizedDataJson)) + '</pre>' +
        renderReviewControls(draft) : '') +
        '<h3>Documents</h3>' +
        renderDocumentSummary(detail.documents) +
        (detail.documents.length ? detail.documents.map(doc => '<div class="doc">' +
          '<div class="doc-title"><b>' + escapeHtml(doc.currentFilename || doc.originalFilename || doc.documentType || 'Document') + '</b><div class="doc-actions">' + statusPill(doc.status) + renderDocumentRetryAction(doc) + '</div></div>' +
          '<div class="muted">' + escapeHtml(doc.documentType || '') + (doc.storagePath ? ' · ' + escapeHtml(doc.storagePath) : '') + '</div>' +
          renderDocumentLinks(doc) +
          renderDocumentRetryInfo(doc, detail.retryPolicy) +
          (doc.errorMessage ? '<div class="error-text">' + escapeHtml(doc.errorMessage) + '</div>' : '') +
          renderDocumentFailureLog(doc) +
        '</div>').join('') : '<div class="empty">No documents recorded.</div>') +
        '<h3>Audit</h3>' +
        (detail.auditLogs.length ? detail.auditLogs.map(log => '<div class="audit">' +
          '<b>' + escapeHtml(log.action) + '</b><br>' +
          '<span class="muted">' + escapeHtml(fmtDate(log.createdAt)) + ' · ' + escapeHtml(log.entityType) + '</span>' +
        '</div>').join('') : '<div class="empty">No audit events recorded.</div>');

      bindDetailActions();
    }

    function renderReviewControls(draft) {
      return '<h3>Review</h3>' +
        '<textarea id="reviewerNotes" placeholder="Reviewer note">' + escapeHtml(draft.reviewerNotes || '') + '</textarea>' +
        '<div class="review-actions">' +
          '<button type="button" data-review-action="save_note">Save note</button>' +
          '<button type="button" data-review-action="move_to_review">Move to review</button>' +
          '<button type="button" class="primary" data-review-action="approve">Approve</button>' +
          '<button type="button" data-review-action="reject">Reject</button>' +
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
          retryDocument(button.dataset.retryDocument);
        });
      });

      const draft = state.detail && state.detail.caseDraft;
      if (!draft) return;

      document.querySelectorAll('[data-review-action]').forEach(button => {
        button.addEventListener('click', () => submitReviewAction(button.dataset.reviewAction));
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
      return '<div class="kv">' +
        '<b>Downloaded</b><div><b>' + escapeHtml(uploaded) + '</b><span class="muted"> / ' + escapeHtml(expected) + '</span></div>' +
        '<b>Pending</b><div>' + escapeHtml(pending) + '</div>' +
        '<b>Retry queued</b><div>' + escapeHtml(retryQueued) + '</div>' +
        '<b>Retrying</b><div>' + escapeHtml(retrying) + '</div>' +
        '<b>Failed</b><div class="error-text">' + escapeHtml(failed) + '</div>' +
        '<b>No file link</b><div>' + escapeHtml(notDownloadable) + '</div>' +
      '</div>';
    }

    function renderDocumentRetryAction(doc) {
      if (doc.status !== 'failed' || !doc.sourceUrl) return '';
      return '<button type="button" class="icon-button" data-retry-document="' + escapeHtml(doc.id) + '" title="Retry document download" aria-label="Retry document download">&#8635;</button>';
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
      } else if (doc.nextRetryAt) {
        parts.push('Next automatic retry: ' + escapeHtml(fmtDate(doc.nextRetryAt)));
      } else if (doc.status === 'failed' && maxRetries && Number(doc.automaticRetryCount || 0) >= maxRetries) {
        parts.push('Automatic retry limit reached; use the retry button to try again');
      }
      return '<div class="muted">' + parts.join(' &middot; ') + '</div>';
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
        '<summary>Failure log (' + escapeHtml(entries.length) + ')</summary>' +
        '<pre>' + lines + '</pre>' +
      '</details>';
    }

    function renderDocumentLinks(doc) {
      const links = [];
      if (doc.oneDriveUrl) {
        links.push('<a href="' + escapeHtml(doc.oneDriveUrl) + '" target="_blank" rel="noreferrer">Open OneDrive</a>');
      }
      if (doc.sourceUrl) {
        links.push('<a href="' + escapeHtml(doc.sourceUrl) + '" target="_blank" rel="noreferrer">Download from MiFILE</a>');
      }
      if (!links.length && doc.fileUrl) {
        links.push('<a href="' + escapeHtml(doc.fileUrl) + '" target="_blank" rel="noreferrer">Open legacy link</a>');
      }
      return links.length ? '<div>' + links.join(' · ') + '</div>' : '';
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
    }

    async function retrySelected() {
      if (!state.selectedId) return;
      await api('/api/emails/' + encodeURIComponent(state.selectedId) + '/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Queued from admin UI' }),
      });
      await loadData(true);
      await selectRecord(state.selectedId);
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
    }

    async function purgeOlderEmails() {
      const dateInput = document.getElementById('deleteBeforeDate');
      const beforeDate = dateInput.value;
      if (!beforeDate) {
        window.alert('Choose a cutoff date first.');
        return;
      }

      const preview = await api('/api/emails/purge-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beforeDate }),
      });
      if (!preview.emailRecords) {
        window.alert('No completed, failed, or ignored records are eligible before this date.');
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
      window.alert(
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
    }

    async function syncInbox() {
      const btn = document.getElementById('syncBtn');
      const limit = document.getElementById('syncLimit').value;
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      try {
        await api('/api/sync-inbox?limit=' + encodeURIComponent(limit), { method: 'POST' });
        await loadData(true);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Inbox';
      }
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

    let searchTimer = null;
    document.getElementById('refreshBtn').addEventListener('click', () => loadData(true));
    document.getElementById('syncBtn').addEventListener('click', syncInbox);
    document.getElementById('retryBtn').addEventListener('click', retrySelected);
    document.getElementById('deleteEmailBtn').addEventListener('click', () => {
      deleteSelectedEmail().catch(showQueueError);
    });
    document.getElementById('purgeBtn').addEventListener('click', () => {
      purgeOlderEmails().catch(showQueueError);
    });
    document.getElementById('queueTab').addEventListener('click', () => setView('queue'));
    document.getElementById('mappingsTab').addEventListener('click', () => setView('mappings'));
    document.getElementById('searchInput').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(resetPageAndLoad, 300);
    });
    document.getElementById('scopeFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('pageSizeFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('statusFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('dateFromFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('dateToFilter').addEventListener('change', resetPageAndLoad);
    document.getElementById('mappingSearch').addEventListener('input', renderPlaintiffMappings);
    document.getElementById('addMappingBtn').addEventListener('click', () => {
      addMapping().catch(showMappingError);
    });
    document.getElementById('clearMappingBtn').addEventListener('click', clearMappingForm);

    loadData().catch(showQueueError);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadData(true).catch(showQueueError);
    });
    setInterval(() => {
      if (document.hidden) return;
      loadData().catch(error => {
        state.live = { running: false, lastError: error.message, lastFinishedAt: null, lastStartedAt: null, lastSyncedEmails: 0, lastMiFileDrafts: 0 };
        renderLiveStatus();
      });
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
                sendJson(res, 200, { ok: true });
                return;
            }

            if (!isAdminRequestAuthorized(req)) {
                sendUnauthorized(res);
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
