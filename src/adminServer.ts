import http from 'http';
import fs from 'fs';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import { createAdminAuth, hasAdminCredentials } from './adminAuth';
import { createExcelPdfHandler } from './excelPdf';
import { checkMicrosoftAccess, MicrosoftAccessReport } from './microsoftAccess';
import {
    CaseDraftStatus,
    EmailDetail,
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
    createFileLink,
    downloadDriveItemBuffer,
    renameDriveItem,
    replaceDriveItemContent,
    resolveSharedDriveItem,
    uploadFileBufferToFolder,
    ensureIntakeFolder,
} from './oneDriveClient';
import { isComplaintDocument } from './complaintExtractor';
import { inspectFilingPdf, validatePdfBuffer } from './pdfValidation';
import { getMiFileRuntimeConfig } from './mifileRuntimeConfig';
import { parseWorkflowEmail } from './workflowEmail';
import path from 'node:path';
import os from 'node:os';
import { planFormImports } from './courtForms';
import { getFilingIntakeConfig, intakeFileName, buildFilingIntake } from './filingIntake';
import {
    accountSettingsEnabled, accountSettingsView, credentialsFromSettingsInput,
    encryptMiFileAccount, getMiFileCredentials,
} from './mifileAccountSettings';
import { invalidateMifileSession, testMiFileCredentials } from './mifileSession';
import { pdfPreviewHtml } from './pdfPreview';
import { PDF_PREVIEW_SCRIPT, PDF_PREVIEW_STYLE } from './pdfPreviewClient';
import { applyLibraryForms, saveFormPdf, readFormPdf } from './formLibrary';
import { recognizeDocumentPdf } from './documentRecognition';
import { ensureDraftComplaintExtraction, ensureDraftDocumentRecognitions } from './draftExtraction';
import { changedFieldPaths, mergeExtractedField } from './draftFieldMerge';
import { filingReleaseChecks } from './mifilePreparationEvidence';
import { getCheckoutAccount } from './mifileCheckoutRunner';

const DEFAULT_PORT = Number(process.env.PORT || process.env.ADMIN_PORT || 3000);
const ADMIN_BUILD_ID = '2026-10-30-pringle-completeness-v84';
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

function manualFilingData(source?: EmailDetail | null): Record<string, unknown> {
    const sourceFiling = source?.caseDraft?.filingData;
    const sourceFields = source?.caseDraft?.editableData;
    const plaintiffName = sourceFields?.plaintiff || null;
    const defendantName = sourceFields?.defendant || null;
    return {
        courtDistrict: sourceFiling?.courtDistrict || null,
        action: 'Initiate a new case',
        caseType: 'LT - Landlord-Tenant Summary Proceedings',
        relatedCivilAction: 'unknown',
        relatedCaseCourt: null,
        relatedCaseDocketNumber: null,
        relatedCaseJudge: null,
        relatedCasePending: null,
        moneyJudgmentRequested: null,
        claimAmount: null,
        mailingRequested: true,
        includeAllOtherOccupants: false,
        plaintiff: sourceFiling?.plaintiff || {
            partyType: 'entity',
            entityName: plaintiffName,
            displayName: plaintiffName,
        },
        defendants: sourceFiling?.defendants?.length
            ? sourceFiling.defendants
            : defendantName
                ? [{ partyType: 'person', displayName: defendantName }]
                : [],
        attorney: {
            name: process.env.FILING_ATTORNEY_NAME || 'Adam J Devlin',
            barNumber: process.env.FILING_ATTORNEY_BAR_NUMBER || 'P72877',
            address1: process.env.FILING_ATTORNEY_ADDRESS || '30850 Telegraph Rd',
            address2: process.env.FILING_ATTORNEY_ADDRESS_2 || 'Suite 250',
            city: process.env.FILING_ATTORNEY_CITY || 'Bingham Farms',
            state: process.env.FILING_ATTORNEY_STATE || 'MI',
            postalCode: process.env.FILING_ATTORNEY_ZIP || '48025',
            phone: process.env.FILING_ATTORNEY_PHONE || '2487036201',
            email: process.env.FILING_ATTORNEY_EMAIL || 'ajd@devlinlawpllc.com',
        },
    };
}

function buildManualDraft(message: any, source?: EmailDetail | null,
    packageMode: 'standard_lt' | 'custom' = 'standard_lt'): any {
    const parsed = buildFilingIntake(message, []);
    parsed.intake!.manual = true;
    parsed.intake!.packageMode = packageMode;
    parsed.intake!.issues = [];
    const sourceFields = source?.caseDraft?.editableData;
    Object.assign(parsed, {
        courtName: sourceFields?.courtName || null,
        caseTitle: sourceFields?.caseTitle || null,
        plaintiff: sourceFields?.plaintiff || null,
        defendant: sourceFields?.defendant || null,
        filerName: process.env.FILING_ATTORNEY_NAME || 'Adam J Devlin',
        submitterName: process.env.FILING_ATTORNEY_NAME || 'Adam J Devlin',
        filingData: manualFilingData(source),
        manualPackageSource: source?.caseDraft ? {
            caseDraftId: source.caseDraft.id,
            emailId: source.email.id,
            subject: source.email.subject,
        } : null,
    });
    return parsed;
}

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

function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function readRequestBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', chunk => {
            const buffer = Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBytes) {
                reject(new Error(`Uploaded file exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`));
                req.destroy();
                return;
            }
            chunks.push(buffer);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
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

function uploadedPdfFilename(value: string | string[] | undefined): string {
    const raw = Array.isArray(value) ? value[0] : value;
    const decoded = raw ? decodeURIComponent(raw) : 'document.pdf';
    const base = decoded.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim();
    const withExtension = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
    return withExtension.slice(0, 180) || 'document.pdf';
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

            let parsed;
            try {
                parsed = await parseWorkflowEmail(msg);
            } catch (error) {
                console.error('Admin sync could not load email attachments; leaving the email queued:', error);
                continue;
            }
            if (parsed) {
                db.createCaseDraft(emailRecord.id, parsed);
                miFileDrafts += 1;
            } else {
                db.markEmailIgnored(emailRecord.id, 'Not a court notification or authorized NEW LT FILING intake');
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
    .status.processed, .status.ready_to_file, .status.filing_prepared, .status.prepared, .status.passed, .status.uploaded, .status.active, .status.mapped, .status.applied {
      background: #e6f4ee;
      color: var(--ok);
    }
    .status.pending, .status.retry_queued, .status.retrying, .status.parsed, .status.new, .status.processing, .status.filing_in_progress {
      background: #e8f2fa;
      color: var(--accent-strong);
    }
    .status.failed, .status.validation_failed {
      background: #fdecec;
      color: var(--bad);
    }
    .status.partial_failure, .status.needs_review, .status.filing_reconciliation, .status.reconciliation_required, .status.missing, .status.needs_short_name, .status.needs_application {
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
      grid-template-columns: 18px minmax(0, 1fr) 22px;
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
    .toast button { padding: 2px; border: 0; background: transparent; min-height: 22px; }
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
    .draft-document-links,
    .draft-source-actions {
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
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 12px;
      border-bottom: 1px solid #cfd5db;
      background: #f8f9fb;
    }
    .draft-document-select {
      min-width: 0;
      flex: 1 0 100%;
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
      width: 100%;
    }
    .draft-source-actions {
      flex: 1 1 100%;
      flex-wrap: wrap;
    }
    .draft-source-actions button {
      min-height: 34px;
      padding: 0 9px;
      white-space: nowrap;
    }
    .draft-source-actions button.is-primary {
      border-color: #8a6d1f;
      color: #6f5512;
      background: #fff8dc;
    }
    .draft-source-actions button svg {
      width: 14px;
      height: 14px;
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
    .draft-preview-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
    }
    .draft-preview-actions svg {
      width: 14px;
      height: 14px;
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
    .draft-validation.is-ready {
      border-color: #a9cdb5;
      color: var(--good);
      background: #eef8f1;
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
    .draft-review-heading { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .draft-review-heading strong { font-size: 13px; }
    .draft-review-group { display: grid; gap: 8px; margin-top: 8px; }
    .draft-review-items { display: grid; gap: 8px; max-height: 220px; overflow-y: auto; padding: 2px; }
    .draft-review-group > strong { font-size: 11px; }
    .draft-review-group .draft-validation-row { align-items: center; }
    .draft-review-group .draft-validation-row > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .draft-review-group button { flex: 0 0 auto; padding: 4px; }
    .draft-review-heading button { font-size: 11px; white-space: normal; }
    .draft-field-source { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 10px; color: var(--muted); }
    .draft-field-source button { padding: 2px; min-height: 22px; }
    .draft-review-target { outline: 2px solid var(--accent); outline-offset: 3px; }
    #draftDocumentState { flex: 1 0 100%; min-width: 0; }
    #draftDocumentState:empty { display: none; }
    .court-rules-section { grid-column: 1 / -1; }
    .court-rule-row { display: grid; grid-template-columns: minmax(210px, 1.2fr) minmax(175px, 1fr) minmax(180px, 1.4fr) auto; gap: 12px; align-items: end; padding: 12px 0; border-bottom: 1px solid var(--line); }
    .court-rule-row input, .court-rule-row select { min-width: 0; width: 100%; }
    .court-rule-name { font-size: 12px; overflow-wrap: anywhere; }
    .court-rule-name span { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; }
    .court-rule-actions { display: flex; gap: 6px; }
    .court-rule-confirmation { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 360px; font-size: 12px; }
    #courtRuleConfirmed { width: 16px; height: 16px; min-height: 16px; margin: 0; flex: 0 0 16px; }
    @media (max-width: 820px) { .court-rule-row { grid-template-columns: minmax(0, 1fr); } }
    [data-draft-section], .draft-document-mapping, .draft-field { scroll-margin-block: 14px; }
    .draft-filing-job-panel {
      margin-bottom: 14px;
      padding: 11px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #f8fafb;
    }
    .draft-filing-job-heading,
    .draft-filing-job-meta,
    .draft-filing-job-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .draft-filing-job-heading {
      justify-content: space-between;
      margin-bottom: 7px;
    }
    .draft-filing-job-heading strong { font-size: 12px; }
    .draft-filing-job-meta { color: var(--muted); font-size: 11px; }
    .checkout-review-body { display: grid; gap: 9px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .checkout-review-body p { margin: 0; }
    .checkout-fees { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 7px 16px; margin: 4px 0; max-width: 460px; }
    .checkout-fees dt, .checkout-fees dd { margin: 0; }
    .checkout-fees dd { text-align: right; font-variant-numeric: tabular-nums; }
    .checkout-fees .checkout-total { border-top: 1px solid var(--line); padding-top: 8px; font-weight: 600; color: var(--text); }
    .checkout-account-choice { display: grid; gap: 7px; max-width: 460px; margin: 4px 0; }
    .checkout-account-choice select { min-width: 0; width: 100%; }
    .checkout-preflight { list-style: none; padding: 0; margin: 0; display: grid; gap: 7px; }
    .checkout-preflight li { display: flex; align-items: flex-start; gap: 7px; }
    .checkout-preflight svg { width: 15px; height: 15px; flex: 0 0 15px; margin-top: 1px; }
    .draft-validation.draft-result:not(.has-errors):not(.is-ready) { background: var(--panel); border-color: var(--line); color: var(--text); }
    [data-checkout-review] .draft-filing-job-actions { margin-top: 12px; }
    .draft-filing-job-error {
      margin-top: 8px;
      color: var(--bad);
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .draft-upload-progress { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; font-size: 12px; }
    .draft-upload-progress progress { width: 100%; height: 7px; display: block; margin: 7px 0; accent-color: var(--good); }
    .draft-upload-checklist { padding: 0; margin: 8px 0 0; list-style: none; }
    .draft-upload-checklist li { padding: 7px 0; border-top: 1px solid var(--line); }
    .draft-upload-checklist .file-heading { display: flex; gap: 8px; align-items: start; justify-content: space-between; }
    .draft-upload-checklist .file-heading > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    .draft-upload-current { overflow-wrap: anywhere; color: var(--muted); margin: 5px 0; }
    .reconciliation-files { max-height: 180px; overflow-y: auto; padding-left: 20px; overflow-wrap: anywhere; }
    .draft-acknowledgement { display: flex; gap: 9px; align-items: start; font-size: 13px; margin: 14px 0 0; }
    .draft-acknowledgement input { width: 16px; min-height: 16px; height: 16px; flex: 0 0 16px; margin-top: 3px; }
    .mifile-account-strip {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 10px;
      padding: 8px 9px;
      border: 1px solid #d7c989;
      border-radius: 5px;
      color: #624f09;
      background: #fffbe9;
      font-size: 11px;
    }
    .mifile-account-strip.production {
      border-color: #a9cdb5;
      color: var(--good);
      background: #eef8f1;
    }
    .mifile-account-strip.error {
      border-color: #db8881;
      color: var(--bad);
      background: #fff4f3;
    }
    .mifile-account-strip svg {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
    }
    .reconciliation-notice {
      margin-top: 9px;
      padding: 9px;
      border: 1px solid #d7c989;
      border-radius: 5px;
      color: #624f09;
      background: #fffbe9;
      font-size: 11px;
    }
    .draft-filing-log {
      max-height: 150px;
      margin-top: 9px;
      overflow: auto;
      border-top: 1px solid var(--line);
      font-size: 11px;
    }
    .draft-filing-log-row {
      display: grid;
      grid-template-columns: 74px 118px minmax(0, 1fr);
      gap: 7px;
      padding: 6px 0;
      border-bottom: 1px solid #e8edf1;
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
    .field-source.complaint {
      color: var(--good);
    }
    .field-source.derived {
      color: var(--warn);
    }
    .field-source.empty {
      color: var(--bad);
    }
    .draft-field.has-error input, .draft-field.has-error select {
      border-color: #db8881;
      background: #fffafa;
    }
    .draft-field.has-warning input, .draft-field.has-warning select {
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
    .draft-document-mapping > .draft-field-message { grid-column: 1 / -1; }
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
      grid-template-columns: minmax(0, 1fr) minmax(170px, 1fr) minmax(145px, .8fr) 34px 34px;
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
    .draft-document-mapping .document-contents-field { grid-column: 1 / -1; }
    .draft-document-mapping .document-contents-field .draft-field-label {
      display: flex;
      flex-wrap: wrap;
      white-space: normal;
      overflow: visible;
    }
    .draft-supporting-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 7px; }
    .draft-supporting-status > span { min-width: 0; overflow-wrap: anywhere; }
    .draft-supporting-status button { flex: 0 0 30px; width: 30px; height: 30px; padding: 0; }
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
    .draft-source-summary {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: #fafbfc;
    }
    .draft-source-summary strong {
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    .draft-source-summary span {
      color: var(--muted);
      font-size: 10px;
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
        flex-wrap: nowrap;
      }
      .draft-document-select { flex: 0 0 auto; min-width: 0; width: 100%; }
      .draft-document-select select {
        width: 100%;
      }
      .draft-document-links {
        width: 100%;
      }
      .draft-source-actions {
        flex: 0 0 auto;
        width: 100%;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .draft-source-actions button {
        min-width: 0;
        white-space: normal;
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
        grid-template-columns: minmax(0, 1fr) 34px 34px;
      }
      .draft-document-mapping > .draft-field:first-child,
      .draft-document-mapping .filing-type-field,
      .draft-document-mapping .filing-relation-field {
        grid-column: 1 / -1;
      }
    }
    .draft-primary-toggle {
      width: 34px;
      min-width: 34px;
      height: 36px;
      padding: 0;
    }
    .draft-primary-toggle.is-primary {
      border-color: #8a6d1f;
      color: #6f5512;
      background: #fff8dc;
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
    .settings-layout { max-width: 850px; padding: 24px; }
    .draft-panel-toolbar { flex: 0 0 auto; }
    .draft-pdf-viewer iframe { min-height: 0; }
    .draft-workspace-shell { border-radius: 4px; box-shadow: none; min-height: 600px; }
    .draft-workspace { grid-template-columns: minmax(0, 1.15fr) minmax(440px, 1fr); }
    .draft-workspace-header { grid-template-columns: auto minmax(0, 1fr) auto auto; }
    .draft-workspace-actions { flex-wrap: nowrap; }
    .draft-create-actions { display: flex; align-items: center; gap: 8px; }
    @media (max-width: 620px) {
      #draftList table, #draftList tbody { display: block; width: 100%; min-width: 0; }
      #draftList thead { display: none; }
      #draftList tr[data-open-draft] {
        display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px 14px; padding: 12px; border-bottom: 1px solid var(--line);
      }
      #draftList tr[data-open-draft] td {
        display: block !important; width: auto; min-width: 0; padding: 0; border: 0;
      }
      #draftList td:nth-child(2), #draftList td:nth-child(3), #draftList td:nth-child(7) { grid-column: 1 / -1; }
      #draftList td:nth-child(2) { order: -2; }
      #draftList td:nth-child(3) { order: -1; }
      #draftList .draft-parties { white-space: normal; overflow-wrap: anywhere; }
      #draftList td[data-label]::before {
        display: block; margin-bottom: 3px; content: attr(data-label);
        color: var(--muted); font-size: 9px; font-weight: 700; text-transform: uppercase;
      }
      #draftList td:nth-child(2)::before, #draftList td:nth-child(3)::before { display: none; }
    }
    .draft-tools-menu { position: relative; }
    .draft-tools-menu > summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line); background: #fff; }
    .draft-tools-menu > summary::-webkit-details-marker { display: none; }
    .draft-tools-menu[open] > summary { background: #e9edef; }
    .draft-tools-items { position: absolute; z-index: 25; top: calc(100% + 5px); right: 0; display: grid; width: 230px; max-width: calc(100vw - 44px); padding: 6px; gap: 3px; background: #fff; border: 1px solid var(--line); border-radius: 4px; box-shadow: 0 6px 18px #18212b22; }
    .draft-tools-items button { width: 100%; justify-content: flex-start; border-color: transparent; white-space: normal; font-size: 12px; min-height: 36px; padding: 7px 9px; }
    .draft-tools-items button:hover { background: #f0f3f4; }
    .draft-preview-actions { display: flex; gap: 6px; align-items: center; }
    .draft-preview-actions .draft-tools-items { left: 0; right: auto; }
    .draft-panel-toolbar { gap: 8px; padding: 10px; }
    .draft-document-select { flex: 1 1 100%; }
    .draft-fields-panel { overflow: hidden; }
    .draft-fields-heading { min-height: 44px; padding: 10px 16px; background: #fff; }
    .draft-section-tabs { display: flex; gap: 0; padding: 0 12px; border-bottom: 1px solid var(--line); flex: 0 0 auto; }
    .draft-section-tabs button { flex: 1; padding: 11px 6px; min-width: 0; min-height: 42px; border: 0; border-radius: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .draft-section-tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); font-weight: 700; }
    .draft-section-tabs button { transition: none; }
    .toast-region.draft-toast-region { top: 74px; bottom: auto; }
    #draftDocumentCount { font-size: 11px; color: var(--muted); }
    #draftFieldsForm { flex: 1; min-height: 0; overflow: auto; padding: 18px 16px; }
    .draft-next-action { display: flex; gap: 12px; align-items: center; justify-content: space-between; border-top: 1px solid var(--line); padding: 12px 16px; background: #f8faf9; flex: 0 0 auto; }
    .draft-next-action > div { min-width: 0; }
    .draft-next-action strong, .draft-next-action span { display: block; overflow-wrap: anywhere; }
    .draft-next-action strong { font-size: 12px; }
    .draft-next-action span { font-size: 11px; color: var(--muted); margin-top: 3px; }
    #draftPrepareBtn { max-width: 100%; white-space: normal; min-width: 150px; justify-content: center; }
    .draft-overview-row { padding: 13px 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .draft-overview-row > div { min-width: 0; }
    .draft-overview-row small, .draft-overview-row span { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; white-space: pre-line; overflow-wrap: anywhere; }
    .draft-overview-row strong { font-size: 13px; overflow-wrap: anywhere; }
    .draft-overview-row small { font-size: 10px; margin: 0 0 5px; font-weight: 650; text-transform: uppercase; }
    .draft-overview-files { display: grid; gap: 0; margin-top: 18px; }
    .draft-overview-file { display: flex; align-items: center; gap: 9px; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .draft-overview-file > svg { flex: 0 0 16px; width: 16px; height: 16px; color: var(--good); }
    .draft-overview-file.needs-review > svg { color: var(--warn); }
    .draft-overview-file > span { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
    .draft-overview-file small { display: block; color: var(--muted); font-size: 11px; margin-top: 3px; }
    .draft-field-section { margin-bottom: 20px; }
    .draft-field-source:empty { display: none; }
    .draft-optional { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 10px; }
    .draft-optional > summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--muted); padding-bottom: 12px; }
    .draft-optional.wide { grid-column: 1 / -1; }
    .draft-doc-details { border-bottom: 1px solid var(--line); padding: 0; }
    .draft-doc-details > summary { cursor: pointer; display: flex; gap: 8px; padding: 13px 0; align-items: center; list-style: none; }
    .draft-doc-details > summary::-webkit-details-marker { display: none; }
    .draft-doc-details > summary > span { flex: 1; min-width: 0; }
    .draft-doc-details > summary strong { display: block; font-size: 12px; overflow-wrap: anywhere; }
    .draft-doc-details > summary small { display: block; color: var(--muted); font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; }
    .draft-doc-details > summary svg { width: 15px; height: 15px; flex: 0 0 auto; }
    .draft-doc-details[open] > summary > svg { transform: rotate(90deg); }
    .draft-document-mapping { border: 0; border-radius: 0; padding: 5px 0 14px; background: transparent; }
    .draft-confirm-dialog { border: 1px solid var(--line); border-radius: 6px; padding: 24px; width: 460px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 32px); overflow: auto; color: var(--text); }
    .draft-confirm-dialog::backdrop { background: #1e242a66; }
    .draft-confirm-dialog h2 { font-size: 18px; margin: 0 0 12px; }
    .draft-confirm-dialog p { font-size: 13px; line-height: 1.65; white-space: pre-line; }
    .draft-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
    @media (max-width: 1080px) { .draft-workspace { grid-template-columns: minmax(0, 1fr) minmax(390px, 1fr); } }
    @media (max-width: 820px) {
      .draft-workspace { display: block; }
      body.draft-editing header.app-header > .header-actions { display: none; }
      .draft-workspace-header { grid-template-columns: auto minmax(0, 1fr) auto; }
      .draft-workspace-actions .draft-tools-items button { width: 100%; font-size: 12px; padding: 7px 9px; }
      .draft-fields-panel.mobile-active { overflow: hidden; }
      .draft-workspace-shell { height: calc(100dvh - 116px); min-height: 0; }
    }
    @media (max-width: 620px) {
      .draft-panel-toolbar { flex-direction: row; flex-wrap: wrap; align-items: center; }
      .draft-document-select { flex: 1 1 100%; }
      .draft-document-links { width: auto; margin-left: auto; }
      .draft-source-actions { display: grid; grid-template-columns: 1fr; width: 230px; }
      #draftFieldsForm { padding: 12px; }
      .draft-next-action { flex-wrap: wrap; padding: 10px 12px; gap: 8px; }
      .draft-next-action > div { flex: 1 1 100%; }
      #draftPrepareBtn { width: 100%; }
      .draft-workspace-shell { height: calc(100dvh - 116px); }
    }
    .settings-section { padding: 0 0 28px; margin-bottom: 24px; border-bottom: 1px solid var(--line); }
    .settings-section h2 { font-size: 18px; margin: 0 0 20px; }
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .settings-grid .field { min-width: 0; }
    .settings-grid input, .settings-grid select { width: 100%; min-width: 0; }
    .settings-value { overflow-wrap: anywhere; padding: 8px 0; }
    .settings-actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 20px; }
    #miFilePrimaryConfirmationLabel, #libraryConfirmationLabel { flex-wrap: nowrap; justify-content: flex-start; }
    #miFilePrimaryConfirmation, #libraryConfirmed { width: 18px; height: 18px; min-height: 18px; min-width: 18px; padding: 0; margin: 0; flex: 0 0 18px; }
    #libraryList td { overflow-wrap: anywhere; }
    #settingsMessage { margin: 16px 0; overflow-wrap: anywhere; }
    @media (max-width: 640px) {
      .settings-layout { padding: 16px; }
      .settings-grid { grid-template-columns: 1fr; }
      header.app-header > .controls { min-width: 0; max-width: 100%; }
      .nav-tabs { min-width: 0; max-width: 100%; overflow-x: auto; }
      .nav-tabs button { padding: 0 7px; gap: 5px; font-size: 12px; }
      #libraryList table, #libraryList tbody { display: block; width: 100%; }
      #libraryList thead { display: none; }
      #libraryList tr { display: grid; grid-template-columns: minmax(0, 1fr) 40px; padding: 12px 0; border-bottom: 1px solid var(--line); }
      #libraryList td { display: block; padding: 4px 8px; border: 0; grid-column: 1; }
      #libraryList td:last-child { grid-column: 2; grid-row: 1 / 4; padding: 4px 0; }
    }
    ${PDF_PREVIEW_STYLE}
    .draft-pdf-viewer > .pdf-preview { min-height: 320px; }
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
        <button id="settingsTab" type="button"><i data-lucide="settings"></i>Settings</button>
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
      <button id="signOutBtn" class="icon-button" type="button" title="Sign out" aria-label="Sign out"><i data-lucide="log-out"></i></button>
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
          <div class="draft-create-actions">
            <button id="newDraftBtn" class="primary" type="button"><i data-lucide="plus"></i>New case</button>
            <details class="draft-tools-menu" id="newDraftOptions">
              <summary class="icon-button" title="New case options" aria-label="New case options"><i data-lucide="ellipsis"></i></summary>
              <div class="draft-tools-items">
                <button id="newCustomDraftBtn" type="button"><i data-lucide="files"></i>New custom package</button>
              </div>
            </details>
          </div>
        </div>
        <div class="filter-bar draft-filter-bar">
          <label class="field">
            <span class="field-label">Source</span>
            <select id="draftSourceFilter">
              <option value="intake">New filing packages</option>
              <option value="all">All records, including court notices</option>
            </select>
          </label>
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
              <option value="filing_in_progress">Filing in progress</option>
              <option value="filing_reconciliation">Reconciliation required</option>
              <option value="filing_prepared">Prepared in MiFILE</option>
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
            <button id="draftSaveBtn" type="button" title="Save changes"><i data-lucide="save"></i>Save</button>
            <details class="draft-tools-menu" id="draftActionsMenu">
              <summary class="icon-button" title="More case actions" aria-label="More case actions"><i data-lucide="ellipsis"></i></summary>
              <div class="draft-tools-items">
            <button id="draftManualCopyBtn" class="hidden" type="button" title="Create a separate manual filing package from this notification"><i data-lucide="copy-plus"></i>Use as manual package</button>
            <button id="draftRejectBtn" class="danger" type="button"><i data-lucide="x"></i>Reject</button>
            <button id="draftApproveBtn" type="button"><i data-lucide="check-check"></i>Approve</button>
              </div>
            </details>
          </div>
        </div>
        <div class="draft-mobile-switch" role="group" aria-label="Draft workspace view">
          <button type="button" data-draft-mobile-mode="document" class="active"><i data-lucide="file-text"></i>Document</button>
          <button type="button" data-draft-mobile-mode="fields"><i data-lucide="clipboard-list"></i>Review</button>
        </div>
        <div class="draft-workspace">
          <section id="draftDocumentPanel" class="draft-document-panel">
            <div class="draft-panel-toolbar">
              <label class="draft-document-select">
                <span>Document</span>
                <select id="draftDocumentSelect" aria-label="Preview document"></select>
              </label>
              <div class="draft-preview-actions">
                <button id="draftAddDocumentBtn" type="button" title="Add one or more PDFs to this Draft"><i data-lucide="file-plus-2"></i>Add PDFs</button>
                <details class="draft-tools-menu" id="draftDocumentTools">
                  <summary class="icon-button" title="Document tools" aria-label="Document tools"><i data-lucide="ellipsis"></i></summary>
                  <div class="draft-source-actions draft-tools-items">
                <button id="draftPrimaryBtn" type="button" title="Use the selected document as the primary source"><i data-lucide="star"></i>Primary source</button>
                <button id="draftExtractBtn" type="button" title="Read the Complaint again; manual corrections are preserved"><i data-lucide="scan-text"></i>Re-read Complaint</button>
                <button id="draftLibraryBtn" type="button" title="Add missing Advice and Local forms"><i data-lucide="library"></i>Add standard forms</button>
                <button id="draftCourtRuleBtn" type="button" title="Apply the current rule to documents without a manual submission choice"><i data-lucide="list-checks"></i>Apply court rule</button>
                <button id="draftRemoveFormBtn" class="icon-button danger" type="button" title="Remove PDF from Draft only" aria-label="Remove PDF from Draft"><i data-lucide="trash-2"></i></button>
                <button id="draftReplaceDocumentBtn" type="button" title="Replace the selected PDF or upload a corrected file"><i data-lucide="replace"></i>Replace PDF</button>
                  </div>
                </details>
                <input id="draftDocumentFileInput" class="hidden" type="file" accept="application/pdf,.pdf" multiple>
              </div>
              <div class="draft-document-links">
                <a id="draftOneDriveLink" class="button-link" target="_blank" rel="noopener"><i data-lucide="cloud"></i>OneDrive</a>
                <a id="draftSourceLink" class="button-link" target="_blank" rel="noopener"><i data-lucide="download"></i>MiFILE</a>
              </div>
              <div id="draftDocumentState"></div>
            </div>
            <div id="draftPdfViewer" class="draft-pdf-viewer"></div>
          </section>
          <section id="draftFieldsPanel" class="draft-fields-panel">
            <div class="draft-fields-heading">
              <div>
                <strong id="draftSectionHeading">Package review</strong>
              </div>
              <span id="draftUnsavedBadge" class="unsaved-badge hidden">Unsaved</span>
                <span id="draftExtractionProgress" class="muted hidden" role="status">Reading Complaint...</span>
            </div>
            <nav class="draft-section-tabs" aria-label="Case review sections" role="tablist">
              <button id="draftReviewTab" type="button" role="tab" data-draft-tab="review" aria-controls="draftReviewPane">Review</button>
              <button id="draftDataTab" type="button" role="tab" data-draft-tab="data" aria-controls="draftDataPane">Case data</button>
              <button id="draftDocumentsTab" type="button" role="tab" data-draft-tab="documents" aria-controls="draftDocumentsPane">Documents <span id="draftDocumentCount"></span></button>
              <button id="draftActivityTab" type="button" role="tab" data-draft-tab="activity" aria-controls="draftActivityPane">Activity</button>
            </nav>
            <form id="draftFieldsForm">
              <div id="draftReviewPane" data-draft-pane="review" role="tabpanel" aria-labelledby="draftReviewTab">
                <div id="draftPreparationStatus"></div>
              <div id="draftValidationSummary"></div>
                <div id="draftReviewOverview"></div>
              </div>
              <div id="draftActivityPane" data-draft-pane="activity" role="tabpanel" aria-labelledby="draftActivityTab" class="hidden">
              <div id="draftFilingJobPanel"></div>
              <label class="draft-notes-field">
                <span>Reviewer notes</span>
                <textarea id="draftReviewerNotes" placeholder="Internal review notes"></textarea>
              </label>
              </div>
              <div id="draftFieldGroups"></div>
            </form>
            <div class="draft-next-action">
              <div><strong id="draftNextActionTitle"></strong><span id="draftNextActionNote"></span></div>
              <button id="draftPrepareBtn" class="primary" type="button"><i data-lucide="check-check"></i>Confirm &amp; prepare</button>
            </div>
          </section>
        </div>
      </div>
      <dialog id="draftConfirmDialog" class="draft-confirm-dialog" aria-labelledby="draftConfirmTitle" aria-describedby="draftConfirmMessage">
        <form method="dialog">
          <h2 id="draftConfirmTitle"></h2>
          <p id="draftConfirmMessage"></p>
          <div id="draftConfirmSummary"></div>
          <div class="draft-confirm-actions"><button value="cancel">Cancel</button><button id="draftConfirmAccept" class="primary" value="confirm">Confirm</button></div>
        </form>
      </dialog>
    </section>
    <section id="settingsPane" class="full-span hidden settings-layout">
      <section class="settings-section">
        <h2>Email intake</h2>
        <div class="settings-grid">
          <div class="field"><span class="field-label">Automation inbox</span><div id="intakeMailbox" class="settings-value"></div></div>
          <div class="field"><span class="field-label">Subject prefix</span><div id="intakeSubject" class="settings-value"></div></div>
          <div class="field"><span class="field-label">Accepted senders</span><div id="intakeSenders" class="settings-value"></div></div>
          <div class="field"><span class="field-label">Package</span><div class="settings-value">One case per email · PDF attachments · 25 MB per file</div></div>
        </div>
      </section>
      <section class="settings-section">
        <h2>Microsoft connection</h2>
        <div class="settings-grid">
          <div class="field"><span class="field-label">Server sign-in</span><div id="microsoftAuthStatus" class="settings-value">Not checked</div></div>
          <div class="field"><span class="field-label">Inbox access</span><div id="microsoftInboxStatus" class="settings-value">Not checked</div></div>
          <div class="field"><span class="field-label">Worker OneDrive folder</span><div id="microsoftDriveStatus" class="settings-value">Not checked</div></div>
          <div class="field"><span class="field-label">File upload permission</span><div id="microsoftWriteStatus" class="settings-value">Not checked</div></div>
          <div class="field"><span class="field-label">Email sending permission</span><div id="microsoftSendStatus" class="settings-value">Not checked</div></div>
          <div class="field"><span class="field-label">Excel PDF destination</span><div id="microsoftExcelSaving" class="settings-value"></div></div>
        </div>
        <div class="settings-actions"><button id="microsoftCheck" type="button"><i data-lucide="plug-zap"></i>Check connection</button></div>
        <p id="microsoftCheckMessage" role="status" aria-live="polite"></p>
      </section>
      <section class="settings-section">
        <h2>Form library</h2>
        <form id="libraryUploadForm">
          <div class="settings-grid">
            <label class="field"><span class="field-label">Form</span><select id="libraryRole"><option value="advice">Advice (all courts)</option><option value="local">Local (one court)</option></select></label>
            <label class="field"><span class="field-label">Exact MiFILE court name</span><input id="libraryCourt" type="text" maxlength="300" disabled></label>
            <label class="field"><span class="field-label">PDF</span><input id="libraryFile" type="file" accept="application/pdf,.pdf" required></label>
          </div>
          <label id="libraryConfirmationLabel" class="settings-actions"><input id="libraryConfirmed" type="checkbox" required>I verified this form and its court assignment</label>
          <div class="settings-actions"><button id="libraryUploadBtn" class="primary" type="submit"><i data-lucide="upload"></i>Save form</button></div>
        </form>
        <p id="libraryMessage" role="status"></p>
        <div class="settings-actions"><label class="field"><span class="field-label">Import Advice / Local PDFs</span><input id="libraryBatchFiles" type="file" accept="application/pdf,.pdf" multiple></label>
          <button id="libraryBatchImport" type="button"><i data-lucide="folder-up"></i>Import selected forms</button></div>
        <div id="libraryImportResults" role="status"></div>
        <div id="libraryList" style="overflow-x:auto;max-width:100%"></div>
      </section>
      <section class="settings-section">
        <h2>MiFILE account</h2>
        <form id="miFileSettingsForm">
          <div class="settings-grid">
            <label class="field"><span class="field-label">Login email</span><input id="miFileAccountEmail" type="email" autocomplete="username" required></label>
            <label class="field"><span class="field-label">New password (blank keeps current)</span><input id="miFileAccountPassword" type="password" autocomplete="new-password" maxlength="1024"></label>
            <label class="field"><span class="field-label">Account</span><select id="miFileAccountType"><option value="test">Alternate account · Live MiFILE</option><option value="production">Primary account · Live MiFILE</option></select></label>
            <div class="field"><span class="field-label">Filer</span><div class="settings-value">Devlin, Adam</div></div>
            <div class="field"><span class="field-label">Preparation limit</span><div class="settings-value">History → Unsubmitted</div></div>
            <div class="field"><span class="field-label">Credentials</span><div id="miFileCredentialStatus" class="settings-value"></div></div>
          </div>
          <label id="miFilePrimaryConfirmationLabel" class="settings-actions hidden"><input id="miFilePrimaryConfirmation" type="checkbox">Activate this primary account</label>
          <div class="settings-actions">
            <button id="miFileAccountSave" type="submit" class="primary"><i data-lucide="save"></i>Verify and save</button>
            <button id="miFileAccountTest" type="button"><i data-lucide="plug-zap"></i>Test sign-in</button>
          </div>
        </form>
        <div id="settingsMessage" role="status" aria-live="polite"></div>
      </section>
      <section class="settings-section court-rules-section">
        <h2>Court filing rules</h2>
        <p class="muted">Attorney-confirmed defaults: Connected for 1, 17, 18, 32A, 41A-1, 45, 47, 54A, 56A, 66, 71A and 73A. Other for remaining District Courts. Saved overrides take precedence.</p>
        <form id="courtRuleForm">
          <div class="settings-grid">
            <label class="field"><span class="field-label">Exact MiFILE court</span><input id="courtRuleCourt" list="courtRuleCourts" required maxlength="300"></label>
            <label class="field"><span class="field-label">Supporting documents</span><select id="courtRuleRelation"><option value="manual_review">Manual review</option><option value="separate">Other - separate filing</option><option value="connected_to_complaint">Connected to Complaint</option></select></label>
            <label class="field"><span class="field-label">Exceptions / notes</span><input id="courtRuleNotes" maxlength="2000"></label>
          </div>
          <div class="settings-actions"><label class="court-rule-confirmation"><input id="courtRuleConfirmed" type="checkbox" required><span>Rule confirmed for all supporting PDFs in this court</span></label>
            <button type="submit" id="courtRuleSave" class="primary"><i data-lucide="plus"></i>Add rule</button></div>
        </form>
        <datalist id="courtRuleCourts"></datalist>
        <div id="courtRuleMessage" role="status" aria-live="polite"></div>
        <div id="courtRuleList"></div>
      </section>
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
              <option value="court_rule">Court rule</option>
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
  <script src="/assets/pdf-preview.js"></script>
  <script>
    const state = {
      summary: null,
      queue: [],
      selectedId: null,
      selectedIds: new Set(),
      detail: null,
      live: null,
      mifileConfig: null,
      plaintiffMappings: { mappings: [], missing: [] },
      activity: [],
      drafts: [],
      selectedDraftId: null,
      draftDetail: null,
      draftFilingJobs: [],
      activeDraftDocumentId: null,
      draftFileAction: null,
      draftDirty: false,
      draftEditRevision: 0,
      draftMobileMode: 'document',
      draftSection: 'review',
      draftMutationBusy: false,
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
      ready_to_file: 'Ready to prepare',
      needs_review: 'Needs review',
      needs_short_name: 'Needs short name',
      needs_application: 'Needs application',
      not_downloadable: 'Not downloadable',
      retry_queued: 'Retry queued',
      filing_in_progress: 'Preparing in MiFILE',
      filing_reconciliation: 'Reconciliation required',
      reconciliation_required: 'Reconciliation required',
      filing_prepared: 'Prepared in MiFILE',
      prepared: 'Prepared',
      filed_successfully: 'Filed successfully',
      filing_failed: 'Preparation failed',
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
      complaint: 'Complaint',
      manual: 'Manual',
      derived: 'Case title',
      default: 'Default',
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
    const validationPill = value => value === 'failed'
      ? '<span class="status needs_review">Incomplete</span>' : statusPill(value);

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
      if (tone !== 'error') root.querySelectorAll('.toast:not(.error)').forEach(item => item.remove());
      const toast = document.createElement('div');
      toast.className = 'toast' + (tone === 'error' ? ' error' : '');
      toast.innerHTML = icon(tone === 'error' ? 'circle-alert' : 'circle-check') +
        '<div>' + escapeHtml(message) + '</div><button type="button" title="Dismiss notification" aria-label="Dismiss notification">' + icon('x') + '</button>';
      root.appendChild(toast);
      while (root.children.length > 2) root.firstElementChild.remove();
      toast.querySelector('button').addEventListener('click', () => toast.remove());
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
      if (res.status === 401) {
        window.location.replace('/login');
        throw new Error('Please sign in again.');
      }
      const text = await res.text();
      const fallback = [502,503,504].includes(res.status)
        ? 'Service temporarily unavailable. Please try again shortly.'
        : res.ok ? 'Unexpected server response. Refresh this page and try again.'
        : 'Request failed (HTTP ' + res.status + '). Please try again.';
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(fallback);
      }
      if (!res.ok) {
        const message = payload && typeof payload.error === 'string' && !/<!doctype|<html[\s>]/i.test(payload.error)
          ? payload.error : fallback;
        throw new Error(message);
      }
      return payload;
    }

    function setView(view) {
      if (state.draftMutationBusy) {
        showToast('Please wait for the current operation to finish.');
        return;
      }
      state.view = view;
      document.body.classList.toggle('draft-editing', view === 'drafts' && Boolean(state.selectedDraftId));
      document.getElementById('toastRegion').classList.toggle('draft-toast-region', view === 'drafts' && Boolean(state.selectedDraftId));
      document.getElementById('queuePane').classList.toggle('hidden', view !== 'queue');
      document.getElementById('detailPane').classList.toggle('hidden', view !== 'queue');
      document.getElementById('draftsPane').classList.toggle('hidden', view !== 'drafts');
      document.getElementById('mappingsPane').classList.toggle('hidden', view !== 'mappings');
      document.getElementById('activityPane').classList.toggle('hidden', view !== 'activity');
      document.getElementById('settingsPane').classList.toggle('hidden', view !== 'settings');
      document.getElementById('settingsTab').classList.toggle('active', view === 'settings');
      document.getElementById('settingsTab').setAttribute('aria-current', view === 'settings' ? 'page' : 'false');
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
      } else if (view === 'settings') {
        loadAccountSettings().catch(error => { document.getElementById('settingsMessage').textContent = error.message; });
        loadLibraryForms().catch(error => { document.getElementById('libraryMessage').textContent = error.message; });
        loadCourtRules().catch(error => { document.getElementById('courtRuleMessage').textContent = error.message; });
      }
    }

    let accountSettingsBusy = false;
    function renderMicrosoftAccess(report, saving) {
      const reasons = {access_denied:'Access denied',not_found:'Not found',not_a_folder:'Configured link is not a folder',
        invalid_configuration:'Check server configuration',sign_in_failed:'Microsoft sign-in failed',
        timeout:'Timed out; try again',invalid_response:'Invalid Microsoft response; try again',unavailable:'Temporarily unavailable'};
      const checkLabel = value => !value ? 'Not checked' : value.status === 'ok' ? 'Connected' :
        value.status === 'not_configured' ? 'Not configured' : reasons[value.reason] || 'Check failed';
      const permissionLabel = value => value === 'granted_not_tested' ? 'Granted (not tested)' :
        value === 'not_granted' ? 'Not granted' : report ? 'Not verified' : 'Not checked';
      document.getElementById('microsoftAuthStatus').textContent = checkLabel(report && report.authentication);
      document.getElementById('microsoftInboxStatus').textContent = checkLabel(report && report.inbox);
      document.getElementById('microsoftDriveStatus').textContent = checkLabel(report && report.oneDrive);
      document.getElementById('microsoftWriteStatus').textContent = permissionLabel(report && report.fileWritePermission);
      document.getElementById('microsoftSendStatus').textContent = permissionLabel(report && report.mailSendPermission);
      document.getElementById('microsoftExcelSaving').textContent = saving === 'onedrive' ? 'Separate OneDrive folder configured' : 'Download to computer';
      if (report) document.getElementById('microsoftCheckMessage').textContent = 'Read-only check: ' + fmtDate(report.checkedAt);
    }
    document.getElementById('microsoftCheck').addEventListener('click', async () => {
      const button = document.getElementById('microsoftCheck');
      if (button.disabled) return;
      button.disabled = true;
      document.getElementById('microsoftCheckMessage').textContent = 'Checking Microsoft connection...';
      try {
        const result = await api('/api/settings/microsoft/check',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Action':'microsoft-access'},body:'{}'});
        renderMicrosoftAccess(result.report,result.excelSaving);
      } catch(error) { document.getElementById('microsoftCheckMessage').textContent = error.message; }
      finally { button.disabled = false; }
    });
    function courtRuleOptions(selected) {
      return [['manual_review','Manual review'],['separate','Other - separate filing'],['connected_to_complaint','Connected to Complaint']]
        .map(([value,label]) => '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + label + '</option>').join('');
    }
    async function loadCourtRules() {
      const result = await api('/api/court-rules');
      document.getElementById('courtRuleCourts').innerHTML = result.courts.map(court => '<option value="' + escapeHtml(court) + '"></option>').join('');
      const root = document.getElementById('courtRuleList');
      root.innerHTML = result.rules.length ? result.rules.map(rule =>
        '<div class="court-rule-row" data-court-rule="' + escapeHtml(rule.id) + '">' +
          '<div class="court-rule-name"><strong>' + escapeHtml(rule.courtName) + '</strong><span>' + escapeHtml(fmtDate(rule.createdAt)) + '</span></div>' +
          '<label class="field"><span class="field-label">Supporting documents</span><select data-rule-relation>' + courtRuleOptions(rule.relation) + '</select></label>' +
          '<label class="field"><span class="field-label">Exceptions / notes</span><input data-rule-notes maxlength="2000" value="' + escapeHtml(rule.notes) + '"></label>' +
          '<div class="court-rule-actions"><button type="button" class="icon-button" data-save-rule title="Save court rule" aria-label="Save court rule">' + icon('save') + '</button>' +
          '<button type="button" class="icon-button danger" data-disable-rule title="Disable court rule" aria-label="Disable court rule">' + icon('archive') + '</button></div></div>'
      ).join('') : '<p class="muted">No court filing rules configured.</p>';
      root.querySelectorAll('[data-court-rule]').forEach(row => {
        const rule = result.rules.find(item => item.id === row.dataset.courtRule);
        row.querySelector('[data-save-rule]').addEventListener('click', async event => {
          if (!confirm('Confirm this rule for all supporting PDFs in ' + rule.courtName + '? Existing Drafts keep their pinned version until reviewed.')) return;
          event.currentTarget.disabled = true;
          try {
            await api('/api/court-rules', {method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({courtName:rule.courtName,relation:row.querySelector('[data-rule-relation]').value,
                notes:row.querySelector('[data-rule-notes]').value,confirmed:true,expectedId:rule.id})});
            await loadCourtRules();
            document.getElementById('courtRuleMessage').textContent = 'New rule version saved. Existing manual document choices are unchanged.';
          } catch(error) { document.getElementById('courtRuleMessage').textContent=error.message; }
          finally { if(row.isConnected) row.querySelector('[data-save-rule]').disabled=false; }
        });
        row.querySelector('[data-disable-rule]').addEventListener('click', async () => {
          if (!confirm('Disable this rule? Drafts using it will need review before preparation.')) return;
          try { await api('/api/court-rules/' + encodeURIComponent(rule.id),{method:'DELETE'}); await loadCourtRules(); }
          catch(error) { document.getElementById('courtRuleMessage').textContent=error.message; }
        });
      });
      renderIcons();
    }
    document.getElementById('courtRuleForm').addEventListener('submit', async event => {
      event.preventDefault();
      const button=document.getElementById('courtRuleSave'); button.disabled=true;
      try {
        await api('/api/court-rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          courtName:document.getElementById('courtRuleCourt').value,relation:document.getElementById('courtRuleRelation').value,
          notes:document.getElementById('courtRuleNotes').value,confirmed:document.getElementById('courtRuleConfirmed').checked,expectedId:null})});
        document.getElementById('courtRuleForm').reset();
        await loadCourtRules();
        document.getElementById('courtRuleMessage').textContent='Court rule saved.';
      } catch(error) { document.getElementById('courtRuleMessage').textContent=error.message; }
      finally { button.disabled=false; }
    });
    async function loadLibraryForms() {
      const forms = await api('/api/form-library');
      document.getElementById('libraryList').innerHTML = forms.length ?
        '<table><thead><tr><th>Form / Court</th><th>PDF / Version</th><th>Status</th><th></th></tr></thead><tbody>' + forms.map(form =>
          '<tr><td>' + escapeHtml(form.role === 'advice' ? 'Advice / All courts' : 'Local / ' + form.courtName) + '</td><td>' +
          '<a target="_blank" rel="noreferrer" href="/api/form-library/' + encodeURIComponent(form.id) + '/content">' + escapeHtml(form.filename) + '</a>' +
          '<div class="muted">' + escapeHtml(new Date(form.createdAt).toLocaleString()) + '</div></td><td>' + (form.active ? 'Active' : 'Inactive') +
          '</td><td>' + (form.active ? '<button class="icon-button" data-disable-form="' + escapeHtml(form.id) + '" title="Disable for future drafts" aria-label="Disable form">' + icon('archive') + '</button>' : '') + '</td></tr>'
        ).join('') + '</tbody></table>' : '<p class="muted">No forms added</p>';
      renderIcons();
    }
    document.getElementById('libraryRole').addEventListener('change', () => {
      const local = document.getElementById('libraryRole').value === 'local';
      document.getElementById('libraryCourt').disabled = !local;
      document.getElementById('libraryCourt').required = local;
    });
    document.getElementById('libraryUploadForm').addEventListener('submit', async event => {
      event.preventDefault();
      const file = document.getElementById('libraryFile').files[0];
      const button = document.getElementById('libraryUploadBtn');
      const message = document.getElementById('libraryMessage');
      if (!file || button.disabled) return;
      if (file.size > 25 * 1024 * 1024) { message.textContent = 'The PDF must be within 25 MB.'; return; }
      button.disabled = true;
      try {
        await api('/api/form-library?role=' + encodeURIComponent(document.getElementById('libraryRole').value) +
          '&court=' + encodeURIComponent(document.getElementById('libraryCourt').value), {
            method: 'POST', headers: {'Content-Type':'application/pdf', 'X-File-Name':encodeURIComponent(file.name), 'X-Form-Confirmed':'true'}, body: file,
          });
        document.getElementById('libraryFile').value = '';
        document.getElementById('libraryConfirmed').checked = false;
        message.textContent = 'Form saved. Existing Draft documents keep their original version.';
        await loadLibraryForms();
      } catch (error) { message.textContent = error.message; }
      finally { button.disabled = false; }
    });
    document.getElementById('libraryList').addEventListener('click', async event => {
      const button = event.target.closest('[data-disable-form]');
      if (!button || !confirm('Disable this form for future Drafts? Existing documents will not be deleted.')) return;
      button.disabled = true;
      try { await api('/api/form-library/' + encodeURIComponent(button.dataset.disableForm), {method:'DELETE'}); await loadLibraryForms(); }
      catch (error) { document.getElementById('libraryMessage').textContent = error.message; button.disabled = false; }
    });
    document.getElementById('libraryBatchImport').addEventListener('click', async () => {
      const button = document.getElementById('libraryBatchImport');
      const files = Array.from(document.getElementById('libraryBatchFiles').files);
      if (!files.length || button.disabled) return;
      if (!confirm('Import these standard forms using their court numbers? Unmatched courts and special packets will be skipped. Existing active versions will be preserved.')) return;
      button.disabled = true;
      const root = document.getElementById('libraryImportResults');
      root.replaceChildren();
      try {
        for (const file of files) {
          const row = document.createElement('p'); root.appendChild(row);
          row.textContent = file.name + ': importing...';
          try {
            const result = await api('/api/form-library/import', {method:'POST',headers:{'Content-Type':'application/pdf','X-File-Name':encodeURIComponent(file.name)},body:file});
            row.textContent = file.name + ': saved - ' + (result.courtName || 'All courts');
          } catch (error) { row.textContent = file.name + ': not imported - ' + error.message; }
        }
        await loadLibraryForms();
      } finally { button.disabled = false; }
    });
    async function loadAccountSettings() {
      const data = await api('/api/settings');
      renderMicrosoftAccess(data.microsoft.report,data.microsoft.excelSaving);
      document.getElementById('intakeMailbox').textContent = data.intake.mailbox || 'Not configured';
      document.getElementById('intakeSubject').textContent = data.intake.subjectPrefix + ' - [case reference]';
      document.getElementById('intakeSenders').textContent = data.intake.allowedSenders.join(', ');
      document.getElementById('miFileAccountEmail').value = data.account.username;
      document.getElementById('miFileAccountPassword').value = '';
      document.getElementById('miFileAccountType').value = data.account.accountEnvironment;
      document.getElementById('miFilePrimaryConfirmation').checked = false;
      document.getElementById('miFilePrimaryConfirmationLabel').classList.toggle('hidden', data.account.accountEnvironment !== 'production');
      document.getElementById('miFileCredentialStatus').textContent = data.account.passwordConfigured
        ? (data.account.source === 'admin' ? 'Saved in admin · Encrypted' : 'Configured on server') : 'Not configured';
      document.getElementById('miFileAccountSave').disabled = !data.account.editable;
      document.getElementById('settingsMessage').textContent = data.account.error ||
        (!data.account.editable ? 'Account updates need server encryption and admin authentication to be configured.' : '');
    }

    async function testOrSaveAccount(save) {
      if (accountSettingsBusy) return;
      accountSettingsBusy = true;
      const message = document.getElementById('settingsMessage');
      const saveButton = document.getElementById('miFileAccountSave');
      const testButton = document.getElementById('miFileAccountTest');
      const previouslyDisabled = saveButton.disabled;
      saveButton.disabled = testButton.disabled = true;
      message.textContent = 'Verifying MiFILE sign-in...';
      try {
        await api(save ? '/api/settings/mifile' : '/api/settings/mifile/test', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Action': 'account-settings' },
          body: JSON.stringify({
            username: document.getElementById('miFileAccountEmail').value,
            password: document.getElementById('miFileAccountPassword').value,
            accountEnvironment: document.getElementById('miFileAccountType').value,
            productionConfirmed: document.getElementById('miFilePrimaryConfirmation').checked,
          }),
        });
        if (save) await loadAccountSettings();
        state.mifileConfig = await api('/api/mifile-config');
        message.textContent = save ? 'Sign-in verified. Account saved.' : 'Sign-in verified. No account changes saved.';
      } catch (error) {
        message.textContent = error.message;
      } finally {
        accountSettingsBusy = false;
        saveButton.disabled = previouslyDisabled;
        testButton.disabled = false;
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
        metric('Active drafts', (drafts.parsed || 0) + (drafts.needs_review || 0) +
          (drafts.validation_failed || 0) + (drafts.ready_to_file || 0) +
          (drafts.filing_in_progress || 0) + (drafts.filing_reconciliation || 0) +
          (drafts.filing_failed || 0), 'files'),
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
          '<td data-label="Received"><span class="cell-secondary">' + escapeHtml(fmtDate(item.receivedAt)) + '</span></td>' +
          '<td data-label="Case"><span class="draft-case">' + escapeHtml(item.caseNumber || 'Unassigned') + '</span>' +
            '<span class="cell-secondary">' + escapeHtml(item.subject || '(no subject)') + '</span></td>' +
          '<td data-label="Parties"><span class="draft-parties">' + escapeHtml(
            [item.plaintiff, item.defendant].filter(Boolean).join(' v. ') ||
            item.caseTitle ||
            'Parties not extracted',
          ) + '</span><span class="cell-secondary">' + escapeHtml(item.sender || '') + '</span></td>' +
          '<td data-label="Documents"><span class="draft-doc-count">' + icon('files') +
            escapeHtml(item.viewableDocumentCount + ' / ' + item.documentCount) + '</span>' +
            (item.failedDocumentCount
              ? '<span class="cell-secondary error-text">' + escapeHtml(item.failedDocumentCount) + ' failed</span>'
              : '<span class="cell-secondary">viewable</span>') + '</td>' +
          '<td data-label="Validation">' + validationPill(item.validationStatus) + '</td>' +
          '<td data-label="Status">' + statusPill(item.status) + '</td>' +
          '<td data-label="Updated"><span class="cell-secondary">' + escapeHtml(fmtDate(item.updatedAt)) + '</span></td>' +
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
        ' · Page ' + pagination.page + ' of ' + pagination.totalPages;
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
          source: document.getElementById('draftSourceFilter').value,
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
      state.draftSection = 'review';
      state.draftDetail = detail;
      state.draftFilingJobs = await api('/api/filing-jobs?caseDraftId=' +
        encodeURIComponent(draftId));
      state.draftDirty = false;
      const primary = (detail.documents || []).find(document => document.isPrimary);
      const viewable = (detail.documents || []).find(document => document.oneDriveUrl);
      state.activeDraftDocumentId = primary
        ? primary.id
        : viewable
          ? viewable.id
          : (detail.documents && detail.documents[0] ? detail.documents[0].id : null);
      document.getElementById('draftListView').classList.add('hidden');
      document.getElementById('draftWorkspaceView').classList.remove('hidden');
      document.body.classList.add('draft-editing');
      document.getElementById('toastRegion').classList.add('draft-toast-region');
      renderDraftWorkspace();
      autoExtractDraft(draftId).catch(showDraftError);
      refreshPreparedReceiptStatus().catch(() => {});
    }

    const receiptRefreshAttempts = new Map();
    let receiptRefreshBusy = false;
    async function refreshPreparedReceiptStatus() {
      const job = state.draftFilingJobs[0], draftId = state.selectedDraftId;
      if (!job || job.status !== 'prepared' || job.checkout?.active || receiptRefreshBusy ||
          !job.releaseChecks?.primaryAccountConfirmed || job.releaseChecks.testOnly || document.hidden) return;
      if (Date.now() - (receiptRefreshAttempts.get(job.id) || 0) < 60_000) return;
      receiptRefreshAttempts.set(job.id, Date.now());
      if (receiptRefreshAttempts.size > 100) receiptRefreshAttempts.delete(receiptRefreshAttempts.keys().next().value);
      receiptRefreshBusy = true;
      try {
        const checkout = await api('/api/filing-jobs/' + encodeURIComponent(job.id) + '/checkout/refresh-status',
          {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        if (state.selectedDraftId !== draftId || state.draftFilingJobs[0]?.id !== job.id) return;
        state.draftFilingJobs[0].checkout = checkout;
        renderDraftFilingJobs();
      } finally { receiptRefreshBusy = false; }
    }

    async function autoExtractDraft(draftId) {
      const originalDetail = state.draftDetail;
      const draft = state.draftDetail && state.draftDetail.caseDraft;
      if (!draft || !draft.filingEligible || !['not_started', 'failed'].includes(draft.filingStatus) || state.draftMutationBusy) return;
      const revision = state.draftEditRevision;
      const progress = document.getElementById('draftExtractionProgress');
      progress.classList.remove('hidden');
      try {
        const detail = await api('/api/drafts/' + encodeURIComponent(draftId) + '/auto-extract', {method:'POST'});
        if (state.selectedDraftId === draftId && state.draftDetail === originalDetail && !state.draftDirty && !state.draftMutationBusy && state.draftEditRevision === revision) {
          state.draftDetail = detail;
          renderDraftWorkspace();
        }
      } finally { if (state.selectedDraftId === draftId) progress.classList.add('hidden'); }
    }

    function closeDraft() {
      if (state.draftDirty && !window.confirm('Discard unsaved draft changes?')) return;
      state.selectedDraftId = null;
      state.draftDetail = null;
      state.draftFilingJobs = [];
      state.activeDraftDocumentId = null;
      state.draftDirty = false;
      if (draftPdfPreview) draftPdfPreview.destroy();
      draftPdfPreview = null;
      delete document.getElementById('draftPdfViewer').dataset.previewKey;
      document.getElementById('draftWorkspaceView').classList.add('hidden');
      document.body.classList.remove('draft-editing');
      document.getElementById('toastRegion').classList.remove('draft-toast-region');
      document.getElementById('draftListView').classList.remove('hidden');
      loadDrafts(true).catch(showDraftError);
    }

    function renderDraftWorkspace() {
      const detail = state.draftDetail;
      const draft = detail && detail.caseDraft;
      if (!detail || !draft) return;
      if (state.draftServerSnapshotOwner !== detail) {
        state.draftServerSnapshotOwner = detail;
        state.draftServerSnapshot = JSON.parse(JSON.stringify({fields:{...draft.editableData,
          supportingRequirement:draft.editableData?.supportingRequirement || 'auto',
          supportingRequirementReason:draft.editableData?.supportingRequirementReason || ''}, filingData:draft.filingData,
          documents:(detail.documents || []).map(doc=>({id:doc.id,filingName:doc.filingName || doc.currentFilename || '',filingType:doc.filingType || '',
            filingRelation:doc.filingRelation,requiredForFiling:doc.requiredForFiling,supportingKind:doc.supportingEvidence?.kind || 'unknown',
            sourceVersion:doc.sourceVersion ?? null,contentHash:doc.supportingEvidence?.contentHash ?? null})),
          supportingContextHash:draft.packageCompleteness?.contextHash ?? null,
          primaryDocumentId:draft.primaryDocumentId, reviewerNotes:draft.reviewerNotes || ''}));
      }
      const data = draft.editableData || {};
      const caseNumber = data.caseNumber || data.newCaseNumber ||
        data.temporaryCaseNumber || data.caseTitle || 'Unassigned draft';
      document.getElementById('draftWorkspaceCase').textContent = caseNumber;
      document.getElementById('draftWorkspaceSubject').textContent =
        detail.email.subject || '(no subject)';
      document.getElementById('draftWorkspaceStatuses').innerHTML =
        statusPill(draft.status);
      document.getElementById('draftApproveBtn').innerHTML = icon('check-check') +
        'Confirm package';
      const manualCopyButton = document.getElementById('draftManualCopyBtn');
      manualCopyButton.classList.add('hidden');
      document.getElementById('draftReviewerNotes').value = draft.reviewerNotes || '';
      renderDraftFields(draft);
      renderDraftFilingJobs();
      renderDraftDocuments(detail.documents || []);
      setDraftDirty(false);
      setDraftMobileMode(state.draftMobileMode);
      const draftLocked = state.draftMutationBusy || draft.filingStatus === 'queued' || [
        'filing_in_progress',
        'filing_reconciliation',
        'filing_prepared',
        'filed_successfully',
      ].includes(draft.status);
      if (draftLocked) {
        document.querySelectorAll('#draftFieldsForm input, #draftFieldsForm select, #draftFieldsForm textarea, #draftFieldGroups button:not([data-complaint-source]):not([data-preview-draft-document])')
          .forEach(control => { control.disabled = true; });
      }
      document.getElementById('draftReviewerNotes').disabled = draftLocked;
      document.getElementById('closeDraftBtn').disabled = Boolean(state.draftMutationBusy);
      document.getElementById('draftRejectBtn').disabled = draftLocked;
      manualCopyButton.disabled = draftLocked;
      document.getElementById('draftApproveBtn').disabled =
        draftLocked ||
        (draft.validationIssues || []).some(issue => issue.severity === 'error');
      updateDraftPreparationButton();
      renderIcons();
    }

    function updateDraftPreparationButton() {
      const draft = state.draftDetail && state.draftDetail.caseDraft;
      if (!draft) return;
      const button = document.getElementById('draftPrepareBtn');
      const issues = draft.validationIssues || [];
      const errors = issues.filter(issue => issue.severity === 'error').length;
      const prepared = ['filing_prepared', 'filed_successfully'].includes(draft.status);
      const filed = draft.status === 'filed_successfully';
      const unavailable = draft.filingEligible === false || draft.status === 'rejected';
      const reconcile = draft.status === 'filing_reconciliation';
      const running = draft.filingStatus === 'queued' || draft.status === 'filing_in_progress';
      const ready = state.mifileConfig && state.mifileConfig.ready;
      const progress = state.draftFilingJobs[0]?.progress;
      const outcome = state.draftFilingJobs[0]?.checkout?.outcome;
      const title = unavailable ? (draft.status === 'rejected' ? 'Package rejected' : 'Court notification') :
        filed ? 'Filed in MiFILE' : prepared ? outcome?.title || 'Saved in MiFILE' : reconcile ? 'Check MiFILE before retrying' :
        running ? (progress ? progress.stage + (progress.uploaded !== null && progress.total ? ' (' + progress.uploaded + ' / ' + progress.total + ')' : '') : 'Preparation in progress') : state.draftDirty ? 'Changes not saved' :
        errors ? errors + (errors === 1 ? ' correction needed' : ' corrections needed') :
        !ready ? 'MiFILE account needs attention' : 'Ready for your confirmation';
      document.getElementById('draftNextActionTitle').textContent = title;
      document.getElementById('draftNextActionNote').textContent = prepared
        ? filed ? 'Court filing recorded. Open MiFILE for details.' : outcome?.message || 'Preparation is complete. The current court result has not been checked.'
        : running ? 'You can leave this page. Preparation continues in the background.'
        : 'Destination: MiFILE Unsubmitted. No payment or court submission.';
      const label = unavailable ? (draft.status === 'rejected' ? 'Rejected' : 'Download history only') :
        prepared ? 'Open MiFILE' : reconcile ? 'Check result' : running ? 'View progress' :
        state.draftDirty ? 'Save & check' : errors ? 'Review corrections' : !ready ? 'Account settings' :
        draft.status === 'filing_failed' ? 'Retry preparation' : 'Confirm & prepare';
      button.innerHTML = icon(prepared ? 'external-link' : reconcile ? 'search' : running ? 'activity' :
        state.draftDirty ? 'save' : errors ? 'arrow-right' : !ready ? 'settings' : 'check-check') + escapeHtml(label);
      button.disabled = state.draftMutationBusy || draft.filingEligible === false || draft.status === 'rejected';
    }

    function setDraftSection(section, scroll = false) {
      if (!['review', 'data', 'documents', 'activity'].includes(section)) return;
      state.draftSection = section;
      document.querySelectorAll('[data-draft-tab]').forEach(button => {
        const selected = button.dataset.draftTab === section;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      document.querySelectorAll('[data-draft-pane]').forEach(pane =>
        pane.classList.toggle('hidden', pane.dataset.draftPane !== section));
      document.getElementById('draftSectionHeading').textContent = {
        review: 'Package review', data: 'Case data', documents: 'Filing documents', activity: 'Preparation & activity',
      }[section];
      if (scroll) document.getElementById('draftFieldsForm').scrollTop = 0;
    }

    function confirmDraftAction(title, message, label, summary = '', acknowledgement = '') {
      const dialog = document.getElementById('draftConfirmDialog');
      if (dialog.open) return Promise.resolve(false);
      document.getElementById('draftConfirmTitle').textContent = title;
      document.getElementById('draftConfirmMessage').textContent = message;
      document.getElementById('draftConfirmSummary').innerHTML = summary;
      document.getElementById('draftConfirmAccept').textContent = label;
      const accept = document.getElementById('draftConfirmAccept');
      accept.disabled = Boolean(acknowledgement);
      if (acknowledgement) {
        const row = document.createElement('label'); row.className = 'draft-acknowledgement';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'draftReconcileComplete';
        const text = document.createElement('span'); text.textContent = acknowledgement;
        checkbox.addEventListener('change', () => { accept.disabled = !checkbox.checked; });
        row.append(checkbox, text); document.getElementById('draftConfirmSummary').append(row);
      }
      dialog.returnValue = '';
      const previousFocus = document.activeElement;
      return new Promise(resolve => {
        dialog.addEventListener('close', () => {
          if (previousFocus && previousFocus.isConnected) previousFocus.focus();
          resolve(dialog.returnValue === 'confirm');
        }, { once: true });
        dialog.showModal();
      });
    }

    function renderDraftOverview(draft) {
      const data = draft.editableData || {};
      const filing = draft.filingData || {};
      const documents = state.draftDetail.documents || [];
      const partyName = party => party && (party.partyType === 'entity'
        ? party.entityName || party.displayName
        : [party.firstName, party.middleName, party.lastName].filter(Boolean).join(' ') || party.displayName) || 'Not entered';
      const partyAddress = party => party && [party.address1, party.address2,
        [party.city, party.state, party.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '';
      const row = (label, value, secondary, target) => '<div class="draft-overview-row"><div><small>' +
        escapeHtml(label) + '</small><strong>' + escapeHtml(value || 'Not entered') + '</strong>' +
        (secondary ? '<span>' + escapeHtml(secondary) + '</span>' : '') + '</div>' +
        '<button type="button" class="icon-button" data-open-draft-section="data" data-draft-jump="' + target +
        '" title="Review ' + escapeHtml(label) + '" aria-label="Review ' + escapeHtml(label) + '">' + icon('pencil') + '</button></div>';
      document.getElementById('draftReviewOverview').innerHTML =
        row('Court', data.courtName, filing.caseType, 'identifiers') +
        row('Plaintiff', partyName(filing.plaintiff), partyAddress(filing.plaintiff), 'plaintiff') +
        row('Defendants', (filing.defendants || []).map(partyName).join('; '),
          (filing.defendants || []).map(partyAddress).filter(Boolean).join('\n'), 'defendants') +
        row('Claim', filing.moneyJudgmentRequested === true ? 'Possession and money judgment' :
          filing.moneyJudgmentRequested === false ? 'Possession only' : 'Review paragraph 10',
          filing.moneyJudgmentRequested === true ? '$' + (filing.claimAmount || 'Not entered') : '', 'details') +
        '<div class="draft-overview-files"><div class="draft-section-heading"><h3>Documents (' + documents.length +
        ')</h3><button type="button" class="icon-button" data-open-draft-section="documents" title="Manage documents" aria-label="Manage documents">' + icon('sliders-horizontal') + '</button></div>' +
        documents.map(doc => {
          const attention = !doc.oneDriveUrl || (draft.validationIssues || []).some(issue => issue.field === 'document.' + doc.id);
          return '<div class="draft-overview-file' + (attention ? ' needs-review' : '') + '">' +
            icon(attention ? 'circle-alert' : 'file-check-2') + '<span>' +
            escapeHtml(statusLabel(doc.packageRole || doc.documentType || 'Document')) +
            '<small>' + escapeHtml(doc.filingRelation === 'connected_to_complaint' ? 'Connected to Complaint' :
              doc.filingType || 'Filing type not assigned') +
            (doc.formTemplate ? ' · Form library' : '') +
            (doc.requiredForFiling === false ? ' · Excluded' : '') + '</small></span>' +
            '<button type="button" class="icon-button" data-preview-draft-document="' + escapeHtml(doc.id) +
            '" title="Preview PDF" aria-label="Preview ' + escapeHtml(doc.currentFilename || 'PDF') + '">' + icon('eye') + '</button></div>';
        }).join('') + '</div>';
      document.getElementById('draftDocumentCount').textContent = documents.length;
      document.querySelectorAll('[data-open-draft-section]').forEach(button =>
        button.addEventListener('click', () => {
          setDraftSection(button.dataset.openDraftSection, true);
          const target = document.querySelector('[data-draft-section="' + button.dataset.draftJump + '"]');
          if (target) target.scrollIntoView({block:'start', behavior:'instant'});
        }));
      document.querySelectorAll('[data-preview-draft-document]').forEach(button => button.onclick = () => {
        state.activeDraftDocumentId = button.dataset.previewDraftDocument;
        renderDraftDocuments(documents);
        setDraftMobileMode('document');
      });
    }

    async function createDraft(packageMode) {
      const buttons = ['newDraftBtn','newCustomDraftBtn'].map(id => document.getElementById(id));
      buttons.forEach(button => { button.disabled = true; });
      document.getElementById('newDraftOptions').open = false;
      try {
        const detail = await api('/api/drafts', {method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify({packageMode})});
        await openDraft(detail.caseDraft.id);
      } catch (error) { showDraftError(error); }
      finally { buttons.forEach(button => { button.disabled = false; }); }
    }
    document.getElementById('newDraftBtn').addEventListener('click', () => createDraft('standard_lt'));
    document.getElementById('newCustomDraftBtn').addEventListener('click', () => createDraft('custom'));


    function renderCheckoutReview(job, open) {
      const checkout = job.checkout;
      const quote = checkout.quote;
      const money = cents => new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(cents / 100);
      const methods = quote?.availablePaymentMethods || [];
      const canChoose = checkout.checkoutVerified && !checkout.active && !checkout.receiptSummary.submissionObserved && quote?.totalCents > 0;
      return '<details class="draft-optional" data-checkout-review' + (open ? ' open' : '') + '><summary>Checkout & receipts' +
        (quote ? ' · ' + escapeHtml(money(quote.totalCents)) : '') + '</summary>' +
        '<div class="checkout-review-body"><strong>No payment or court submission is enabled.</strong>' +
        (checkout.active ? '<span role="status">Checking MiFILE: ' + escapeHtml(checkout.inspection.stage.replace(/_/g,' ')) + '</span>' : '') +
        (quote ? '<span>MiFILE account: ' + escapeHtml(quote.accountEmail) + '</span>' +
          '<dl class="checkout-fees">' + quote.lines.map(line => '<dt>' + escapeHtml(line.label) + '</dt><dd>' + escapeHtml(money(line.cents)) + '</dd>').join('') +
          '<dt class="checkout-total">Checkout total:</dt><dd class="checkout-total">' + escapeHtml(money(quote.totalCents)) + ' USD</dd></dl>' +
          '<span>Quote expires: ' + escapeHtml(fmtDate(quote.expiresAt)) + '</span>' : '<span>Check checkout to retrieve the exact total, including MiFILE processing fees.</span>') +
        (quote?.totalCents > 0 ? '<span>Payment account: ' + escapeHtml(checkout.selectedPaymentMethodLabel ||
          (quote.paymentMethodState === 'selected' ? 'Selected in MiFILE' : quote.paymentMethodState === 'missing' ? 'No payment account verified in this quote' :
            quote.paymentMethodState === 'unverified' ? 'Linked account not independently verified' : 'Not selected')) + '</span>' : '') +
        (methods.length && quote?.totalCents > 0 ? '<div class="checkout-account-choice"><label for="checkoutPaymentMethod">Payment account for fee check</label>' +
          '<select id="checkoutPaymentMethod"' + (!canChoose ? ' disabled' : '') + '><option value="">Choose an account</option>' +
          methods.map(method => '<option value="' + escapeHtml(method.fingerprint) + '"' +
            (checkout.paymentMethodChoice === method.fingerprint ? ' selected' : '') + '>' + escapeHtml(method.label) + '</option>').join('') + '</select>' +
          '<div class="draft-filing-job-actions"><button type="button" data-checkout-action="payment-method"' + (!canChoose || !checkout.paymentMethodChoice ? ' disabled' : '') + '>' +
          icon('credit-card') + 'Use for fee check</button></div></div>' : '') +
        (checkout.paymentMethodChoice ? '<div class="draft-filing-job-actions"><button type="button" data-checkout-action="clear-method"' +
          (checkout.active || checkout.receiptSummary.submissionObserved ? ' disabled' : '') + '>' + icon('x') + 'Clear account choice</button></div>' : '') +
        (checkout.confirmedAt ? '<span>Amount reviewed: ' + escapeHtml(fmtDate(checkout.confirmedAt)) + ' (review only)</span>' : '') +
        checkout.issues.map(issue => '<span class="draft-filing-job-error">' + escapeHtml(issue) + '</span>').join('') +
        (checkout.inspection?.error ? '<span class="draft-filing-job-error">' + escapeHtml(checkout.inspection.error) + '</span>' : '') +
        '<span>Receipt check: ' + escapeHtml(checkout.receiptCheckState || 'Not checked') + '</span>' +
        (checkout.receiptCheckIssue ? '<span>' + escapeHtml(checkout.receiptCheckIssue) + '</span>' : '') +
        (checkout.receipts.length ? '<ul>' + checkout.receipts.map(receipt => '<li>' + escapeHtml(receipt.status) +
          (receipt.documentId ? ' · ' + escapeHtml(job.payload?.documents.find(document => document.id === receipt.documentId)?.filingName || 'Document') : '') +
          (receipt.totalCents !== null ? ' · ' + escapeHtml(money(receipt.totalCents)) : '') +
          ' · ' + escapeHtml(fmtDate(receipt.occurredAt || receipt.observedAt)) +
          (receipt.message ? '<div>' + escapeHtml(receipt.message) + '</div>' : '') +
          (receipt.receiptUrl ? ' · <a target="_blank" rel="noopener" href="' + escapeHtml(receipt.receiptUrl) + '">Receipt</a>' : '') +
          '</li>').join('') + '</ul>' : '<span>No verified payment receipt recorded.</span>') +
        (checkout.preflight ? '<strong>Submission preflight</strong><ul class="checkout-preflight">' + checkout.preflight.checks.map(check =>
          '<li>' + icon(check.passed ? 'circle-check' : 'circle') + '<span>' + escapeHtml(check.label) + '</span></li>').join('') + '</ul>' +
          (checkout.preflight.complete ? '<span>Preflight complete. Live submission remains disabled.</span>' : '') +
          (checkout.preflight.recordedAt ? '<span>Preflight recorded: ' + escapeHtml(fmtDate(checkout.preflight.recordedAt)) + '</span>' : '') : '') +
        '</div><div class="draft-filing-job-actions"><button type="button" data-checkout-action="inspect"' + (checkout.active || !checkout.canInspect ? ' disabled' : '') + '>' +
        icon('refresh-cw') + 'Check checkout</button>' +
        '<button type="button" data-checkout-action="confirm"' + (!checkout.canConfirm || checkout.confirmedAt ? ' disabled' : '') + '>' +
        icon('check') + 'Confirm amount</button>' +
        '<button type="button" data-checkout-action="receipts"' + (checkout.active ? ' disabled' : '') + '>' +
        icon('receipt') + 'Refresh receipts</button></div></details>';
    }

    async function checkoutAction(job, action) {
      let payload = {};
      if (action === 'confirm') {
        const quote = job.checkout.quote;
        if (!quote || !job.checkout.canConfirm) throw new Error('Refresh checkout before confirming the amount.');
        const amount = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(quote.totalCents / 100);
        if (!await confirmDraftAction('Review exact checkout amount?',
          'Total: ' + amount + ' USD\\nAccount: ' + quote.accountEmail + '\\nTemporary case: ' + job.temporaryCaseNumber +
          '\\nPayment account: ' + (job.checkout.selectedPaymentMethodLabel || (quote.totalCents ? 'Selected in MiFILE' : 'Not required')) +
          '\\nThis records your review only. It does not authorize payment or submission to court.', 'Confirm ' + amount)) return;
        payload = {quoteId:quote.id,quoteDigest:quote.quoteDigest,totalCents:quote.totalCents};
      } else if (action === 'payment-method') {
        const quote = job.checkout.quote;
        const fingerprint = document.getElementById('checkoutPaymentMethod')?.value;
        if (!quote || !fingerprint) throw new Error('Choose an available payment account for the fee check.');
        payload = {quoteId:quote.id,quoteDigest:quote.quoteDigest,paymentMethodFingerprint:fingerprint};
      }
      await api('/api/filing-jobs/' + encodeURIComponent(job.id) + '/checkout/' + action,
        {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      state.draftFilingJobs = await api('/api/filing-jobs?caseDraftId=' + encodeURIComponent(state.selectedDraftId));
      renderDraftFilingJobs();
    }

    function renderDraftFilingJobs() {
      const root = document.getElementById('draftFilingJobPanel');
      const logWasOpen = Boolean(root.querySelector('[data-filing-log]')?.open);
      const releaseWasOpen = Boolean(root.querySelector('[data-release-checks]')?.open);
      const checkoutWasOpen = Boolean(root.querySelector('[data-checkout-review]')?.open);
      const pendingMethod = root.querySelector('#checkoutPaymentMethod')?.value;
      const previousJobId = root.dataset.jobId;
      const previousChecklist = root.querySelector('[data-upload-checklist]');
      const jobs = state.draftFilingJobs || [];
      const config = state.mifileConfig || {
        accountEnvironment: 'test',
        accountLabel: 'MiFILE account',
        preparationMode: 'unsubmitted_only',
        ready: false,
        issues: ['MiFILE account status is unavailable.'],
      };
      const accountTone = !config.ready
        ? ' error'
        : config.accountEnvironment === 'production' ? ' production' : '';
      const accountStrip = '<div class="mifile-account-strip' + accountTone + '">' +
        icon(!config.ready ? 'circle-alert' : config.accountEnvironment === 'production'
          ? 'shield-check' : 'flask-conical') +
        '<span><strong>' + escapeHtml(config.accountLabel) + '</strong> · ' +
          'Automation: Unsubmitted only. This app will not pay or submit to court.' +
        (!config.ready && config.issues && config.issues.length
          ? '<br>' + escapeHtml(config.issues.join(' '))
          : '') + '</span></div>';
      const latest = jobs[0];
      const outcome = latest?.status === 'prepared' ? latest.checkout?.outcome : null;
      document.getElementById('draftPreparationStatus').innerHTML = latest
        ? '<div class="draft-validation draft-result' + (outcome?.tone === 'warning' ? ' has-errors' :
            outcome?.tone === 'success' || outcome?.code === 'unsubmitted' ? ' is-ready' : '') + '"><strong>' +
          escapeHtml(outcome?.title || statusLabel(latest.status)) + '</strong><span>' +
          escapeHtml(latest.temporaryCaseNumber || (latest.status === 'reconciliation_required'
            ? 'Check History > Unsubmitted before another attempt.'
            : latest.status === 'running' ? 'Preparing documents in MiFILE.'
            : latest.status === 'failed' ? latest.errorMessage || 'Open Activity for details.' : 'Unsubmitted preparation')) +
          '</span>' + (outcome ? '<p>' + escapeHtml(outcome.message) + '</p>' +
            (outcome.checkedAt ? '<span>Last checked: ' + escapeHtml(fmtDate(outcome.checkedAt)) + (outcome.fresh ? '' : ' · Refresh needed') + '</span>' : '') +
            (outcome.filedDocuments || outcome.rejectedDocuments ? '<span>Filed documents: ' + outcome.filedDocuments + ' / ' + outcome.expectedDocuments +
              ' · Rejected documents: ' + outcome.rejectedDocuments + '</span>' : '') : '') +
          '<button type="button" data-show-preparation>View activity</button></div>' : '';
      const progressButton = document.querySelector('[data-show-preparation]');
      if (progressButton) progressButton.onclick = () => setDraftSection('activity', true);
      if (!jobs.length) {
        const eligibilityIssues = state.draftDetail.caseDraft.filingEligibilityIssues || [];
        root.innerHTML = accountStrip + '<div class="draft-filing-job-panel">' +
          '<div class="draft-filing-job-heading"><strong>MiFILE preparation</strong>' +
          statusPill(eligibilityIssues.length ? 'not_available' : 'not_started') + '</div>' +
          '<div class="draft-filing-job-meta">' + escapeHtml(
            eligibilityIssues.length
              ? eligibilityIssues[0].message
              : 'Confirm the package before MiFILE preparation.',
          ) + '</div>' +
        '</div>';
        return;
      }
      const job = jobs[0];
      root.dataset.jobId = job.id;
      const log = (job.executionLog || []).slice(-12).reverse();
      const progress = job.progress;
      const checklistOpen = previousChecklist?.dataset.jobStatus === job.status ? previousChecklist.open : ['failed','reconciliation_required'].includes(job.status);
      const uploadStatus = {pending:'Waiting',uploading:'Uploading',uploaded:'Verified',failed:'Failed',uncertain:'Check MiFILE'};
      const progressMarkup = !progress ? '' : '<div class="draft-upload-progress"><strong>' + escapeHtml(progress.stage) + '</strong>' +
        '<div>' + (progress.uploaded === null ? 'Upload count unconfirmed' : (progress.evidence === 'reported' ? 'Reported uploads: ' : progress.evidence === 'confirmed' ? 'PDFs checked by you: ' : 'Verified PDFs: ') + progress.uploaded + ' / ' + progress.total) + '</div>' +
        (progress.uploaded !== null && progress.total ? '<progress aria-label="PDF upload progress" max="' + progress.total + '" value="' + progress.uploaded + '"></progress>' : '') +
        (progress.currentFilename ? '<p class="draft-upload-current">' + escapeHtml(progress.currentFilename) + '</p>' : '') +
        (['verified','confirmed'].includes(progress.evidence) && progress.documents.length ? '<details class="draft-optional" data-upload-checklist data-job-status="' + escapeHtml(job.status) + '"' + (checklistOpen ? ' open' : '') + '><summary>PDF checklist (' + progress.total + ')</summary><ul class="draft-upload-checklist">' +
          progress.documents.map(document => '<li><div class="file-heading"><span>' + escapeHtml(document.filename) + '</span><span>' + escapeHtml(uploadStatus[document.status] || document.status) + '</span></div>' +
            (document.error ? '<div class="draft-filing-job-error">' + escapeHtml(document.error) + '</div>' : '') + '</li>').join('') + '</ul></details>' : '') + '</div>';
      root.innerHTML = accountStrip + '<div class="draft-filing-job-panel">' +
        '<div class="draft-filing-job-heading"><strong>MiFILE attempt ' +
          escapeHtml(job.attemptNumber) + '</strong>' + statusPill(job.status) + '</div>' +
        '<div class="draft-filing-job-meta">' +
          '<span>Checkpoint: ' + escapeHtml(job.checkpoint || 'queued') + '</span>' +
          '<span>Started: ' + escapeHtml(fmtDate(job.startedAt || job.createdAt)) + '</span>' +
          (job.durationMs !== null ? '<span>Duration: ' +
            escapeHtml(Math.round(Number(job.durationMs) / 1000)) + 's</span>' : '') +
          (job.temporaryCaseNumber ? '<span>Temporary case: ' +
            escapeHtml(job.temporaryCaseNumber) + '</span>' : '') +
        '</div>' +
        progressMarkup +
        (job.status === 'prepared' && job.releaseChecks ? '<details class="draft-optional" data-release-checks' + (releaseWasOpen ? ' open' : '') + '><summary>Before court submission</summary><div class="draft-filing-job-meta">' +
          (job.releaseChecks.testOnly ? '<strong>QA test package: Do not submit to court</strong>' : '') +
          '<span>Saved bundle: ' + (job.releaseChecks.savedBundleVerified ? 'Reopened and checked' : 'No automatic readback recorded') + '</span>' +
          '<span>Source PDF fingerprints: ' + (job.releaseChecks.sourceSnapshotPinned ? 'Recorded at preparation' : 'Not recorded') + '</span>' +
          '<span>Current account: ' + (job.releaseChecks.sameAccount ? 'Matches prepared bundle' : 'Needs verification') + '</span>' +
          '<span>Primary account: ' + (job.releaseChecks.primaryAccountConfirmed ? 'Confirmed' : 'Not confirmed for this bundle') + '</span>' +
          '<span>Displayed fees before checkout: ' + (job.releaseChecks.displayedSubtotalCents === null ? 'Not recorded' :
            escapeHtml(new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(job.releaseChecks.displayedSubtotalCents / 100))) + '</span>' +
          '<span>Checkout total and processing fee: ' + (job.checkout?.quote ? 'Read from MiFILE' : 'Not checked') + '</span>' +
          '<span>Payment and final court submission: Disabled</span>' +
          '</div></details>' : '') +
        (job.status === 'prepared' && job.checkout ? renderCheckoutReview(job, checkoutWasOpen) : '') +
        (job.errorMessage ? '<div class="draft-filing-job-error">' +
          escapeHtml((job.errorCode ? job.errorCode + ': ' : '') + job.errorMessage) + '</div>' : '') +
        (job.debugArtifactPath && job.errorMessage ? '<div class="draft-filing-job-actions"><a target="_blank" rel="noopener" href="/api/filing-jobs/' +
          encodeURIComponent(job.id) + '/screenshot">View diagnostic screenshot</a></div>' : '') +
        (job.status === 'reconciliation_required' ?
          '<div class="reconciliation-notice"><strong>Check MiFILE first.</strong> ' +
          'Open History → Unsubmitted and look for this case. Do not retry until the result is confirmed.</div>' +
          '<div class="draft-filing-job-actions">' +
          '<button type="button" data-reconcile-filing-job="found">' +
          icon('circle-check') + 'Bundle found</button>' +
          '<button type="button" data-reconcile-filing-job="not_found">' +
          icon('search-x') + 'No bundle found</button></div>' : '') +
        (job.status === 'failed' ? '<div class="draft-filing-job-actions">' +
          '<button type="button" data-retry-filing-job="' + escapeHtml(job.id) + '">' +
          icon('rotate-cw') + 'Retry preparation</button></div>' : '') +
        (log.length ? '<details class="draft-optional" data-filing-log' + (logWasOpen ? ' open' : '') + '><summary>Technical log (' + log.length + ')</summary><div class="draft-filing-log">' + log.map(entry =>
          '<div class="draft-filing-log-row"><span>' + escapeHtml(fmtDate(entry.at)) +
          '</span><strong>' + escapeHtml(entry.checkpoint) + '</strong><span>' +
          escapeHtml(entry.message) + '</span></div>').join('') + '</div></details>' : '') +
      '</div>';
      const methodSelect = root.querySelector('#checkoutPaymentMethod');
      if (methodSelect && previousJobId === job.id && pendingMethod !== undefined &&
          Array.from(methodSelect.options).some(option => option.value === pendingMethod)) methodSelect.value = pendingMethod;
      if (methodSelect) {
        const choiceButton = root.querySelector('[data-checkout-action="payment-method"]');
        const updateChoiceButton = () => { choiceButton.disabled = methodSelect.disabled || !methodSelect.value; };
        methodSelect.addEventListener('change', updateChoiceButton);
        updateChoiceButton();
      }
      root.querySelectorAll('[data-checkout-action]').forEach(button => {
        button.addEventListener('click', () => checkoutAction(job, button.dataset.checkoutAction).catch(showDraftError));
      });
      root.querySelectorAll('[data-retry-filing-job]').forEach(button => {
        button.addEventListener('click', () => {
          queueDraftFiling(true).catch(showDraftError);
        });
      });
      root.querySelectorAll('[data-reconcile-filing-job]').forEach(button => {
        button.addEventListener('click', () => {
          reconcileFilingJob(job.id, button.dataset.reconcileFilingJob)
            .catch(showDraftError);
        });
      });
      updateDraftPreparationButton();
      renderIcons();
    }

    async function reconcileFilingJob(jobId, resolution) {
      const found = resolution === 'found';
      const job = state.draftFilingJobs.find(item => item.id === jobId);
      const documents = job?.payload?.documents || [];
      if (found && !documents.length) throw new Error('The expected PDF list is unavailable. Contact support before confirming this bundle.');
      const message = found
        ? 'Check this case in MiFILE History → Unsubmitted. All listed PDFs, Filing Types and connections must be correct. Finding a case with only some of its PDFs is not sufficient.'
        : 'Confirm that no matching case exists in MiFILE History → Unsubmitted. Retry will be enabled.';
      const summary = found ? '<ul class="reconciliation-files">' + documents.map(document => '<li>' + escapeHtml(document.filename) + '<small> - ' + escapeHtml(document.filingRelation === 'connected_to_complaint' ? 'Connected to Complaint' : document.filingType) + '</small></li>').join('') + '</ul>' : '';
      if (!await confirmDraftAction('Confirm MiFILE result', message, found ? 'Confirm complete bundle' : 'No bundle found', summary,
        found ? 'I checked all ' + documents.length + ' PDFs, their Filing Types and connections in MiFILE.' : '')) return;
      await api('/api/filing-jobs/' + encodeURIComponent(jobId) + '/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution, verifiedDocumentIds: found ? documents.map(document => document.id) : [] }),
      });
      state.draftDetail = await api('/api/drafts/' +
        encodeURIComponent(state.selectedDraftId));
      state.draftFilingJobs = await api('/api/filing-jobs?caseDraftId=' +
        encodeURIComponent(state.selectedDraftId));
      renderDraftWorkspace();
      await loadDrafts(true);
      showToast(found ? 'Bundle confirmed as prepared.' : 'No bundle recorded. Retry is now available.');
    }

    async function refreshDraftFilingState() {
      if (!state.selectedDraftId || !state.draftDetail || state.draftDirty || state.draftMutationBusy || document.getElementById('draftConfirmDialog').open) return;
      const draftId = state.selectedDraftId;
      const revision = state.draftEditRevision;
      const jobs = await api('/api/filing-jobs?caseDraftId=' +
        encodeURIComponent(draftId));
      if (state.selectedDraftId !== draftId || state.draftDirty || state.draftMutationBusy || document.getElementById('draftConfirmDialog').open || state.draftEditRevision !== revision) return;
      const previous = state.draftFilingJobs[0];
      const latest = jobs[0];
      state.draftFilingJobs = jobs;
      if (!previous || !latest || previous.updatedAt !== latest.updatedAt) {
        const detail = await api('/api/drafts/' + encodeURIComponent(draftId));
        if (state.selectedDraftId !== draftId || state.draftDirty || state.draftMutationBusy || document.getElementById('draftConfirmDialog').open || state.draftEditRevision !== revision) return;
        state.draftDetail = detail;
        renderDraftWorkspace();
      } else {
        renderDraftFilingJobs();
      }
      refreshPreparedReceiptStatus().catch(() => {});
    }

    async function queueDraftFiling(isRetry) {
      if (state.draftMutationBusy || document.getElementById('draftConfirmDialog').open) return;
      let detail = state.draftDetail;
      if (!detail || !detail.caseDraft) return;
      if (state.draftDirty) await saveDraft(true);
      detail = state.draftDetail;
      const issues = detail.caseDraft.validationIssues || [];
      const blocking = issues.find(issue => issue.severity === 'error');
      if (blocking) {
        setDraftSection('review');
        focusDraftIssue(blocking);
        showToast('Complete the required corrections before preparing this package.', 'error');
        return;
      }
      if (!state.mifileConfig || !state.mifileConfig.ready) {
        throw new Error((state.mifileConfig && state.mifileConfig.issues || [
          'MiFILE account is not ready.',
        ]).join(' '));
      }
      const confirmedRevision = state.draftEditRevision;
      const expectedUpdatedAt = detail.caseDraft.updatedAt;
      if (!await confirmDraftAction(isRetry ? 'Retry MiFILE preparation?' : 'Confirm this package?',
        'Account: ' + state.mifileConfig.accountLabel + '\nFiler: Devlin, Adam (P72877).\n' +
        'The package will be saved to History > Unsubmitted. No payment or court submission will be made.' +
        (issues.length ? '\nReview notes: ' + issues.map(issue => issue.message).join(' ') : ''),
        isRetry ? 'Retry in Unsubmitted' : 'Confirm & prepare',
        '<div class="draft-overview-row"><div><strong>' + escapeHtml(detail.caseDraft.editableData.caseTitle || detail.email.subject || 'New case') +
        '</strong><span>' + escapeHtml(detail.caseDraft.editableData.courtName || '') + '</span><span>' +
        (detail.documents || []).filter(doc => doc.requiredForFiling !== false).length + ' included PDFs</span></div></div>',
      )) return;
      if (state.draftEditRevision !== confirmedRevision || state.selectedDraftId !== detail.caseDraft.id) {
        throw new Error('The package changed. Review it before confirming.');
      }
      const button = document.getElementById('draftPrepareBtn');
      state.draftMutationBusy = true;
      renderDraftWorkspace();
      setButtonBusy(button, true, 'Queueing');
      try {
        await api('/api/drafts/' + encodeURIComponent(detail.caseDraft.id) +
          '/filing-jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'prepare', retry: Boolean(isRetry), confirmPackage: true, expectedUpdatedAt }),
        });
        state.draftDetail = await api('/api/drafts/' +
          encodeURIComponent(detail.caseDraft.id));
        state.draftFilingJobs = await api('/api/filing-jobs?caseDraftId=' +
          encodeURIComponent(detail.caseDraft.id));
        await loadDrafts(true);
        showToast('MiFILE preparation queued. Progress will update here.');
      } finally {
        state.draftMutationBusy = false;
        setButtonBusy(button, false);
        if (state.selectedDraftId) renderDraftWorkspace();
      }
    }

    async function handleDraftNextAction() {
      const draft = state.draftDetail && state.draftDetail.caseDraft;
      if (!draft || state.draftMutationBusy) return;
      if (['filing_prepared', 'filed_successfully'].includes(draft.status)) {
        window.open('https://mifile.courts.michigan.gov/filings/myHistory', '_blank', 'noopener');
        return;
      }
      if (['filing_in_progress', 'filing_reconciliation'].includes(draft.status) || draft.filingStatus === 'queued') {
        setDraftSection('activity', true);
        setDraftMobileMode('fields');
        return;
      }
      if (!state.draftDirty && (draft.validationIssues || []).some(issue => issue.severity === 'error')) {
        setDraftSection('review', true);
        setDraftMobileMode('fields');
        return;
      }
      if (!state.mifileConfig || !state.mifileConfig.ready) { setView('settings'); return; }
      await queueDraftFiling(draft.status === 'filing_failed');
    }

    function renderDraftFields(draft) {
      const focusedControl = document.activeElement;
      const focusedField = focusedControl?.dataset?.reviewField;
      const selection = focusedField && typeof focusedControl.selectionStart === 'number'
        ? {start:focusedControl.selectionStart, end:focusedControl.selectionEnd, direction:focusedControl.selectionDirection}
        : null;
      const formScroll = document.getElementById('draftFieldsForm').scrollTop;
      const issues = draft.validationIssues || [];
      const issueByField = new Map(issues.map(issue => [issue.field, issue]));
      const sourceMap = draft.fieldSources || {};
      const data = draft.editableData || {};
      const filing = draft.filingData || {};
      const documents = (state.draftDetail && state.draftDetail.documents) || [];
      const validationRoot = document.getElementById('draftValidationSummary');

      if (!draft.filingEligible) {
        validationRoot.innerHTML = '<div class="draft-validation"><strong>Court notification</strong><p>This is court activity and download history. To prepare a new case, create a new Draft and upload its original documents.</p></div>';
      } else if (issues.length) {
        const hasErrors = issues.some(issue => issue.severity === 'error');
        const errorCount = issues.filter(issue => issue.severity === 'error').length;
        validationRoot.innerHTML = '<div class="draft-validation ' +
          (hasErrors ? 'has-errors' : '') + '">' +
          '<div class="draft-review-heading"><strong>' +
            (hasErrors ? 'Package needs correction' : 'Review before confirming') +
          '</strong><button type="button" data-review-next>' + icon('arrow-down-to-line') +
            'First item</button></div>' +
          ['error', 'warning'].map(severity => {
            const matching = issues.map((issue, index) => ({ issue, index }))
              .filter(item => item.issue.severity === severity);
            if (!matching.length) return '';
            return '<div class="draft-review-group"><strong>' + matching.length +
              (severity === 'error' ? ' required correction' : ' review note') +
              (matching.length === 1 ? '' : 's') + '</strong><div class="draft-review-items">' +
              matching.map(item => '<div class="draft-validation-row">' +
                icon(severity === 'error' ? 'circle-alert' : 'triangle-alert') +
                '<span>' + escapeHtml(item.issue.message) + '</span>' +
                '<button type="button" class="icon-button" data-review-issue="' + item.index +
                '" title="Review this item" aria-label="Review: ' + escapeHtml(item.issue.message) + '">' +
                  icon('arrow-right') + '</button></div>').join('') + '</div></div>';
          }).join('') +
          (errorCount ? '' : '<span>Required checks passed. Review the notes before confirming the package.</span>') + '</div>';
      } else if (draft.status === 'filing_prepared') {
        validationRoot.innerHTML = '';
      } else {
        validationRoot.innerHTML = '<div class="draft-validation is-ready">' +
          '<div class="draft-validation-row">' + icon('circle-check') +
          '<span>' + escapeHtml(draft.manualPackage ? 'Custom package is ready for confirmation.'
            : 'Landlord-tenant package passed validation.') +
          '</span></div></div>';
      }

      const primaryDocument = documents.find(document => document.isPrimary) || null;
      const extraction = draft.complaintExtraction || null;
      const extractionSummary = draft.manualPackage
        ? '<section class="draft-field-section" data-draft-section="source"><div class="draft-section-heading">' +
            '<h3>Manual filing package</h3><span class="field-source manual">Manual</span>' +
          '</div><div class="draft-source-summary">' +
            '<strong>Upload and classify the PDFs to include</strong>' +
            '<span>A Complaint can still be selected to extract fields, but it is not required. ' +
            'Advice and the court-specific Local form are added from the form library after the court is selected.</span>' +
          '</div></section>'
        :
        '<section class="draft-field-section" data-draft-section="source">' +
          '<div class="draft-section-heading"><h3>Primary data source</h3>' +
            (primaryDocument && primaryDocument.documentRole === 'primary_source'
              ? '<span class="field-source complaint">Complaint</span>'
              : '<span class="field-source empty">Missing Complaint</span>') +
          '</div>' +
          '<div class="draft-source-summary">' +
            '<strong>' + escapeHtml(primaryDocument
              ? (primaryDocument.currentFilename || primaryDocument.documentType || 'Complaint')
              : 'No primary Complaint selected') + '</strong>' +
            (extraction
              ? '<span>' + (extraction.extractionMethod === 'form_fields' ? 'PDF form fields · ' : extraction.textSource === 'ocr' ? 'Scan OCR · ' : extraction.extractionMethod === 'positioned_text' ? 'PDF text layout · ' : '') + 'Extracted ' + escapeHtml(fmtDate(extraction.extractedAt)) +
                ' | ' + escapeHtml((extraction.appliedFields || []).length) +
                ' field groups applied</span>' +
                '<span>' + escapeHtml(extraction.formType || 'Unknown Complaint type') +
                ' | Paragraph 10: ' + escapeHtml(
                  extraction.data && extraction.data.moneyJudgmentRequested === true
                    ? 'money judgment'
                    : extraction.data && extraction.data.moneyJudgmentRequested === false
                      ? 'possession only'
                      : 'review required',
                ) + '</span>'
              : '<span>Extraction has not been completed.</span>') +
          '</div>' +
        '</section>';

      const legacyGroups = DRAFT_FIELD_GROUPS.map((group, index) =>
        '<section class="draft-field-section" data-draft-section="' + (index ? 'references' : 'identifiers') + '"><h3>' + escapeHtml(group.title) + '</h3>' +
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
            '</label>';
          }).join('') +
          '</div></section>'
      );

      const filingSetup =
        '<section class="draft-field-section" data-draft-section="setup">' +
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
        '<section class="draft-field-section" data-draft-section="details">' +
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
            renderDraftSelect(
              'Money judgment (Complaint paragraph 10)',
              'data-filing-field="moneyJudgmentRequested"',
              filing.moneyJudgmentRequested === true
                ? 'true'
                : filing.moneyJudgmentRequested === false
                  ? 'false'
                  : '',
              [
                { value: '', label: 'Review required' },
                { value: 'false', label: 'No - possession only' },
                { value: 'true', label: 'Yes - supplemental money judgment' },
              ],
              true,
            ) +
            renderDraftInput(
              'Claim amount from paragraph 10',
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
              'data-filing-field="mailingRequested" disabled',
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
        '<section class="draft-field-section" data-draft-section="plaintiff">' +
          '<div class="draft-section-heading"><h3>Plaintiff</h3></div>' +
          renderDraftParty('plaintiff', 0, filing.plaintiff || {}, 'Plaintiff', false) +
        '</section>';

      const defendants = Array.isArray(filing.defendants) ? filing.defendants : [];
      const defendantSection =
        '<section class="draft-field-section" data-draft-section="defendants">' +
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
        '<section class="draft-field-section" data-draft-section="attorney">' +
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

      const completeness = draft.packageCompleteness || {};
      const supportingLabels = {unknown:'Review required', demand:'Demand for possession',
        notice_to_quit:'Notice to quit', none:'No Demand or Notice required'};
      const supportingSource = {manual:'Manual', complaint:'Complaint', documents:'Document contents', unknown:'Unknown'};
      const supportingRequirement =
        '<section class="draft-field-section" data-draft-section="supporting">' +
          '<div class="draft-section-heading"><h3>Supporting documents</h3>' +
            '<span class="field-source ' + (completeness.source === 'manual' ? 'manual' :
              completeness.source === 'complaint' ? 'complaint' : completeness.source === 'documents' ? 'derived' : 'empty') + '">' +
              escapeHtml(supportingSource[completeness.source] || 'Unknown') + '</span></div>' +
          '<div class="draft-field-grid">' +
            renderDraftSelect('Required supporting document',
              'data-draft-field="supportingRequirement" data-reviewed="' + Boolean(draft.supportingRequirementReviewed) + '"',
              data.supportingRequirement || 'auto', [
                {value:'auto',label:'Automatic'},
                {value:'demand',label:'Demand for possession'},
                {value:'notice_to_quit',label:'Notice to quit'},
                {value:'none',label:'No Demand or Notice required'},
              ], true) +
            renderDraftInput('Exception reason (10 characters minimum)',
              'data-draft-field="supportingRequirementReason" maxlength="1000"',
              data.supportingRequirementReason, true) +
          '</div><div class="draft-field-source draft-supporting-status">' +
            '<span data-supporting-requirement-status>' + escapeHtml(
              draft.supportingRequirementReviewed ? 'Review pending save' :
                (supportingLabels[completeness.requirement] || 'Review required') +
                (completeness.reviewStale ? ' - review required after package changes' : '')) + '</span>' +
            (completeness.reviewStale ? '<button type="button" class="icon-button" data-review-supporting-requirement' +
              (draft.supportingRequirementReviewed ? ' disabled' : '') +
              ' title="Reconfirm supporting requirement" aria-label="Reconfirm supporting requirement">' + icon('check-check') + '</button>' : '') +
          '</div></section>';

      const documentMappings =
        '<section class="draft-field-section" data-draft-section="documents">' +
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

      const previousOpen = new Set(Array.from(document.querySelectorAll('#draftFieldGroups details[open]'))
        .map(element => element.dataset.disclosure));
      document.getElementById('draftFieldGroups').innerHTML =
        '<div id="draftDataPane" data-draft-pane="data" role="tabpanel" aria-labelledby="draftDataTab">' +
          legacyGroups[0] + caseDetails + plaintiff + defendantSection +
          '<details class="draft-optional" data-disclosure="filing-setup"><summary>MiFILE setup & attorney</summary>' +
            filingSetup + attorney + '</details></div>' +
        '<div id="draftDocumentsPane" data-draft-pane="documents" role="tabpanel" aria-labelledby="draftDocumentsTab">' +
          supportingRequirement + documentMappings + '</div>' +
        '<div data-draft-pane="activity">' + extractionSummary + legacyGroups[1] + '</div>';
      decorateDraftReviewFields(draft);
      const identifierGrid = document.querySelector('[data-draft-section="identifiers"] .draft-field-grid');
      const identifiers = document.createElement('details');
      identifiers.className = 'draft-optional wide';
      identifiers.dataset.disclosure = 'assigned-identifiers';
      identifiers.innerHTML = '<summary>Assigned case numbers</summary><div class="draft-field-grid"></div>';
      ['caseNumber', 'temporaryCaseNumber', 'newCaseNumber'].forEach(field => {
        identifiers.lastElementChild.appendChild(identifierGrid.querySelector('[data-draft-field="' + field + '"]').closest('.draft-field'));
      });
      identifierGrid.appendChild(identifiers);
      document.querySelectorAll('[data-party-role]').forEach(party => {
        const optional = document.createElement('details');
        optional.className = 'draft-optional';
        optional.dataset.disclosure = party.dataset.partyRole + '-' + party.dataset.partyIndex;
        optional.innerHTML = '<summary>Additional party details</summary><div class="draft-field-grid"></div>';
        ['displayName', 'middleName', 'suffix', 'address2', 'phone', 'email'].forEach(field => {
          const input = party.querySelector('[data-party-field="' + field + '"]');
          if (input) optional.lastElementChild.appendChild(input.closest('.draft-field'));
        });
        party.appendChild(optional);
        const type = party.querySelector('[data-party-field="partyType"]');
        const syncPartyType = () => {
          party.querySelectorAll('[data-party-field]').forEach(input => {
            const field = input.dataset.partyField;
            if (!['entityName', 'firstName', 'middleName', 'lastName', 'suffix'].includes(field)) return;
            input.closest('.draft-field').classList.toggle('hidden', field === 'entityName'
              ? type.value !== 'entity' : type.value === 'entity');
          });
        };
        type.addEventListener('change', syncPartyType);
        syncPartyType();
      });
      const detailsSection = document.querySelector('[data-draft-section="details"] .draft-field-grid');
      const relatedDetails = document.createElement('details');
      relatedDetails.className = 'draft-optional wide';
      relatedDetails.dataset.disclosure = 'related-case';
      relatedDetails.innerHTML = '<summary>Related case details</summary><div class="draft-field-grid"></div>';
      ['relatedCaseCourt', 'relatedCaseDocketNumber', 'relatedCaseJudge', 'relatedCasePending'].forEach(field => {
        relatedDetails.lastElementChild.appendChild(detailsSection.querySelector('[data-filing-field="' + field + '"]').closest('.draft-field'));
      });
      detailsSection.appendChild(relatedDetails);
      const relatedAction = detailsSection.querySelector('[data-filing-field="relatedCivilAction"]');
      relatedAction.addEventListener('change', () => { relatedDetails.open = relatedAction.value === 'previously_filed'; });
      relatedDetails.open = relatedAction.value === 'previously_filed';
      document.querySelectorAll('#draftFieldGroups details[data-disclosure]').forEach(element => {
        if (previousOpen.has(element.dataset.disclosure)) element.open = true;
      });
      renderDraftOverview(draft);
      setDraftSection(state.draftSection);
      validationRoot.querySelectorAll('[data-review-issue]').forEach(button => {
        button.addEventListener('click', () => focusDraftIssue(issues[Number(button.dataset.reviewIssue)]));
      });
      const nextIssue = validationRoot.querySelector('[data-review-next]');
      if (nextIssue) nextIssue.addEventListener('click', () =>
        focusDraftIssue(issues.find(issue => issue.severity === 'error') || issues[0]));

      document.querySelectorAll(
        '#draftFieldsForm input, #draftFieldsForm select, #draftFieldsForm textarea',
      ).forEach(input => {
        input.addEventListener('input', () => setDraftDirty(true));
        input.addEventListener('change', () => setDraftDirty(true));
      });
      const moneyJudgment = document.querySelector(
        '[data-filing-field="moneyJudgmentRequested"]',
      );
      document.querySelectorAll('[data-document-field="filingRelation"], [data-document-field="filingType"], [data-document-field="supportingKind"]').forEach(input => {
        const markReviewed = () => {
          input.dataset.reviewed = 'true';
          if (input.dataset.documentField === 'supportingKind') {
            const source = input.closest('.draft-field').querySelector('.field-source');
            source.textContent = 'Review pending save';
            source.className = 'field-source manual';
          }
        };
        input.addEventListener('change', markReviewed);
        input.addEventListener('input', markReviewed);
      });
      const requirement = document.querySelector('[data-draft-field="supportingRequirement"]');
      const requirementReason = document.querySelector('[data-draft-field="supportingRequirementReason"]');
      const reconfirmRequirement = document.querySelector('[data-review-supporting-requirement]');
      const markRequirementReviewed = () => {
        requirement.dataset.reviewed = 'true';
        document.querySelector('[data-supporting-requirement-status]').textContent = 'Review pending save';
        if (reconfirmRequirement) reconfirmRequirement.disabled = true;
      };
      const syncRequirementReason = () => {
        const exception = requirement.value === 'none';
        requirementReason.closest('.draft-field').classList.toggle('hidden', !exception);
        requirementReason.required = exception;
        requirementReason.minLength = exception ? 10 : 0;
      };
      [requirement, requirementReason].forEach(input => {
        input.addEventListener('input', markRequirementReviewed);
        input.addEventListener('change', markRequirementReviewed);
      });
      requirement.addEventListener('change', syncRequirementReason);
      syncRequirementReason();
      if (reconfirmRequirement) reconfirmRequirement.addEventListener('click', () => {
        markRequirementReviewed();
        setDraftDirty(true);
      });
      const claimAmount = document.querySelector('[data-filing-field="claimAmount"]');
      const syncClaimAmount = () => {
        if (!moneyJudgment || !claimAmount) return;
        const possessionOnly = moneyJudgment.value === 'false';
        claimAmount.disabled = possessionOnly;
      };
      if (moneyJudgment) moneyJudgment.addEventListener('change', syncClaimAmount);
      syncClaimAmount();
      document.querySelectorAll('[data-set-primary-document]').forEach(button => {
        button.addEventListener('click', () => {
          setDraftPrimaryDocument(button.dataset.setPrimaryDocument).catch(showDraftError);
        });
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
      if (focusedField && !focusedControl.isConnected) {
        const replacement = Array.from(document.querySelectorAll('[data-review-field]'))
          .find(control => control.dataset.reviewField === focusedField);
        if (replacement && !replacement.disabled) {
          replacement.focus({preventScroll:true});
          if (selection) replacement.setSelectionRange(selection.start, selection.end, selection.direction);
          document.getElementById('draftFieldsForm').scrollTop = formScroll;
        }
      }
    }

    function draftIssueTarget(issue) {
      const field = issue.field;
      const root = document.getElementById('draftFieldGroups');
      const exact = Array.from(root.querySelectorAll('[data-review-field]'))
        .find(input => input.dataset.reviewField === field);
      if (exact) return exact;
      if (field === 'package.supporting') return root.querySelector('[data-draft-section="supporting"]');
      if (field.startsWith('document.')) {
        return Array.from(root.querySelectorAll('[data-draft-document-id]'))
          .find(row => row.dataset.draftDocumentId === field.slice(9));
      }
      if (field.startsWith('filingData.plaintiff') || field === 'plaintiff') {
        return root.querySelector('[data-party-role="plaintiff"]');
      }
      if (field.startsWith('filingData.defendants.') && field.split('.').length === 3) {
        return root.querySelector('[data-party-role="defendant"][data-party-index="' + Number(field.split('.')[2]) + '"]');
      }
      let section = 'source';
      if (field.startsWith('package.') || field === 'intake') section = 'documents';
      if (field.startsWith('filingData.defendants') || field === 'defendant') section = 'defendants';
      if (field.startsWith('complaintExtraction.related') || field.startsWith('complaintExtraction.claim')) section = 'details';
      if (field.startsWith('complaintExtraction.missing_plaintiff')) section = 'plaintiff';
      if (field.startsWith('complaintExtraction.missing_defendant') || field.startsWith('complaintExtraction.multiple_defendants')) section = 'defendants';
      if (field.startsWith('filingData.attorney')) section = 'attorney';
      return root.querySelector('[data-draft-section="' + section + '"]');
    }

    function focusDraftIssue(issue) {
      if (!issue) return;
      const target = draftIssueTarget(issue);
      if (!target) return;
      const pane = target.closest('[data-draft-pane]');
      if (pane) setDraftSection(pane.dataset.draftPane);
      let ancestor = target.parentElement;
      while (ancestor && ancestor.id !== 'draftFieldsForm') {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
        if (ancestor.classList.contains('draft-field')) ancestor.classList.remove('hidden');
        ancestor = ancestor.parentElement;
      }
      const row = target.closest('[data-draft-document-id]');
      if (row) {
        state.activeDraftDocumentId = row.dataset.draftDocumentId;
        renderDraftDocuments(state.draftDetail.documents || []);
      }
      setDraftMobileMode('fields');
      document.querySelectorAll('.draft-review-target').forEach(element => element.classList.remove('draft-review-target'));
      const wrapper = target.closest('.draft-field') || target;
      wrapper.classList.add('draft-review-target');
      const control = target.matches('input, select, textarea') ? target :
        Array.from(target.querySelectorAll('input:not(:disabled), select:not(:disabled), button:not(:disabled)'))
          .find(input => !input.value || input.value === 'unknown') ||
        target.querySelector('input:not(:disabled), select:not(:disabled), button:not(:disabled)');
      wrapper.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (control) control.focus({ preventScroll: true });
      else { wrapper.tabIndex = -1; wrapper.focus({ preventScroll: true }); }
    }

    function showDraftComplaintSource() {
      const primary = (state.draftDetail.documents || []).find(document => document.isPrimary);
      if (!primary) return;
      state.activeDraftDocumentId = primary.id;
      renderDraftDocuments(state.draftDetail.documents);
      setDraftMobileMode('document');
    }

    function decorateDraftReviewFields(draft) {
      const root = document.getElementById('draftFieldGroups');
      const extraction = draft.complaintExtraction;
      root.querySelectorAll('input, select').forEach(input => {
        const party = input.closest('[data-party-role]');
        let key = input.dataset.filingField;
        let field = key ? 'filingData.' + key : input.dataset.draftField;
        if (input.dataset.partyField && party) {
          key = party.dataset.partyRole === 'plaintiff' ? 'plaintiff' : 'defendants';
          field = 'filingData.' + key + (key === 'defendants' ? '.' + party.dataset.partyIndex : '') + '.' + input.dataset.partyField;
        }
        if (input.dataset.attorneyField) { key = 'attorney'; field = 'filingData.attorney.' + input.dataset.attorneyField; }
        if (!field) return;
        input.dataset.reviewField = field;
        if (!key) return;
        let source = (draft.filingFieldSources || {})[key] || 'empty';
        const storedDraft = JSON.parse(draft.normalizedDataJson || '{}');
        const paths = storedDraft.manualFilingPaths;
        const path = field.replace(/^filingData\./, '');
        if (source === 'manual' && Array.isArray(paths) && !paths.some(manual => path === manual || path.startsWith(manual + '.'))) {
          source = extraction?.appliedFields?.includes(key) ? 'complaint' : 'default';
        }
        const confidence = extraction && extraction.fieldConfidence && extraction.fieldConfidence[key];
        const policyDefault = (storedDraft.filingPolicy?.defaultPaths || []).includes(path) &&
          !(paths || []).some(manual => path === manual || path.startsWith(manual + '.')) && source !== 'manual';
        const sourceLabel = policyDefault ? 'Attorney rule' : source === 'complaint' && extraction
          ? extraction.extractionMethod === 'form_fields' ? 'PDF fields'
            : extraction.textSource === 'ocr' ? 'Scan OCR' : 'PDF text'
          : DRAFT_SOURCE_LABELS[source] || source;
        const label = input.closest('.draft-field');
        const empty = input.type !== 'checkbox' && !input.value;
        if (empty) return;
        label.insertAdjacentHTML('beforeend', '<span class="draft-field-source">' +
          escapeHtml(sourceLabel) +
          (!empty && source === 'complaint' && confidence && confidence !== 'high'
            ? ' · ' + escapeHtml(confidence === 'low' ? 'Check value' : 'Review value') : '') +
          (!empty && source === 'complaint' && draft.primaryDocumentId
            ? '<button type="button" class="icon-button" data-complaint-source title="Open source Complaint" aria-label="Open source Complaint">' + icon('file-search') + '</button>' : '') + '</span>');
      });
      (draft.validationIssues || []).forEach((issue, index) => {
        const target = draftIssueTarget(issue);
        if (!target) return;
        const wrapper = target.closest('.draft-field') || target;
        wrapper.classList.add('has-' + issue.severity);
        const messageId = 'draft-field-issue-' + index;
        if (target.matches('input, select')) {
          if (issue.severity === 'error') target.setAttribute('aria-invalid', 'true');
          target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), messageId].filter(Boolean).join(' '));
        }
        wrapper.insertAdjacentHTML('beforeend', '<span class="draft-field-message" id="' + messageId + '">' + escapeHtml(issue.message) + '</span>');
      });
      root.querySelectorAll('[data-complaint-source]').forEach(button => button.addEventListener('click', showDraftComplaintSource));
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
      const manualPackage = Boolean(state.draftDetail && state.draftDetail.caseDraft &&
        state.draftDetail.caseDraft.manualPackage);
      const coreDocument = !manualPackage &&
        ['complaint', 'advice', 'local', 'request', 'summons'].includes(document.packageRole);
      const supportingDocument = !document.packageRole || ['ancillary', 'unknown'].includes(document.packageRole);
      const supportingKind = document.supportingKind || document.supportingEvidence?.kind || 'unknown';
      const supportingReady = /^[a-f0-9]{64}$/.test(document.supportingEvidence?.contentHash || '');
      const supportingSource = document.supportingKindReviewed ? 'Review pending save' :
        !supportingReady ? 'Recognition pending' :
        document.supportingEvidence?.source === 'content' ? 'PDF contents' :
        document.supportingEvidence?.source === 'manual' ? 'Manual' : 'Unclassified';
      return '<details class="draft-doc-details" data-disclosure="document-' + escapeHtml(document.id) + '">' +
        '<summary>' + icon('chevron-right') + '<span><strong>' +
        escapeHtml(document.currentFilename || document.documentType || ('Document ' + (index + 1))) +
        '</strong><small>' + escapeHtml(document.filingType || 'Filing type not assigned') +
        (document.formTemplate ? ' · Form library' : '') + '</small></span>' +
        '<button type="button" class="icon-button" data-preview-draft-document="' + escapeHtml(document.id) +
        '" title="Preview PDF" aria-label="Preview PDF">' + icon('eye') + '</button></summary>' +
        '<div class="draft-document-mapping" data-draft-document-id="' +
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
            (document.isPrimary ? '<span>Primary source</span>' : '') +
            (document.documentRole && document.documentRole !== 'unknown'
              ? '<span>' + escapeHtml(statusLabel(document.documentRole)) + '</span>'
              : '') +
            (document.packageRole
              ? '<span>' + escapeHtml(statusLabel(document.packageRole)) + '</span>'
              : '') +
            (document.filingTypeSource
              ? '<span>' + escapeHtml(statusLabel(document.filingTypeSource)) + ' type</span>'
              : '') + '</span>' +
        '</label>' +
        '<label class="draft-field filing-type-field ' +
          (issue ? 'has-' + escapeHtml(issue.severity) : '') + '">' +
          '<span class="draft-field-label"><span>Filing Type</span></span>' +
          '<input type="text" list="mifileFilingTypes" data-document-field="filingType" data-reviewed="' + Boolean(document.filingTypeReviewed) + '" value="' +
            escapeHtml(document.filingType || '') + '">' +
        '</label>' +
        '<label class="draft-field filing-relation-field ' +
          (issue ? 'has-' + escapeHtml(issue.severity) : '') + '">' +
          '<span class="draft-field-label"><span>Submission</span></span>' +
          '<select data-document-field="filingRelation" data-reviewed="' + Boolean(document.filingRelationReviewed) + '"' +
            (coreDocument || document.packageRole === 'fee' ? ' disabled' : '') + '>' +
            '<option value="unknown"' +
              (document.filingRelation === 'unknown' ? ' selected' : '') + '>Review required</option>' +
            '<option value="separate"' +
              (document.filingRelation === 'separate' ? ' selected' : '') + '>Separate filing / Other</option>' +
            '<option value="connected_to_complaint"' +
              (document.filingRelation === 'connected_to_complaint' ? ' selected' : '') + '>Connect to Complaint</option>' +
          '</select>' +
          (document.filingRelationSource === 'court_rule' ? '<span class="draft-field-source">Court rule' +
            (document.courtRule?.notes ? ': ' + escapeHtml(document.courtRule.notes) : '') + '</span>' : '') +
        '</label>' +
        (document.documentRole === 'primary_source'
          ? '<button type="button" class="draft-primary-toggle icon-button ' +
              (document.isPrimary ? 'is-primary' : '') + '" data-set-primary-document="' +
              escapeHtml(document.id) + '" title="' +
              (document.isPrimary ? 'Primary data source' : 'Use as primary data source') +
              '" aria-label="' +
              (document.isPrimary ? 'Primary data source' : 'Use as primary data source') + '">' +
              icon('star') + '</button>'
          : '<span class="draft-primary-placeholder" aria-hidden="true"></span>') +
        '<label class="draft-document-required" title="Required for filing">' +
          '<input type="checkbox" data-document-field="requiredForFiling"' +
            (document.requiredForFiling ? ' checked' : '') +
            (coreDocument || document.packageRole === 'fee' ? ' disabled' : '') + '>' +
        '</label>' +
        (supportingDocument ? '<label class="draft-field document-contents-field">' +
          '<span class="draft-field-label"><span>Document contents</span><span class="field-source ' +
            (document.supportingKindReviewed || document.supportingEvidence?.source === 'manual' ? 'manual' :
              document.supportingEvidence?.source === 'content' ? 'derived' : 'empty') + '">' +
            escapeHtml(supportingSource) + '</span></span>' +
          '<select data-document-field="supportingKind" data-reviewed="' + Boolean(document.supportingKindReviewed) + '"' +
            (!supportingReady ? ' disabled title="Waiting for automatic PDF content recognition"' : '') + '>' +
            [{value:'unknown',label:'Unknown / review required'}, {value:'demand',label:'Demand for possession'},
              {value:'notice_to_quit',label:'Notice to quit'}, {value:'lease',label:'Lease'},
              {value:'deed',label:'Deed'}, {value:'affidavit',label:'Affidavit'}, {value:'other',label:'Other'}]
              .map(option => '<option value="' + option.value + '"' + (supportingKind === option.value ? ' selected' : '') +
                '>' + option.label + '</option>').join('') +
          '</select></label>' : '') +
      '</div></details>';
    }

    async function setDraftPrimaryDocument(documentId) {
      const detail = state.draftDetail;
      const draft = detail && detail.caseDraft;
      const documents = (detail && detail.documents) || [];
      const selectedDocument = documents.find(document => document.id === documentId);
      if (!draft || !documentId || !selectedDocument) {
        return;
      }
      if (selectedDocument.documentRole !== 'primary_source') {
        showToast('Only a Complaint can be used as the primary data source.', 'error');
        return;
      }
      if (draft.primaryDocumentId === documentId) return;
      snapshotDraftForm();
      draft.primaryDocumentId = documentId;
      if (draft.complaintExtraction && draft.complaintExtraction.documentId !== documentId) {
        draft.complaintExtraction = null;
      }
      documents.forEach(document => {
        document.isPrimary = document.id === documentId;
      });
      state.activeDraftDocumentId = documentId;
      renderDraftFields(draft);
      renderDraftDocuments(documents);
      setDraftDirty(true);
      await saveDraft(true);
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
        const primary = documents.find(document => document.isPrimary);
        const viewable = documents.find(document => document.oneDriveUrl);
        state.activeDraftDocumentId = (primary || viewable || documents[0]).id;
      }
      select.innerHTML = documents.length
        ? documents.map((document, index) =>
          '<option value="' + escapeHtml(document.id) + '" ' +
            (document.id === state.activeDraftDocumentId ? 'selected' : '') + '>' +
            escapeHtml(document.currentFilename || document.documentType || ('Document ' + (index + 1))) +
            (document.isPrimary ? ' · Primary' : '') +
            (document.oneDriveUrl ? '' : ' (not available)') +
          '</option>'
        ).join('')
        : '<option value="">No documents</option>';
      select.disabled = documents.length === 0;
      renderActiveDraftDocument(documents);
    }

    let draftPdfPreview = null;
    function renderActiveDraftDocument(documents) {
      const activeDocument = documents.find(
        item => item.id === state.activeDraftDocumentId,
      ) || null;
      const viewer = window.document.getElementById('draftPdfViewer');
      const oneDriveLink = window.document.getElementById('draftOneDriveLink');
      const sourceLink = window.document.getElementById('draftSourceLink');
      const primaryButton = window.document.getElementById('draftPrimaryBtn');
      const extractButton = window.document.getElementById('draftExtractBtn');
      const addButton = window.document.getElementById('draftAddDocumentBtn');
      const replaceButton = window.document.getElementById('draftReplaceDocumentBtn');

      updateDraftDocumentLink(oneDriveLink, activeDocument && activeDocument.oneDriveUrl);
      updateDraftDocumentLink(sourceLink, activeDocument && activeDocument.sourceUrl);
      const canBePrimary = Boolean(
        activeDocument && activeDocument.documentRole === 'primary_source',
      );
      const draft = state.draftDetail && state.draftDetail.caseDraft;
      const canModifyDocuments = Boolean(
        draft && !state.draftMutationBusy && state.draftDetail.email.processingStatus !== 'processing' && draft.filingEligible !== false && draft.filingStatus !== 'queued' &&
        !['filing_in_progress', 'filing_reconciliation', 'filing_prepared', 'filed_successfully']
          .includes(draft.status),
      );
      primaryButton.disabled = !canBePrimary || !canModifyDocuments;
      primaryButton.classList.toggle('is-primary', Boolean(activeDocument && activeDocument.isPrimary));
      primaryButton.innerHTML = icon('star') +
        (activeDocument && activeDocument.isPrimary
          ? 'Primary source'
          : canBePrimary ? 'Use as primary' : 'Not a Complaint');
      primaryButton.title = canBePrimary
        ? (activeDocument && activeDocument.isPrimary
          ? 'Primary data source'
          : 'Use this Complaint as the primary data source')
        : 'Only Complaint documents can be primary';
      const canExtract = Boolean(
        canModifyDocuments &&
        activeDocument &&
        activeDocument.isPrimary &&
        activeDocument.documentRole === 'primary_source' &&
        activeDocument.oneDriveUrl,
      );
      extractButton.disabled = !canExtract;
      addButton.disabled = !canModifyDocuments;
      window.document.getElementById('draftLibraryBtn').disabled = !canModifyDocuments ||
        JSON.parse(draft?.normalizedDataJson || '{}').sourceKind !== 'new_filing_intake';
      window.document.getElementById('draftCourtRuleBtn').disabled = !canModifyDocuments || !draft?.editableData?.courtName;
      replaceButton.disabled = !canModifyDocuments ||
        !activeDocument || activeDocument.status === 'retrying' || Boolean(activeDocument.formTemplate);
      window.document.getElementById('draftRemoveFormBtn').disabled = !canModifyDocuments || !activeDocument || activeDocument.status === 'retrying';
      const documentState = window.document.getElementById('draftDocumentState');
      const needsDownload = activeDocument && !['uploaded', 'downloaded', 'replaced'].includes(activeDocument.status);
      documentState.innerHTML = needsDownload
        ? '<div class="draft-document-status">' + statusPill(activeDocument.status) +
          (canModifyDocuments ? renderDocumentRetryAction(activeDocument) : '') + '</div>' +
          (activeDocument.errorMessage ? '<div class="draft-filing-job-error">' + escapeHtml(activeDocument.errorMessage) + '</div>' : '') +
          renderDocumentRetryInfo(activeDocument, state.draftDetail.retryPolicy) +
          renderDocumentFailureLog(activeDocument)
        : '';
      documentState.querySelectorAll('[data-retry-document]').forEach(button => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await retryDraftDocument(button.dataset.retryDocument); }
          catch (error) { showDraftError(error); }
          finally { button.disabled = false; }
        });
      });
      if (activeDocument && activeDocument.oneDriveUrl) {
        const previewKey = activeDocument.id + ':' + (activeDocument.updatedAt || '');
        if (viewer.dataset.previewKey !== previewKey) {
          const baseUrl = '/api/documents/' + encodeURIComponent(activeDocument.id);
          const version = '?v=' + encodeURIComponent(activeDocument.updatedAt || '');
          if (draftPdfPreview) draftPdfPreview.destroy();
          draftPdfPreview = null;
          viewer.dataset.previewKey = previewKey;
          try {
            draftPdfPreview = window.DevlinPdfPreview.create(viewer, {source:baseUrl + '/content' + version,
              label:activeDocument.currentFilename || activeDocument.documentType || 'PDF document'});
          } catch {
            viewer.innerHTML = '<div class="draft-preview-empty">' + icon('file-warning') +
              '<strong>Unable to start PDF preview</strong><a class="button-link" href="' + escapeHtml(baseUrl + '/preview' + version) +
              '" target="_blank" rel="noopener noreferrer">' + icon('external-link') + 'Open PDF</a></div>';
          }
        }
      } else {
        if (draftPdfPreview) draftPdfPreview.destroy();
        draftPdfPreview = null;
        delete viewer.dataset.previewKey;
        viewer.innerHTML = '<div class="draft-preview-empty">' + icon('file-question') +
          '<strong>PDF preview is not available</strong>' +
          '<span>' + escapeHtml(activeDocument
            ? 'This document has not been uploaded to OneDrive.'
            : 'No documents are attached to this draft.') + '</span></div>';
      }
      renderIcons();
    }

    function updateDraftDocumentLink(link, href) {
      if (href && !/^https?:\/\//i.test(href)) href = null;
      link.classList.toggle('is-disabled', !href);
      if (href) {
        link.href = href;
      } else {
        link.removeAttribute('href');
      }
    }

    async function retryDraftDocument(documentId) {
      if (state.draftDirty) await saveDraft(true);
      const draftId = state.selectedDraftId;
      const revision = state.draftEditRevision;
      await api('/api/documents/' + encodeURIComponent(documentId) + '/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Queued from Draft Editor' }),
      });
      const detail = await api('/api/drafts/' + encodeURIComponent(draftId));
      if (state.selectedDraftId === draftId && !state.draftDirty && state.draftEditRevision === revision) {
        state.draftDetail = detail;
        renderDraftWorkspace();
      }
      await loadDrafts(true);
      showToast('Document retry queued.');
    }

    function setDraftDirty(dirty) {
      if (dirty) state.draftEditRevision++;
      state.draftDirty = !!dirty;
      document.getElementById('draftUnsavedBadge').classList.toggle('hidden', !dirty);
      const draft = state.draftDetail && state.draftDetail.caseDraft;
      const locked = draft && (draft.filingStatus === 'queued' || [
        'filing_in_progress',
        'filing_reconciliation',
        'filing_prepared',
        'filed_successfully',
      ].includes(draft.status));
      document.getElementById('draftSaveBtn').disabled = !dirty || Boolean(locked);
      updateDraftPreparationButton();
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
        } else if (key === 'relatedCasePending' || key === 'moneyJudgmentRequested') {
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
          const filingRelation = root.querySelector('[data-document-field="filingRelation"]');
          const supportingKind = root.querySelector('[data-document-field="supportingKind"]');
          const current = state.draftDetail.documents.find(doc => doc.id === root.dataset.draftDocumentId);
          const original = state.draftServerSnapshot?.documents?.find(doc => doc.id === root.dataset.draftDocumentId);
          const supportingKindReviewed = Boolean(supportingKind && supportingKind.dataset.reviewed === 'true');
          const required = root.querySelector('[data-document-field="requiredForFiling"]');
          return {
            id: root.dataset.draftDocumentId,
            filingName: filingName ? filingName.value : '',
            filingType: filingType ? filingType.value : '',
            filingTypeReviewed: Boolean(filingType && filingType.dataset.reviewed === 'true'),
            filingRelation: filingRelation ? filingRelation.value : 'unknown',
            filingRelationReviewed: Boolean(filingRelation && filingRelation.dataset.reviewed === 'true'),
            supportingKind: supportingKind ? supportingKind.value : current?.supportingEvidence?.kind || 'unknown',
            supportingKindReviewed,
            ...(supportingKindReviewed ? {expectedSourceVersion:original?.sourceVersion ?? null,
              expectedContentHash:original?.contentHash ?? null} : {}),
            requiredForFiling: required ? required.checked : true,
          };
        },
      );
    }

    function snapshotDraftForm() {
      if (!state.draftDetail || !state.draftDetail.caseDraft) return;
      Object.assign(state.draftDetail.caseDraft.editableData, collectDraftFields());
      state.draftDetail.caseDraft.supportingRequirementReviewed =
        document.querySelector('[data-draft-field="supportingRequirement"]')?.dataset.reviewed === 'true';
      state.draftDetail.caseDraft.filingData = collectDraftFilingData();
      const mappings = new Map(
        collectDraftDocumentMappings().map(mapping => [mapping.id, mapping]),
      );
      state.draftDetail.documents.forEach(document => {
        const mapping = mappings.get(document.id);
        if (!mapping) return;
        document.filingName = mapping.filingName;
        document.filingType = mapping.filingType;
        document.filingTypeReviewed = mapping.filingTypeReviewed;
        document.filingRelation = mapping.filingRelation;
        document.filingRelationReviewed = mapping.filingRelationReviewed;
        document.supportingKind = mapping.supportingKind;
        document.supportingKindReviewed = mapping.supportingKindReviewed;
        document.requiredForFiling = mapping.requiredForFiling;
      });
    }

    async function saveDraft(silent) {
      const detail = state.draftDetail;
      if (!detail || !detail.caseDraft || state.draftMutationBusy) return;
      const payload = {
        base: state.draftServerSnapshot,
        fields: collectDraftFields(), filingData: collectDraftFilingData(),
        supportingRequirementReviewed: document.querySelector('[data-draft-field="supportingRequirement"]')?.dataset.reviewed === 'true',
        expectedSupportingContextHash: state.draftServerSnapshot?.supportingContextHash ?? null,
        documents: collectDraftDocumentMappings(), primaryDocumentId: detail.caseDraft.primaryDocumentId,
        reviewerNotes: document.getElementById('draftReviewerNotes').value,
      };
      state.draftMutationBusy = true;
      const controls = Array.from(document.querySelectorAll(
        '#draftFieldsForm input, #draftFieldsForm select, #draftFieldsForm textarea, #draftFieldGroups button:not([data-complaint-source]):not([data-preview-draft-document]), #closeDraftBtn, #draftRejectBtn, #draftApproveBtn, #draftPrepareBtn, .draft-preview-actions button',
      )).map(control => ({ control, disabled: control.disabled }));
      controls.forEach(({control}) => { control.disabled = true; });
      const button = document.getElementById('draftSaveBtn');
      setButtonBusy(button, true, 'Saving');
      let saved = false;
      try {
        state.draftDetail = await api('/api/drafts/' +
          encodeURIComponent(detail.caseDraft.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        state.draftDirty = false;
        saved = true;
        await loadDrafts(true);
        if (!silent) showToast('Draft changes saved.');
      } finally {
        state.draftMutationBusy = false;
        controls.forEach(({control, disabled}) => { control.disabled = disabled; });
        setButtonBusy(button, false);
        if (saved) renderDraftWorkspace();
        setDraftDirty(saved ? false : true);
      }
    }

    async function extractPrimaryComplaint() {
      const detail = state.draftDetail;
      if (!detail || !detail.caseDraft) return;
      if (state.draftDirty) await saveDraft(true);
      const button = document.getElementById('draftExtractBtn');
      setButtonBusy(button, true, 'Extracting');
      try {
        state.draftDetail = await api('/api/drafts/' +
          encodeURIComponent(detail.caseDraft.id) + '/extract-complaint', {
          method: 'POST',
        });
        state.draftDirty = false;
        const primary = (state.draftDetail.documents || []).find(document => document.isPrimary);
        state.activeDraftDocumentId = primary ? primary.id : state.activeDraftDocumentId;
        renderDraftWorkspace();
        await loadDrafts(true);
        showToast('Complaint fields extracted. Review the highlighted warnings.');
      } finally {
        setButtonBusy(button, false);
      }
    }

    function chooseDraftPdf(action) {
      if (!state.draftDetail || !state.draftDetail.caseDraft) return;
      if (action === 'replace' && !state.activeDraftDocumentId) return;
      state.draftFileAction = action;
      const input = document.getElementById('draftDocumentFileInput');
      input.value = '';
      input.multiple = action === 'add';
      input.click();
    }

    async function uploadDraftPdf(file) {
      const detail = state.draftDetail;
      const action = state.draftFileAction;
      if (!detail || !detail.caseDraft || !file || !action) return;
      if (!/\.pdf$/i.test(file.name) || file.type && file.type !== 'application/pdf') {
        throw new Error('Select a PDF file.');
      }
      if (file.size > 25 * 1024 * 1024) {
        throw new Error('MiFILE accepts PDF documents up to 25 MB.');
      }
      if (state.draftDirty) await saveDraft(true);
      if (action === 'replace' && !window.confirm(
        'Replace the selected PDF with this file? Existing OneDrive names and links are preserved. Complaint data will need to be extracted again.',
      )) return;

      const button = document.getElementById(
        action === 'replace' ? 'draftReplaceDocumentBtn' : 'draftAddDocumentBtn',
      );
      state.draftMutationBusy = true;
      renderDraftWorkspace();
      setButtonBusy(button, true, action === 'replace' ? 'Replacing' : 'Adding');
      try {
        const endpoint = action === 'replace'
          ? '/api/documents/' + encodeURIComponent(state.activeDraftDocumentId) + '/content'
          : '/api/drafts/' + encodeURIComponent(detail.caseDraft.id) + '/documents';
        const updated = await api(endpoint, {
          method: action === 'replace' ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/pdf',
            'X-File-Name': encodeURIComponent(file.name),
          },
          body: file,
        });
        if (state.selectedDraftId !== detail.caseDraft.id) return;
        state.draftDetail = updated;
        if (action === 'add') {
          const added = (state.draftDetail.documents || []).find(document =>
            !(detail.documents || []).some(existing => existing.id === document.id));
          if (added) state.activeDraftDocumentId = added.id;
        }
        state.draftDirty = false;
        renderDraftWorkspace();
        await loadDrafts(true);
        showToast(action === 'replace'
          ? 'PDF replaced. Re-extract the Complaint if it was the primary source.'
          : 'PDF added. Set its Filing Type and submission relation.');
      } finally {
        state.draftFileAction = null;
        if (state.selectedDraftId === detail.caseDraft.id) {
          try { state.draftDetail = await api('/api/drafts/' + encodeURIComponent(detail.caseDraft.id)); }
          catch { /* Keep the last response if a refresh is temporarily unavailable. */ }
        }
        state.draftMutationBusy = false;
        setButtonBusy(button, false);
        if (state.selectedDraftId) renderDraftWorkspace();
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
          (email.nextRetryAt ? '<div class="detail-meta">' + icon('clock') + 'Inbox retry: ' + escapeHtml(fmtDate(email.nextRetryAt)) + '</div>' : '') +
        '</div>' +
        (draft ? '<div class="detail-section">' +
          '<div class="detail-section-title"><span>' + icon('file-text') + 'Draft</span></div>' +
          '<div class="draft-status-grid">' +
            '<div class="draft-status-item"><span>Draft status</span>' + statusPill(draft.status) + '</div>' +
            '<div class="draft-status-item"><span>Validation</span>' + validationPill(draft.validationStatus) + '</div>' +
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
      if (doc.formTemplate) links.push('<span class="source-label">' + icon('library') + 'Library: ' + escapeHtml(doc.formTemplate.courtName || 'All courts') + '</span>');
      if (doc.recognition) links.push('<span class="source-label" title="' + escapeHtml(doc.recognition.message) + '">' + icon('scan-text') +
        escapeHtml(doc.filingTypeSource === 'manual' ? 'Type confirmed' : 'Type: ' + doc.recognition.source) + '</span>');
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
            const draftId = state.selectedDraftId;
            const revision = state.draftEditRevision;
            const detail = await api('/api/drafts/' + encodeURIComponent(draftId));
            if (state.selectedDraftId === draftId && !state.draftDirty && state.draftEditRevision === revision) {
              state.draftDetail = detail;
              renderDraftWorkspace();
            }
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

        const [summary, queuePage, live, mifileConfig] = await Promise.all([
          api('/api/summary'),
          api('/api/queue?' + params.toString()),
          api('/api/live-status'),
          api('/api/mifile-config'),
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
        state.mifileConfig = mifileConfig;
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
    document.getElementById('settingsTab').addEventListener('click', () => setView('settings'));
    document.getElementById('miFileAccountType').addEventListener('change', event => {
      document.getElementById('miFilePrimaryConfirmationLabel').classList.toggle('hidden', event.target.value !== 'production');
    });
    document.getElementById('miFileSettingsForm').addEventListener('submit', event => {
      event.preventDefault(); testOrSaveAccount(true);
    });
    document.getElementById('miFileAccountTest').addEventListener('click', () => testOrSaveAccount(false));
    document.getElementById('mappingsTab').addEventListener('click', () => setView('mappings'));
    document.getElementById('activityTab').addEventListener('click', () => setView('activity'));
    document.getElementById('closeDraftBtn').addEventListener('click', closeDraft);
    document.getElementById('draftSaveBtn').addEventListener('click', () => {
      saveDraft(false).catch(showDraftError);
    });
    document.getElementById('draftApproveBtn').addEventListener('click', () => {
      reviewDraft('approve').catch(showDraftError);
    });
    document.getElementById('draftPrepareBtn').addEventListener('click', () => {
      handleDraftNextAction().catch(showDraftError);
    });
    document.querySelectorAll('[data-draft-tab]').forEach(button => {
      button.addEventListener('click', () => setDraftSection(button.dataset.draftTab, true));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = Array.from(document.querySelectorAll('[data-draft-tab]'));
        const index = tabs.indexOf(button);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
          (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        setDraftSection(tabs[next].dataset.draftTab, true);
        tabs[next].focus();
      });
    });
    document.addEventListener('click', event => {
      document.querySelectorAll('.draft-tools-menu[open]').forEach(menu => {
        if (!menu.contains(event.target) || event.target.closest('button')) menu.open = false;
      });
    });
    document.getElementById('draftRejectBtn').addEventListener('click', () => {
      reviewDraft('reject').catch(showDraftError);
    });
    document.getElementById('draftDocumentSelect').addEventListener('change', event => {
      state.activeDraftDocumentId = event.target.value || null;
      renderActiveDraftDocument((state.draftDetail && state.draftDetail.documents) || []);
    });
    document.getElementById('draftPrimaryBtn').addEventListener('click', () => {
      setDraftPrimaryDocument(state.activeDraftDocumentId).catch(showDraftError);
    });
    document.getElementById('draftExtractBtn').addEventListener('click', () => {
      extractPrimaryComplaint().catch(showDraftError);
    });
    document.getElementById('draftAddDocumentBtn').addEventListener('click', () => {
      chooseDraftPdf('add');
    });
    document.getElementById('draftLibraryBtn').addEventListener('click', async () => {
      try {
        if (state.draftDirty) await saveDraft(true);
        state.draftDetail = await api('/api/drafts/' + encodeURIComponent(state.selectedDraftId) + '/standard-forms', { method:'POST' });
        renderDraftWorkspace();
      } catch (error) { showDraftError(error); }
    });
    document.getElementById('draftCourtRuleBtn').addEventListener('click', async () => {
      try {
        if (state.draftDirty) await saveDraft(true);
        state.draftDetail=await api('/api/drafts/'+encodeURIComponent(state.selectedDraftId)+'/court-rule',{method:'POST'});
        renderDraftWorkspace(); showToast('Court rule applied. Manual submission choices were preserved.');
      } catch(error) { showDraftError(error); }
    });
    document.getElementById('draftRemoveFormBtn').addEventListener('click', async () => {
      if (!confirm('Remove this PDF from the Draft? Its OneDrive copy will not be deleted. A required document must be added again before preparation.')) return;
      const draftId=state.selectedDraftId;
      const documentId=state.activeDraftDocumentId;
      try {
        if (state.draftDirty) await saveDraft(true);
        state.draftMutationBusy=true;
        renderDraftWorkspace();
        const updated=await api('/api/drafts/' + encodeURIComponent(draftId) + '/documents/' + encodeURIComponent(documentId), {method:'DELETE'});
        if(state.selectedDraftId===draftId) state.draftDetail=updated;
        await loadDrafts(true);
      } catch (error) { showDraftError(error); }
      finally{state.draftMutationBusy=false;if(state.selectedDraftId) renderDraftWorkspace();}
    });
    document.getElementById('draftReplaceDocumentBtn').addEventListener('click', () => {
      chooseDraftPdf('replace');
    });
    document.getElementById('draftDocumentFileInput').addEventListener('change', async event => {
      const files = Array.from(event.target.files || []);
      const action = state.draftFileAction;
      try {
        for (const file of (action === 'replace' ? files.slice(0, 1) : files)) {
          state.draftFileAction = action;
          await uploadDraftPdf(file);
        }
      } catch (error) { showDraftError(error); }
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
    document.getElementById('draftSourceFilter').addEventListener('change', resetDraftPageAndLoad);
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
    document.getElementById('signOutBtn').addEventListener('click', async () => {
      if (state.draftDirty && !confirm('Discard unsaved changes and sign out?')) return;
      try {
        await api('/auth/logout', { method: 'POST' });
        state.draftDirty = false;
        window.location.replace('/login');
      } catch (error) { alert(error.message); }
    });
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
      if (state.view === 'drafts' && state.selectedDraftId) {
        refreshDraftFilingState().catch(showDraftError);
      }
    }, 3000);
  </script>
</body>
</html>`;

export interface CreateAdminServerOptions {
    handleSignals?: boolean;
    closeDatabaseOnShutdown?: boolean;
    filingWorkerAvailable?: () => boolean;
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
    const automaticStatusRefreshAvailable = () => options.filingWorkerAvailable?.() === true &&
        !['false','0','no','off'].includes((process.env.MIFILE_AUTO_STATUS_REFRESH_ENABLED || 'true').toLowerCase()) &&
        !['false','0','no','off'].includes((process.env.MIFILE_FILING_WORKER_ENABLED || 'true').toLowerCase());

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

    let accountTestRunning = false;
    const decorateFilingJob = (job: NonNullable<ReturnType<typeof db.getFilingJob>>) => {
        let account = null;
        try { account = getCheckoutAccount(); } catch { /* Settings are shown separately. */ }
        const checkout = account ? db.checkout().state(job.id, account) : null;
        return { ...job, checkout, releaseChecks: {...filingReleaseChecks(job, account),
            checkoutVerified: checkout?.checkoutVerified || false,
            currentSourceContentVerified: checkout?.checkoutVerified || false} };
    };
    const authorize = createAdminAuth(Date.now, db.getAdminSessionStore());
    const excelPdf = createExcelPdfHandler({ sessions: db.getExcelSessionStore() });
    let microsoftReport: MicrosoftAccessReport | null = null;
    let microsoftCheck: Promise<MicrosoftAccessReport> | null = null;
    const microsoftSettings = () => ({report:microsoftReport,excelSaving:process.env.EXCEL_PDF_ONEDRIVE_SHARE_URL ? 'onedrive' : 'local'});
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

            if (req.method === 'GET' && url.pathname === '/healthz') {
                const mifileConfig = getMiFileRuntimeConfig();
                sendJson(res, 200, {
                    ok: true,
                    buildId: ADMIN_BUILD_ID,
                    mifile: {
                        accountEnvironment: mifileConfig.accountEnvironment,
                        preparationMode: mifileConfig.preparationMode,
                        ready: mifileConfig.ready,
                        automaticStatusRefreshEnabled: automaticStatusRefreshAvailable(),
                    },
                });
                return;
            }

            if (await excelPdf(req, res, url.pathname)) return;
            if (!await authorize(req, res, url.pathname)) return;

            if (req.method === 'GET' && url.pathname === '/assets/lucide.js') {
                sendJavascript(res, LUCIDE_BROWSER_SCRIPT);
                return;
            }
            if (req.method === 'GET' && url.pathname === '/assets/pdf-preview.js') {
                sendJavascript(res, Buffer.from(PDF_PREVIEW_SCRIPT));
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
            if (req.method === 'GET' && ['/assets/pdfjs/pdf.mjs', '/assets/pdfjs/pdf.worker.mjs'].includes(url.pathname)) {
                const name = url.pathname.endsWith('pdf.worker.mjs') ? 'pdf.worker.mjs' : 'pdf.mjs';
                sendJavascript(res, fs.readFileSync(require.resolve(`pdfjs-dist/build/${name}`)));
                return;
            }
            const pdfAsset = url.pathname.match(/^\/assets\/pdfjs\/(wasm|standard_fonts|cmaps)\/([a-zA-Z0-9_.-]+)$/);
            if (req.method === 'GET' && pdfAsset) {
                const filename = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), pdfAsset[1], pdfAsset[2]);
                if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) { sendJson(res, 404, {error:'PDF resource not found'}); return; }
                res.writeHead(200, { 'Content-Type': filename.endsWith('.wasm') ? 'application/wasm' : filename.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', 'Cache-Control':'private, max-age=86400' });
                res.end(fs.readFileSync(filename));
                return;
            }
            const previewMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/preview$/);
            if (req.method === 'GET' && previewMatch) {
                const documentId = decodeURIComponent(previewMatch[1]);
                if (!db.getDocumentAccess(documentId)) {
                    sendJson(res, 404, { error: 'Viewable PDF not found' });
                    return;
                }
                sendHtml(res, pdfPreviewHtml(documentId, url.searchParams.get('v') || ''));
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/mifile-config') {
                sendJson(res, 200, getMiFileRuntimeConfig());
                return;
            }

            if (req.method === 'GET' && url.pathname === '/api/settings') {
                const account = accountSettingsView();
                sendJson(res, 200, {
                    intake: getFilingIntakeConfig(),
                    account: { ...account, editable: account.editable && hasAdminCredentials() },
                    microsoft: microsoftSettings(),
                });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/settings/microsoft/check') {
                let originAllowed = !req.headers.origin;
                try { if (req.headers.origin) originAllowed = new URL(req.headers.origin).host === req.headers.host; } catch { /* Reject malformed origins. */ }
                if (!hasAdminCredentials() || !originAllowed || req.headers['sec-fetch-site'] === 'cross-site' ||
                    req.headers['x-admin-action'] !== 'microsoft-access' || !req.headers['content-type']?.startsWith('application/json')) {
                    sendJson(res,403,{error:'Use the authenticated Settings connection check.'}); return;
                }
                try {
                    const input=JSON.parse((await readRequestBuffer(req,1024)).toString('utf8'));
                    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error();
                } catch { sendJson(res,400,{error:'The connection check accepts no account or folder changes.'}); return; }
                if (!microsoftReport || Date.now()-Date.parse(microsoftReport.checkedAt) >= 30_000) {
                    if (!microsoftCheck) microsoftCheck = checkMicrosoftAccess().then(report=>microsoftReport=report).finally(()=>{microsoftCheck=null;});
                    await microsoftCheck;
                }
                sendJson(res,200,microsoftSettings()); return;
            }
            if (req.method === 'GET' && url.pathname === '/api/form-library') {
                sendJson(res, 200, db.listLibraryForms()); return;
            }
            if (req.method === 'GET' && url.pathname === '/api/court-rules') {
                sendJson(res,200,{rules:db.listCourtFilingRules(),courts:db.getKnownCourtNames()}); return;
            }
            if (req.method === 'POST' && url.pathname === '/api/court-rules') {
                try {
                    const input=JSON.parse(await readRequestBody(req));
                    if (input.expectedId !== null && typeof input.expectedId !== 'string') throw new Error('Reload the court rule list before saving.');
                    sendJson(res,201,db.saveCourtFilingRule(input));
                } catch(error) { sendJson(res,422,{error:(error as Error).message}); }
                return;
            }
            const courtRuleMatch=url.pathname.match(/^\/api\/court-rules\/([^/]+)$/);
            if(req.method==='DELETE' && courtRuleMatch){
                try { db.disableCourtFilingRule(decodeURIComponent(courtRuleMatch[1])); sendJson(res,200,{ok:true}); }
                catch(error){sendJson(res,409,{error:(error as Error).message});} return;
            }
            const applyCourtRuleMatch=url.pathname.match(/^\/api\/drafts\/([^/]+)\/court-rule$/);
            if(req.method==='POST' && applyCourtRuleMatch){
                try{sendJson(res,200,db.applyCourtFilingRule(decodeURIComponent(applyCourtRuleMatch[1]),true));}
                catch(error){sendJson(res,409,{error:(error as Error).message});} return;
            }
            if (req.method === 'POST' && url.pathname === '/api/drafts') {
                const body = await readRequestBody(req);
                let input;
                try { input = body ? JSON.parse(body) : {}; }
                catch { sendJson(res, 400, {error:'Invalid Draft request'}); return; }
                if (!input || typeof input !== 'object' || Array.isArray(input) ||
                    !['standard_lt','custom'].includes(input.packageMode ?? 'standard_lt')) {
                    sendJson(res, 400, {error:'Select a standard LT case or custom package'}); return;
                }
                const packageMode = input.packageMode ?? 'standard_lt';
                const message = {id:'manual-intake:' + randomUUID(),
                    subject:packageMode === 'custom' ? 'Custom filing package - PDF upload' : 'New LT case - PDF upload',
                    receivedDateTime:new Date().toISOString()};
                const parsed = buildManualDraft(message, null, packageMode);
                const email = db.registerEmail(message);
                const draftId = db.createCaseDraft(email.id, parsed);
                db.markEmailProcessed(email.id);
                sendJson(res, 201, db.refreshCaseDraftValidation(draftId));
                return;
            }

            if (req.method === 'POST' && /^\/api\/drafts\/[^/]+\/manual-copy$/.test(url.pathname)) {
                sendJson(res, 409, {
                    error: 'Court notifications cannot create new cases. Create a new Draft and upload the original case package.',
                });
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/form-library/import') {
                const content = await readRequestBuffer(req, 25 * 1024 * 1024);
                try {
                    const filename = uploadedPdfFilename(req.headers['x-file-name']);
                    const assignments = planFormImports(filename, db.getKnownCourtNames());
                    const currentForms = assignments.map(assignment => db.listLibraryForms().find(form => form.active &&
                        form.role === assignment.role && form.courtName === assignment.courtName && form.slotKey === assignment.slotKey));
                    for (const current of currentForms) if (current && !readFormPdf(db, current).equals(content)) {
                        throw new Error('An active form already exists. Review it and use Save form to replace it explicitly.');
                    }
                    const forms = [];
                    for (let index = 0; index < assignments.length; index++) forms.push(currentForms[index] ||
                        await saveFormPdf(db, {...assignments[index], filename, content}));
                    sendJson(res, currentForms.every(Boolean) ? 200 : 201, {
                        ...forms[0], courtName: forms.map(form => form.courtName || 'All courts').join('; '),
                    });
                } catch (error) { sendJson(res, 422, {error:(error as Error).message}); }
                return;
            }
            if (req.method === 'POST' && url.pathname === '/api/form-library') {
                const role = url.searchParams.get('role');
                if (!['advice', 'local'].includes(role || '') || req.headers['x-form-confirmed'] !== 'true') {
                    sendJson(res, 400, { error: 'Select and confirm the form type and court assignment.' }); return;
                }
                const content = await readRequestBuffer(req, 25 * 1024 * 1024);
                try {
                    const form = await saveFormPdf(db, { role: role as 'advice' | 'local', courtName: url.searchParams.get('court') || '',
                        filename: uploadedPdfFilename(req.headers['x-file-name']), content });
                    sendJson(res, 201, form);
                } catch (error) { sendJson(res, 422, { error: (error as Error).message }); }
                return;
            }
            const libraryMatch = url.pathname.match(/^\/api\/form-library\/([^/]+)(\/content)?$/);
            if (libraryMatch) {
                const form = db.listLibraryForms().find(item => item.id === libraryMatch[1]);
                if (!form) { sendJson(res, 404, { error: 'Form not found' }); return; }
                if (req.method === 'GET' && libraryMatch[2]) {
                    const content = readFormPdf(db, form);
                    res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Length':content.length,
                        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(form.filename)}`, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
                    res.end(content); return;
                }
                if (req.method === 'DELETE' && !libraryMatch[2]) { db.disableLibraryForm(form.id); sendJson(res, 200, { ok:true }); return; }
            }
            const standardFormsMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/standard-forms$/);
            if (req.method === 'POST' && standardFormsMatch) {
                sendJson(res, 200, await applyLibraryForms(db, standardFormsMatch[1])); return;
            }
            const removeFormMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/library-documents\/([^/]+)$/);
            if (req.method === 'DELETE' && removeFormMatch) {
                sendJson(res, 200, db.removeLibraryDocument(removeFormMatch[1], removeFormMatch[2])); return;
            }
            if (req.method === 'POST' && ['/api/settings/mifile', '/api/settings/mifile/test'].includes(url.pathname)) {
                const origin = req.headers.origin;
                if (!hasAdminCredentials() || req.headers['x-admin-action'] !== 'account-settings' ||
                    !String(req.headers['content-type']).startsWith('application/json') ||
                    (origin && new URL(origin).host !== req.headers.host) ||
                    req.headers['sec-fetch-site'] === 'cross-site') {
                    sendJson(res, 403, { error: 'Account settings require an authenticated same-origin admin request.' });
                    return;
                }
                const save = url.pathname === '/api/settings/mifile';
                if (save && !accountSettingsEnabled()) {
                    sendJson(res, 409, { error: 'Server encryption is not configured for account updates.' });
                    return;
                }
                if (accountTestRunning || (save && db.hasActiveFilingJobs())) {
                    sendJson(res, 409, { error: 'Wait for the current account check or MiFILE preparation to finish.' });
                    return;
                }
                let input;
                try { input = JSON.parse((await readRequestBuffer(req, 8 * 1024)).toString('utf8')); }
                catch {
                    sendJson(res, 400, { error: 'Invalid account settings request.' });
                    return;
                }
                let current = null;
                try { current = getMiFileCredentials(); } catch { /* A new verified account can repair the stored credentials. */ }
                let credentials;
                try { credentials = credentialsFromSettingsInput(input, current); }
                catch (error) {
                    sendJson(res, 400, { error: (error as Error).message });
                    return;
                }
                if (accountTestRunning) {
                    sendJson(res, 409, { error: 'An account check is already running.' });
                    return;
                }
                accountTestRunning = true;
                try {
                    await testMiFileCredentials(credentials);
                    if (save) {
                        db.saveMiFileAccountSetting(encryptMiFileAccount(credentials, process.env));
                        invalidateMifileSession();
                    }
                } finally {
                    accountTestRunning = false;
                }
                sendJson(res, 200, { verified: true, saved: save });
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
                    'filing_reconciliation',
                    'filing_prepared',
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
                    source: url.searchParams.get('source') === 'all' ? 'all' : 'intake',
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

            if (req.method === 'GET' && url.pathname === '/api/filing-jobs') {
                const caseDraftId = url.searchParams.get('caseDraftId')?.trim() || undefined;
                let account = null;
                try { account = getMiFileCredentials(); } catch { /* Saved credentials need attention. */ }
                sendJson(
                    res,
                    200,
                    db.listFilingJobs(
                        caseDraftId,
                        Number(url.searchParams.get('limit') || 100),
                    ).map(decorateFilingJob),
                );
                return;
            }

            const filingScreenshot = url.pathname.match(/^\/api\/filing-jobs\/([^/]+)\/screenshot$/);
            if (req.method === 'GET' && filingScreenshot) {
                const job = db.getFilingJob(decodeURIComponent(filingScreenshot[1]));
                try {
                    if (!job?.debugArtifactPath) throw new Error('Missing diagnostic');
                    const root = fs.realpathSync(process.env.MIFILE_FILING_DEBUG_DIR || process.env.TRUECERTIFY_DEBUG_DIR ||
                        path.join(os.tmpdir(), 'mifile-filing-debug'));
                    const filename = fs.realpathSync(job.debugArtifactPath);
                    if (path.dirname(filename) !== path.join(root, job.id) || path.extname(filename).toLowerCase() !== '.png' ||
                        fs.statSync(filename).size > 5 * 1024 * 1024) throw new Error('Invalid diagnostic');
                    const content = fs.readFileSync(filename);
                    if (!content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG');
                    res.writeHead(200, { 'Content-Type':'image/png', 'Content-Length':content.length,
                        'Content-Disposition':'inline; filename="mifile-diagnostic.png"', 'Cache-Control':'no-store',
                        'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'none'; sandbox" });
                    res.end(content);
                } catch { sendJson(res, 404, { error:'Diagnostic screenshot is unavailable.' }); }
                return;
            }
            const filingJobMatch = url.pathname.match(/^\/api\/filing-jobs\/([^/]+)$/);
            if (req.method === 'GET' && filingJobMatch) {
                const job = db.getFilingJob(decodeURIComponent(filingJobMatch[1]));
                if (!job) {
                    sendJson(res, 404, { error: 'MiFILE job not found' });
                    return;
                }
                let account = null;
                try { account = getMiFileCredentials(); } catch { /* Saved credentials need attention. */ }
                sendJson(res, 200, decorateFilingJob(job));
                return;
            }

            const checkoutMatch = url.pathname.match(/^\/api\/filing-jobs\/([^/]+)\/checkout\/([^/]+)$/);
            if (req.method === 'POST' && checkoutMatch) {
                const action = checkoutMatch[2];
                if (!['inspect','confirm','receipts','payment-method','clear-method','refresh-status'].includes(action)) {
                    sendJson(res, 403, {error:'Payment and final court submission are disabled in this release.'});
                    return;
                }
                try {
                    const body = await readRequestBody(req);
                    const input = body ? JSON.parse(body) : {};
                    const allowed = action === 'confirm' ? ['quoteId','quoteDigest','totalCents'] :
                        action === 'payment-method' ? ['quoteId','quoteDigest','paymentMethodFingerprint'] : [];
                    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
                        throw new Error('Only a read-only checkout inspection or amount review is allowed.');
                    }
                    if (accountTestRunning || !getMiFileRuntimeConfig().ready) throw new Error('Verify the MiFILE account and wait for the current account check to finish.');
                    const id = decodeURIComponent(checkoutMatch[1]), account = getCheckoutAccount();
                    if (!db.getFilingJob(id)) { sendJson(res,404,{error:'MiFILE job not found'}); return; }
                    if (action === 'refresh-status') {
                        if (automaticStatusRefreshAvailable()) {
                            db.checkout().refreshReceiptsIfDue(id,account);
                        }
                    } else if (action === 'confirm') {
                        db.checkout().confirm(id, input, account, process.env.ADMIN_USERNAME || 'admin');
                    } else {
                        if (['false','0','no','off'].includes((process.env.MIFILE_FILING_WORKER_ENABLED || 'true').toLowerCase())) {
                            throw new Error('The MiFILE worker must be enabled to run read-only inspections.');
                        }
                        if (action === 'payment-method') db.checkout().choosePaymentMethod(id,
                            {quoteId:input.quoteId,quoteDigest:input.quoteDigest,fingerprint:input.paymentMethodFingerprint},account,process.env.ADMIN_USERNAME || 'admin');
                        if (action === 'clear-method') db.checkout().clearPaymentMethod(id,account,process.env.ADMIN_USERNAME || 'admin');
                        db.checkout().queue(id, action === 'receipts' ? 'receipts' : 'quote', account);
                    }
                    sendJson(res, ['confirm','refresh-status'].includes(action) ? 200 : 202, db.checkout().state(id,account));
                } catch (error) { sendJson(res,409,{error:(error as Error).message}); }
                return;
            }

            const reconcileFilingJobMatch = url.pathname.match(
                /^\/api\/filing-jobs\/([^/]+)\/reconcile$/,
            );
            if (req.method === 'POST' && reconcileFilingJobMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                if (!['found', 'not_found'].includes(parsed.resolution)) {
                    sendJson(res, 400, {
                        error: 'Resolution must be found or not_found',
                    });
                    return;
                }
                try { sendJson(res, 200, db.resolveFilingJobReconciliation({
                    filingJobId: decodeURIComponent(reconcileFilingJobMatch[1]),
                    resolution: parsed.resolution,
                    verifiedDocumentIds: parsed.verifiedDocumentIds,
                    externalBundleId: typeof parsed.externalBundleId === 'string'
                        ? parsed.externalBundleId.trim() || null
                        : null,
                    temporaryCaseNumber: typeof parsed.temporaryCaseNumber === 'string'
                        ? parsed.temporaryCaseNumber.trim() || null
                        : null,
                })); } catch (error) { sendJson(res, 422, { error: (error as Error).message }); }
                return;
            }

            const queueFilingMatch = url.pathname.match(
                /^\/api\/drafts\/([^/]+)\/filing-jobs$/,
            );
            if (req.method === 'POST' && queueFilingMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                if (parsed.mode && parsed.mode !== 'prepare') {
                    sendJson(res, 400, {
                        error: 'Only safe MiFILE preparation is enabled. Final court submission is disabled.',
                    });
                    return;
                }
                try {
                    if (parsed.confirmPackage === true && (!getMiFileRuntimeConfig().ready ||
                        typeof parsed.expectedUpdatedAt !== 'string' || !parsed.expectedUpdatedAt)) {
                        sendJson(res, 409, { error: 'Refresh the Draft and verify the MiFILE account before confirming.' });
                        return;
                    }
                    const job = db.queueFilingJob(
                        decodeURIComponent(queueFilingMatch[1]),
                        'prepare',
                        parsed.retry === true ? 'admin_retry' : 'admin',
                        'admin',
                        parsed.confirmPackage === true,
                        typeof parsed.expectedUpdatedAt === 'string' ? parsed.expectedUpdatedAt : undefined,
                    );
                    sendJson(res, 202, job);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (!/active MiFILE job|Approve the Draft|Filing is blocked:|Cannot approve draft:|The Draft changed|Resolve or complete|not a new filing package/.test(message)) throw error;
                    sendJson(res, 409, { error: message });
                }
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
            if (req.method === 'PUT' && documentContentMatch) {
                const documentId = decodeURIComponent(documentContentMatch[1]);
                let context;
                try { context = db.getDraftDocumentEditContext(documentId); }
                catch (error) { sendJson(res, 409, { error: (error as Error).message }); return; }
                if (context.document.formTemplate) {
                    sendJson(res, 409, { error: 'Remove the library document and add the correct form instead of replacing its pinned version.' }); return;
                }
                const content = await readRequestBuffer(req, 25 * 1024 * 1024);
                const validation = validatePdfBuffer(content);
                if (!validation.valid) {
                    sendJson(res, 415, {
                        error: validation.reason || 'The replacement is not a valid PDF',
                    });
                    return;
                }
                await inspectFilingPdf(content);
                const replacement = db.beginDocumentReplacement(documentId);
                try {
                    const document = replacement.document;
                    const draftId = replacement.detail.caseDraft!.id;
                    let uploaded;
                    if (document.oneDriveUrl) {
                        const sharedItem = await resolveSharedDriveItem(document.oneDriveUrl);
                        await replaceDriveItemContent(sharedItem.driveId, sharedItem.itemId, content);
                    } else {
                        const data = JSON.parse(replacement.detail.caseDraft!.normalizedDataJson || '{}');
                        const folder = await ensureIntakeFolder(data.intake.storageKey);
                        const filename = intakeFileName(document.currentFilename || document.originalFilename ||
                            uploadedPdfFilename(req.headers['x-file-name']), documentId);
                        const file = await uploadFileBufferToFolder(folder.driveId, folder.itemId, filename, content);
                        uploaded = { oneDriveUrl: await createFileLink(file.driveId, file.itemId), currentFilename: file.fileName,
                            storagePath: `New filings/${data.intake.storageKey}/${file.fileName}` };
                    }
                    db.recordDocumentReplacement(documentId, {fileSize:content.length,mimeType:'application/pdf',token:replacement.token,...uploaded});
                    db.recordDocumentRecognition(documentId, await recognizeDocumentPdf(content, uploadedPdfFilename(req.headers['x-file-name'])));
                    await ensureDraftComplaintExtraction(db, draftId, {documentId, content});
                    db.refreshEmailAfterDocumentRetries(replacement.detail.email.id, draftId);
                    sendJson(res, 200, await applyLibraryForms(db,draftId));
                } catch (error) {
                    db.failDocumentReplacement(documentId, replacement.token, error);
                    sendJson(res, 502, {error:'PDF replacement could not be completed. Check the document error and replace the PDF again.'});
                }
                return;
            }
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
                if (!validatePdfBuffer(content).valid) {
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

            const addDraftDocumentMatch = url.pathname.match(
                /^\/api\/drafts\/([^/]+)\/documents$/,
            );
            const removeDraftDocumentMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/documents\/([^/]+)$/);
            if (req.method === 'DELETE' && removeDraftDocumentMatch) {
                try { sendJson(res, 200, db.removeDraftDocument(decodeURIComponent(removeDraftDocumentMatch[1]), decodeURIComponent(removeDraftDocumentMatch[2]))); }
                catch (error) { sendJson(res, 409, {error:(error as Error).message}); }
                return;
            }
            if (req.method === 'POST' && addDraftDocumentMatch) {
                const caseDraftId = decodeURIComponent(addDraftDocumentMatch[1]);
                const detail = db.getDraftDetail(caseDraftId);
                if (!detail?.caseDraft) {
                    sendJson(res, 404, { error: 'Case draft not found' });
                    return;
                }
                if (!detail.caseDraft.filingEligible) {
                    sendJson(res, 409, {
                        error: 'Documents cannot be added to an existing court filing',
                    });
                    return;
                }
                if (detail.caseDraft.filingStatus === 'queued' || ['filing_in_progress', 'filing_reconciliation', 'filing_prepared', 'filed_successfully'].includes(
                    detail.caseDraft.status,
                )) {
                    sendJson(res, 409, { error: 'This Draft cannot accept new documents' });
                    return;
                }
                const anchor = detail.documents.find(document => document.oneDriveUrl);
                const intake = JSON.parse(detail.caseDraft.normalizedDataJson || '{}').intake;
                if (!anchor?.oneDriveUrl && !intake?.storageKey) {
                    sendJson(res, 409, {
                        error: 'At least one OneDrive document is required to locate the case folder',
                    });
                    return;
                }
                const content = await readRequestBuffer(req, 25 * 1024 * 1024);
                const validation = validatePdfBuffer(content);
                if (!validation.valid) {
                    sendJson(res, 415, {
                        error: validation.reason || 'The uploaded file is not a valid PDF',
                    });
                    return;
                }
                await inspectFilingPdf(content);
                let currentIntake;
                try { currentIntake = db.assertEditableIntake(caseDraftId); }
                catch (error) { sendJson(res, 409, {error:(error as Error).message}); return; }
                if (currentIntake.email.processingStatus === 'processing') {
                    sendJson(res, 409, {error:'Wait for the incoming package to finish processing.'}); return;
                }
                const originalFilename = uploadedPdfFilename(req.headers['x-file-name']);
                const addedDocumentId = db.addDocument({
                    emailId:detail.email.id,caseDraftId,originalFilename,documentType:originalFilename.replace(/\.pdf$/i,''),
                    uploadSource:'admin_draft_upload',status:'failed',metadata:{addedFromDraftEditor:true},
                });
                const reservation = db.beginDocumentReplacement(addedDocumentId);
                try {
                    const anchorItem = intake?.storageKey
                        ? await ensureIntakeFolder(intake.storageKey).then(folder => ({driveId:folder.driveId,parentItemId:folder.itemId}))
                        : await resolveSharedDriveItem(anchor!.oneDriveUrl!);
                    if (!anchorItem.parentItemId) throw new Error('The OneDrive case folder could not be resolved');
                    const fileName = intakeFileName(originalFilename, addedDocumentId);
                    const uploaded = await uploadFileBufferToFolder(anchorItem.driveId,anchorItem.parentItemId,fileName,content);
                    const oneDriveUrl = await createFileLink(uploaded.driveId,uploaded.itemId);
                    db.recordDocumentReplacement(addedDocumentId,{fileSize:content.length,token:reservation.token,
                        oneDriveUrl,currentFilename:uploaded.fileName,storagePath:`New filings/${intake?.storageKey || ''}/${uploaded.fileName}`});
                } catch(error) {
                    db.failDocumentReplacement(addedDocumentId,reservation.token,error);
                    sendJson(res,502,{error:'The PDF upload failed. Its Draft record is retained; use Replace PDF to retry without adding a duplicate.'}); return;
                }
                const isIntake = JSON.parse(detail.caseDraft.normalizedDataJson || '{}').sourceKind === 'new_filing_intake';
                if (isIntake) db.recordDocumentRecognition(addedDocumentId, await recognizeDocumentPdf(content, originalFilename));
                const addedType = db.getDraftDetail(caseDraftId)?.documents.find(item => item.id === addedDocumentId)?.documentType;
                if (isComplaintDocument(addedType, null)) {
                    await ensureDraftComplaintExtraction(db, caseDraftId, {documentId: addedDocumentId, content});
                }
                sendJson(res, 201, isIntake ? await applyLibraryForms(db, caseDraftId) : db.refreshCaseDraftValidation(caseDraftId));
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

            const autoExtractMatch = url.pathname.match(/^\/api\/drafts\/([^/]+)\/auto-extract$/);
            if (req.method === 'POST' && autoExtractMatch) {
                const draftId = decodeURIComponent(autoExtractMatch[1]);
                await ensureDraftComplaintExtraction(db, draftId);
                const detail = await ensureDraftDocumentRecognitions(db, draftId);
                sendJson(res, 200, detail.caseDraft?.complaintExtraction && detail.caseDraft.filingEligible && ['not_started','failed'].includes(detail.caseDraft.filingStatus)
                    ? await applyLibraryForms(db, draftId) : detail);
                return;
            }

            const extractComplaintMatch = url.pathname.match(
                /^\/api\/drafts\/([^/]+)\/extract-complaint$/,
            );
            if (req.method === 'POST' && extractComplaintMatch) {
                const caseDraftId = decodeURIComponent(extractComplaintMatch[1]);
                const detail = db.getDraftDetail(caseDraftId);
                const primaryDocumentId = detail?.caseDraft?.primaryDocumentId;
                const primary = primaryDocumentId
                    ? detail?.documents.find(document => document.id === primaryDocumentId)
                    : null;
                if (!detail?.caseDraft || !primary) {
                    sendJson(res, 400, { error: 'Select a primary Complaint first' });
                    return;
                }
                if (!isComplaintDocument(
                    primary.documentType,
                    primary.currentFilename || primary.originalFilename,
                )) {
                    sendJson(res, 400, { error: 'The primary document is not a Complaint' });
                    return;
                }
                if (!primary.oneDriveUrl) {
                    sendJson(res, 409, { error: 'The primary Complaint is not available in OneDrive' });
                    return;
                }

                try { db.getDraftDocumentEditContext(primary.id); }
                catch (error) { sendJson(res, 409, {error:(error as Error).message}); return; }
                const latest = await ensureDraftComplaintExtraction(db, caseDraftId, {force:true});
                if (JSON.parse(latest.caseDraft?.normalizedDataJson || '{}').complaintExtractionError) {
                    sendJson(res, 422, { error: 'Complaint extraction failed. Check the Draft validation details.' });
                    return;
                }
                const updated = JSON.parse(detail.caseDraft.normalizedDataJson || '{}').sourceKind === 'new_filing_intake'
                    ? await applyLibraryForms(db, caseDraftId) : db.refreshCaseDraftValidation(caseDraftId);
                sendJson(res, 200, updated);
                return;
            }

            if (req.method === 'PATCH' && draftMatch) {
                const body = await readRequestBody(req);
                const parsed = body ? JSON.parse(body) : {};
                // The browser may still show an older automatic result while the user is typing.
                // Apply only their actual edits to the latest server values.
                if (parsed.base && typeof parsed.base === 'object' && !Array.isArray(parsed.base)) {
                    const latest = db.getDraftDetail(decodeURIComponent(draftMatch[1]));
                    if (!latest?.caseDraft) { sendJson(res,404,{error:'Draft not found'}); return; }
                    const base = parsed.base;
                    if (parsed.fields && base.fields) parsed.fields = Object.fromEntries(Object.entries(parsed.fields)
                        .filter(([key,value])=>String(value ?? '') !== String(base.fields[key] ?? '') ||
                            (parsed.supportingRequirementReviewed === true &&
                                ['supportingRequirement','supportingRequirementReason'].includes(key))));
                    if (parsed.filingData && base.filingData) {
                        const edits = new Set(changedFieldPaths('filingData',base.filingData,parsed.filingData));
                        parsed.filingData = mergeExtractedField('filingData',parsed.filingData,latest.caseDraft.filingData,edits);
                    }
                    if (Array.isArray(parsed.documents) && Array.isArray(base.documents)) {
                        parsed.documents = parsed.documents.flatMap((mapping: any) => {
                            const original = base.documents.find((doc:any)=>doc.id===mapping.id);
                            const current = latest.documents.find(doc=>doc.id===mapping.id);
                            if (!original || !current) return [mapping];
                            const keys = ['filingName','filingType','filingRelation','requiredForFiling','supportingKind'] as const;
                            const changed = keys.filter(key=>mapping[key] !== original[key] ||
                                (key === 'supportingKind' && mapping.supportingKindReviewed === true));
                            if (!changed.length && !mapping.filingTypeReviewed && !mapping.filingRelationReviewed && !mapping.supportingKindReviewed) return [];
                            return [{...mapping,...Object.fromEntries(keys.filter(key=>!changed.includes(key)).map(key=>
                                [key,key === 'supportingKind' ? current.supportingEvidence?.kind || 'unknown' : current[key]]))}];
                        });
                    }
                    if (parsed.primaryDocumentId === base.primaryDocumentId) delete parsed.primaryDocumentId;
                    if (parsed.reviewerNotes === base.reviewerNotes) delete parsed.reviewerNotes;
                }
                const supportingRequirementReview = parsed.supportingRequirementReviewed === true ||
                    ['supportingRequirement','supportingRequirementReason'].some(key =>
                        Object.prototype.hasOwnProperty.call(parsed.fields ?? {}, key));
                const expectedSupportingContextHash = supportingRequirementReview ? parsed.expectedSupportingContextHash : undefined;
                if (supportingRequirementReview && (typeof expectedSupportingContextHash !== 'string' ||
                    !/^[a-f0-9]{64}$/.test(expectedSupportingContextHash))) {
                    sendJson(res, 409, {error:'The supporting review is missing its original package context. Refresh the Draft and review its PDFs again.'});
                    return;
                }
                if (Array.isArray(parsed.documents) && parsed.documents.some((mapping: any) => mapping.supportingKindReviewed === true &&
                    (typeof mapping.expectedSourceVersion !== 'string' || !mapping.expectedSourceVersion.trim() ||
                        typeof mapping.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(mapping.expectedContentHash)))) {
                    sendJson(res, 409, {error:'The PDF review is missing its original source version or content hash. Refresh the Draft and review the current PDF again.'});
                    return;
                }
                let detail: EmailDetail;
                try {
                    detail = db.updateCaseDraft(
                        decodeURIComponent(draftMatch[1]),
                        parsed.fields ?? {},
                        typeof parsed.reviewerNotes === 'string'
                            ? parsed.reviewerNotes
                            : undefined,
                        parsed.filingData,
                        Array.isArray(parsed.documents) ? parsed.documents : [],
                        Object.prototype.hasOwnProperty.call(parsed, 'primaryDocumentId')
                            ? parsed.primaryDocumentId
                            : undefined,
                        expectedSupportingContextHash,
                    );
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (/changed since .*reviewed/i.test(message)) {
                        sendJson(res, 409, {error:message});
                        return;
                    }
                    throw error;
                }
                if (Object.prototype.hasOwnProperty.call(parsed, 'primaryDocumentId') &&
                    detail.caseDraft?.primaryDocumentId && detail.caseDraft.primaryDocumentId !== detail.caseDraft.complaintExtraction?.documentId) {
                    await ensureDraftComplaintExtraction(db, decodeURIComponent(draftMatch[1]));
                }
                sendJson(res, 200, JSON.parse(detail.caseDraft?.normalizedDataJson || '{}').sourceKind === 'new_filing_intake'
                    ? await applyLibraryForms(db, decodeURIComponent(draftMatch[1])) : detail);
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
