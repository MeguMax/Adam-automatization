import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ParsedEmailInfo } from './emailProcessor';

export type EmailProcessingStatus =
    | 'new'
    | 'processing'
    | 'ignored'
    | 'processed'
    | 'failed'
    | 'partial_failure'
    | 'legacy_processed';

export type CaseDraftStatus =
    | 'new'
    | 'parsed'
    | 'validation_failed'
    | 'needs_review'
    | 'ready_to_file'
    | 'filing_in_progress'
    | 'filed_successfully'
    | 'filing_failed'
    | 'rejected'
    | 'archived';

export type ValidationStatus = 'unknown' | 'passed' | 'warnings' | 'failed';
export type FilingStatus = 'not_started' | 'queued' | 'running' | 'succeeded' | 'failed';
export type DocumentStatus =
    | 'pending'
    | 'retry_queued'
    | 'retrying'
    | 'downloaded'
    | 'uploaded'
    | 'failed'
    | 'not_downloadable'
    | 'invalid'
    | 'replaced'
    | 'archived';
export type ReviewAction = 'save_note' | 'move_to_review' | 'approve' | 'reject';

export interface EmailRecord {
    id: string;
    externalMessageId: string;
    processingStatus: EmailProcessingStatus;
}

export interface StoredDocumentInput {
    emailId: string;
    caseDraftId?: string | null;
    originalFilename?: string | null;
    currentFilename?: string | null;
    fileUrl?: string | null;
    sourceUrl?: string | null;
    oneDriveUrl?: string | null;
    storagePath?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
    documentType?: string | null;
    uploadSource: string;
    status: DocumentStatus;
    errorMessage?: string | null;
    metadata?: unknown;
    downloadAttempts?: number;
    automaticRetryCount?: number;
    lastRetryAt?: string | null;
    nextRetryAt?: string | null;
}

export interface ProcessingReportDocument {
    fileName: string;
    oneDriveUrl: string;
}

export interface ProcessingReportInput {
    originalSubject: string | null;
    originalSender: string | null;
    originalReceivedAt: string | null;
    caseNumber: string | null;
    caseTitle: string | null;
    documents: ProcessingReportDocument[];
    reportMessageId: string;
}

export interface ProcessingReportApplyResult {
    applied: boolean;
    targetEmailId: string | null;
    caseDraftId: string | null;
    plaintiffMappingId: string | null;
}

export interface DashboardSummary {
    emailStatuses: Record<string, number>;
    draftStatuses: Record<string, number>;
    documentStatuses: Record<string, number>;
    filingStatuses: Record<string, number>;
    documentsToday: number;
    emailsToday: number;
    missingPlaintiffMappings: number;
    databaseBytes: number;
}

export interface PlaintiffMappingView {
    id: string;
    fullName: string;
    shortName: string;
    isActive: boolean;
    status: 'needs_short_name' | 'active' | 'inactive';
    usageCount: number;
    lastUsedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface MissingPlaintiffMappingView {
    fullName: string;
    usageCount: number;
    lastUsedAt: string | null;
}

export interface PlaintiffMappingStatusView {
    fullName: string | null;
    mappingId: string | null;
    shortName: string | null;
    isActive: boolean;
    status: 'mapped' | 'needs_short_name' | 'inactive' | 'missing' | 'unknown';
}

export interface PlaintiffNamingLookup {
    fullName: string | null;
    shortName: string | null;
    mappingStatus: PlaintiffMappingStatusView['status'];
}

export interface PlaintiffMappingSeed {
    version: 1;
    exportedAt: string;
    mappings: Array<{
        fullName: string;
        shortName: string;
        isActive: boolean;
    }>;
}

export interface PlaintiffFilenameRenameTarget {
    documentId: string;
    currentFilename: string;
    nextFilename: string;
    oneDriveUrl: string;
    storagePath: string | null;
}

export interface PlaintiffFilenameRenamePlan {
    mappingId: string;
    fullName: string;
    shortName: string;
    targets: PlaintiffFilenameRenameTarget[];
}

export interface PlaintiffFilenameMappingState {
    fullName: string | null;
    shortName: string | null;
    eligibleDocumentCount: number;
    appliedDocumentCount: number;
    needsApplicationCount: number;
}

export interface QueueItem {
    emailId: string;
    caseDraftId: string | null;
    sender: string | null;
    subject: string | null;
    receivedAt: string | null;
    processingStatus: string;
    processingError: string | null;
    documentCount: number;
    expectedDocumentCount: number;
    uploadedDocumentCount: number;
    oneDriveDocumentCount: number;
    pendingDocumentCount: number;
    retryQueuedDocumentCount: number;
    retryingDocumentCount: number;
    failedDocumentCount: number;
    notDownloadableDocumentCount: number;
    plaintiffName: string | null;
    plaintiffShortName: string | null;
    plaintiffMappingStatus: string;
    caseNumber: string | null;
    draftStatus: string | null;
    validationStatus: string | null;
    filingStatus: string | null;
    workflowMode: string | null;
    updatedAt: string;
}

export type QueueScope = 'active' | 'all';

export interface QueueListOptions {
    page?: number;
    pageSize?: number;
    scope?: QueueScope;
    status?: EmailProcessingStatus | '';
    search?: string;
    dateFrom?: string | null;
    dateTo?: string | null;
}

export interface QueuePage {
    items: QueueItem[];
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
}

export interface EmailDeleteResult {
    emailRecords: number;
    caseDrafts: number;
    documentRecords: number;
    filingJobs: number;
    auditLogs: number;
    oneDriveFilesDeleted: 0;
}

export interface EmailPurgeResult extends EmailDeleteResult {
    cutoff: string;
    tombstones: number;
}

export interface DocumentRecordView {
    id: string;
    originalFilename: string | null;
    currentFilename: string | null;
    fileUrl: string | null;
    sourceUrl: string | null;
    oneDriveUrl: string | null;
    storagePath: string | null;
    mimeType: string | null;
    fileSize: number | null;
    documentType: string | null;
    uploadSource: string;
    status: string;
    errorMessage: string | null;
    downloadAttempts: number;
    automaticRetryCount: number;
    lastRetryAt: string | null;
    nextRetryAt: string | null;
    failureLog: Array<{
        attempt: number;
        at: string;
        stage: string;
        message: string;
    }>;
    createdAt: string;
    updatedAt: string;
}

export interface AuditLogView {
    id: string;
    entityType: string;
    entityId: string;
    action: string;
    actorType: string;
    actorId: string | null;
    metadataJson: string | null;
    createdAt: string;
}

export interface EmailDetail {
    email: {
        id: string;
        externalMessageId: string;
        sender: string | null;
        subject: string | null;
        receivedAt: string | null;
        bodySummary: string | null;
        processingStatus: string;
        processingError: string | null;
        processingAttempts: number;
        lastAttemptAt: string | null;
        processedAt: string | null;
        createdAt: string;
        updatedAt: string;
    };
    caseDraft: {
        id: string;
        workflowMode: string;
        status: string;
        validationStatus: string;
        filingStatus: string;
        extractedDataJson: string | null;
        normalizedDataJson: string | null;
        reviewerNotes: string | null;
        reviewedAt: string | null;
        createdAt: string;
        updatedAt: string;
    } | null;
    plaintiffMapping: PlaintiffMappingStatusView;
    plaintiffFilenameMapping: PlaintiffFilenameMappingState;
    retryPolicy: {
        maxAutomaticRetries: number;
    };
    documents: DocumentRecordView[];
    auditLogs: AuditLogView[];
}

export interface DueDocumentRetry {
    documentId: string;
    emailId: string;
    externalMessageId: string;
    caseDraftId: string | null;
    sourceUrl: string;
    documentType: string | null;
    documentName: string | null;
    retrySource: 'automatic' | 'manual';
}

interface Migration {
    version: number;
    name: string;
    up: (db: DatabaseSync) => void;
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
export const DEFAULT_WORKFLOW_DB_PATH = path.join(PROJECT_ROOT, 'data', 'workflow.sqlite');
const TERMINAL_EMAIL_STATUSES = new Set<EmailProcessingStatus>([
    'ignored',
    'processed',
    'failed',
    'partial_failure',
    'legacy_processed',
]);

const MAX_AUTOMATIC_DOCUMENT_RETRIES = boundedPositiveInt(
    process.env.DOCUMENT_AUTO_RETRY_LIMIT,
    6,
    1,
    30,
);
const DOCUMENT_RETRY_INITIAL_DELAY_MS = boundedPositiveInt(
    process.env.DOCUMENT_RETRY_INITIAL_DELAY_MS,
    15 * 60 * 1000,
    60 * 1000,
    24 * 60 * 60 * 1000,
);
const DOCUMENT_RETRY_MAX_DELAY_MS = boundedPositiveInt(
    process.env.DOCUMENT_RETRY_MAX_DELAY_MS,
    12 * 60 * 60 * 1000,
    DOCUMENT_RETRY_INITIAL_DELAY_MS,
    7 * 24 * 60 * 60 * 1000,
);

let sharedDatabase: WorkflowDatabase | null = null;

function nowIso(): string {
    return new Date().toISOString();
}

function boundedPositiveInt(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

function toJson(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    return JSON.stringify(value);
}

function normalizeError(error: unknown): string | null {
    if (!error) return null;
    if (error instanceof Error) return error.stack || error.message;
    return String(error);
}

function failureLogFromMetadata(value: unknown): DocumentRecordView['failureLog'] {
    if (!value || typeof value !== 'object') return [];
    const attemptLog = (value as { attemptLog?: unknown }).attemptLog;
    if (!Array.isArray(attemptLog)) return [];

    return attemptLog
        .filter(item => item && typeof item === 'object')
        .map((item: any) => ({
            attempt: Number(item.attempt ?? 0),
            at: String(item.at ?? ''),
            stage: String(item.stage ?? 'download'),
            message: String(item.message ?? 'Unknown failure'),
        }))
        .filter(item => item.message);
}

function bodySummary(bodyHtml: string): string {
    return bodyHtml
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1000);
}

function normalizeName(value: string | null | undefined): string | null {
    if (!value) return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized || null;
}

function nextDocumentRetryAt(automaticRetryCount: number): string | null {
    if (automaticRetryCount >= MAX_AUTOMATIC_DOCUMENT_RETRIES) return null;
    const delay = Math.min(
        DOCUMENT_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(automaticRetryCount, 12),
        DOCUMENT_RETRY_MAX_DELAY_MS,
    );
    return new Date(Date.now() + delay).toISOString();
}

function plaintiffFromCaseTitle(caseTitle: string | null | undefined): string | null {
    const normalized = normalizeName(caseTitle);
    if (!normalized) return null;

    const match = normalized.match(/^(.+?)\s+v(?:\.|s\.?)?\s+.+$/i);
    return normalizeName(match?.[1]);
}

function extractPlaintiffName(data: any): string | null {
    return normalizeName(data?.plaintiff) || plaintiffFromCaseTitle(data?.caseTitle);
}

function filenameToken(value: string): string {
    return value.replace(/[^\w\-]+/g, '_');
}

function renamePlaintiffInFilename(
    currentFilename: string,
    fullName: string,
    shortName: string,
): string | null {
    const fullToken = filenameToken(fullName);
    const shortToken = filenameToken(shortName);
    if (!fullToken || !shortToken || !currentFilename.includes(fullToken)) return null;
    return currentFilename.replace(fullToken, shortToken);
}

const migrations: Migration[] = [
    {
        version: 1,
        name: 'initial_workflow_schema',
        up: db => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    email TEXT UNIQUE NOT NULL,
                    role TEXT NOT NULL DEFAULT 'admin',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS email_records (
                    id TEXT PRIMARY KEY,
                    external_message_id TEXT UNIQUE NOT NULL,
                    sender TEXT,
                    subject TEXT,
                    received_at TEXT,
                    body_summary TEXT,
                    raw_metadata_json TEXT,
                    processing_status TEXT NOT NULL DEFAULT 'new',
                    processing_error TEXT,
                    processing_attempts INTEGER NOT NULL DEFAULT 0,
                    last_attempt_at TEXT,
                    processed_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS case_drafts (
                    id TEXT PRIMARY KEY,
                    email_id TEXT NOT NULL,
                    primary_document_id TEXT,
                    workflow_mode TEXT NOT NULL DEFAULT 'review_before_submission',
                    status TEXT NOT NULL DEFAULT 'new',
                    validation_status TEXT NOT NULL DEFAULT 'unknown',
                    filing_status TEXT NOT NULL DEFAULT 'not_started',
                    extracted_data_json TEXT,
                    normalized_data_json TEXT,
                    reviewer_notes TEXT,
                    reviewed_by TEXT,
                    reviewed_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(email_id) REFERENCES email_records(id),
                    FOREIGN KEY(primary_document_id) REFERENCES document_records(id)
                );

                CREATE TABLE IF NOT EXISTS document_records (
                    id TEXT PRIMARY KEY,
                    email_id TEXT NOT NULL,
                    case_draft_id TEXT,
                    original_filename TEXT,
                    current_filename TEXT,
                    file_url TEXT,
                    source_url TEXT,
                    one_drive_url TEXT,
                    storage_path TEXT,
                    mime_type TEXT,
                    file_size INTEGER,
                    document_type TEXT,
                    upload_source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    error_message TEXT,
                    metadata_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(email_id) REFERENCES email_records(id),
                    FOREIGN KEY(case_draft_id) REFERENCES case_drafts(id)
                );

                CREATE TABLE IF NOT EXISTS plaintiff_mappings (
                    id TEXT PRIMARY KEY,
                    full_name TEXT NOT NULL,
                    short_name TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    usage_count INTEGER NOT NULL DEFAULT 0,
                    last_used_at TEXT,
                    created_by TEXT,
                    updated_by TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(full_name)
                );

                CREATE TABLE IF NOT EXISTS filing_jobs (
                    id TEXT PRIMARY KEY,
                    case_draft_id TEXT NOT NULL,
                    attempt_number INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    trigger_source TEXT,
                    started_at TEXT,
                    finished_at TEXT,
                    duration_ms INTEGER,
                    error_message TEXT,
                    execution_log TEXT,
                    triggered_by TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(case_draft_id) REFERENCES case_drafts(id)
                );

                CREATE TABLE IF NOT EXISTS audit_logs (
                    id TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    actor_type TEXT NOT NULL DEFAULT 'system',
                    actor_id TEXT,
                    old_value_json TEXT,
                    new_value_json TEXT,
                    metadata_json TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_email_records_status
                    ON email_records(processing_status);
                CREATE INDEX IF NOT EXISTS idx_email_records_received_at
                    ON email_records(received_at);
                CREATE INDEX IF NOT EXISTS idx_documents_email_id
                    ON document_records(email_id);
                CREATE INDEX IF NOT EXISTS idx_documents_case_draft_id
                    ON document_records(case_draft_id);
                CREATE INDEX IF NOT EXISTS idx_case_drafts_status
                    ON case_drafts(status);
                CREATE INDEX IF NOT EXISTS idx_case_drafts_email_id
                    ON case_drafts(email_id);
                CREATE INDEX IF NOT EXISTS idx_filing_jobs_case_draft_id
                    ON filing_jobs(case_draft_id);
                CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
                    ON audit_logs(entity_type, entity_id);
            `);
        },
    },
    {
        version: 2,
        name: 'split_document_source_and_onedrive_urls',
        up: db => {
            const columns = db
                .prepare('PRAGMA table_info(document_records)')
                .all() as { name: string }[];
            const names = new Set(columns.map(column => column.name));

            if (!names.has('source_url')) {
                db.exec('ALTER TABLE document_records ADD COLUMN source_url TEXT');
            }
            if (!names.has('one_drive_url')) {
                db.exec('ALTER TABLE document_records ADD COLUMN one_drive_url TEXT');
            }

            db.exec(`
                UPDATE document_records
                SET source_url = file_url
                WHERE source_url IS NULL
                  AND upload_source = 'parsed_email'
                  AND file_url IS NOT NULL;

                UPDATE document_records
                SET source_url = file_url
                WHERE source_url IS NULL
                  AND status = 'failed'
                  AND file_url IS NOT NULL;

                UPDATE document_records
                SET one_drive_url = file_url
                WHERE one_drive_url IS NULL
                  AND status IN ('uploaded', 'downloaded')
                  AND file_url IS NOT NULL;
            `);
        },
    },
    {
        version: 3,
        name: 'clear_ambiguous_pending_file_urls',
        up: db => {
            db.exec(`
                UPDATE document_records
                SET file_url = NULL
                WHERE status IN ('pending', 'failed')
                  AND source_url IS NOT NULL;
            `);
        },
    },
    {
        version: 4,
        name: 'normalize_uploaded_documents_by_onedrive_url',
        up: db => {
            db.exec(`
                UPDATE document_records
                SET status = 'uploaded'
                WHERE one_drive_url IS NOT NULL
                  AND status != 'uploaded';
            `);
        },
    },
    {
        version: 5,
        name: 'classify_non_downloadable_documents',
        up: db => {
            const timestamp = nowIso();
            db.exec(`
                UPDATE document_records
                SET status = 'not_downloadable',
                    error_message = COALESCE(error_message, 'No downloadable file in source email'),
                    updated_at = '${timestamp}'
                WHERE one_drive_url IS NULL
                  AND (source_url IS NULL OR source_url = '')
                  AND status IN ('pending', 'failed');

                UPDATE document_records
                SET error_message = 'No downloadable file in source email',
                    updated_at = '${timestamp}'
                WHERE status = 'not_downloadable'
                  AND (error_message IS NULL OR error_message = 'Expected document has no downloadable source URL');

                UPDATE email_records
                SET processing_status = 'processed',
                    processing_error = NULL,
                    processed_at = COALESCE(processed_at, '${timestamp}'),
                    updated_at = '${timestamp}'
                WHERE processing_status = 'partial_failure'
                  AND id IN (
                    SELECT e.id
                    FROM email_records e
                    JOIN case_drafts c ON c.email_id = e.id
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM document_records d
                        WHERE d.case_draft_id = c.id
                          AND d.status = 'failed'
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM document_records d
                        WHERE d.case_draft_id = c.id
                          AND d.status = 'pending'
                          AND d.source_url IS NOT NULL
                    )
                    AND EXISTS (
                        SELECT 1
                        FROM document_records d
                        WHERE d.case_draft_id = c.id
                          AND (d.status = 'uploaded' OR d.one_drive_url IS NOT NULL)
                    )
                  );

                UPDATE case_drafts
                SET status = 'ready_to_file',
                    validation_status = 'passed',
                    updated_at = '${timestamp}'
                WHERE status = 'needs_review'
                  AND id IN (
                    SELECT c.id
                    FROM case_drafts c
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM document_records d
                        WHERE d.case_draft_id = c.id
                          AND d.status = 'failed'
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM document_records d
                        WHERE d.case_draft_id = c.id
                          AND d.status = 'pending'
                          AND d.source_url IS NOT NULL
                    )
                    AND EXISTS (
                        SELECT 1
                        FROM document_records d
                        WHERE d.case_draft_id = c.id
                          AND (d.status = 'uploaded' OR d.one_drive_url IS NOT NULL)
                    )
                  );
            `);
        },
    },
    {
        version: 6,
        name: 'backfill_plaintiff_mapping_candidates',
        up: db => {
            const rows = db
                .prepare(`
                    SELECT normalized_data_json
                    FROM case_drafts
                    WHERE normalized_data_json IS NOT NULL
                `)
                .all() as { normalized_data_json: string | null }[];

            const insert = db.prepare(`
                INSERT OR IGNORE INTO plaintiff_mappings (
                    id,
                    full_name,
                    short_name,
                    is_active,
                    usage_count,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, '', 0, 0, ?, ?)
            `);

            const timestamp = nowIso();
            for (const row of rows) {
                try {
                    const fullName = extractPlaintiffName(
                        row.normalized_data_json
                            ? JSON.parse(row.normalized_data_json)
                            : null,
                    );
                    if (!fullName) continue;
                    insert.run(randomUUID(), fullName, timestamp, timestamp);
                } catch {
                    // Ignore malformed draft JSON during candidate backfill.
                }
            }
        },
    },
    {
        version: 7,
        name: 'add_document_retry_tracking',
        up: db => {
            const columns = db
                .prepare('PRAGMA table_info(document_records)')
                .all() as Array<{ name: string }>;
            const names = new Set(columns.map(column => column.name));

            if (!names.has('download_attempts')) {
                db.exec('ALTER TABLE document_records ADD COLUMN download_attempts INTEGER NOT NULL DEFAULT 0');
            }
            if (!names.has('automatic_retry_count')) {
                db.exec('ALTER TABLE document_records ADD COLUMN automatic_retry_count INTEGER NOT NULL DEFAULT 0');
            }
            if (!names.has('last_retry_at')) {
                db.exec('ALTER TABLE document_records ADD COLUMN last_retry_at TEXT');
            }
            if (!names.has('next_retry_at')) {
                db.exec('ALTER TABLE document_records ADD COLUMN next_retry_at TEXT');
            }

            const retryAt = new Date(Date.now() + DOCUMENT_RETRY_INITIAL_DELAY_MS).toISOString();
            db.prepare(`
                UPDATE document_records
                SET next_retry_at = ?
                WHERE status = 'failed'
                  AND source_url IS NOT NULL
                  AND source_url != ''
                  AND next_retry_at IS NULL
            `).run(retryAt);

            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_documents_due_retry
                    ON document_records(status, next_retry_at);
            `);
        },
    },
    {
        version: 8,
        name: 'add_deleted_email_tombstones_and_queue_indexes',
        up: db => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS deleted_email_tombstones (
                    external_message_id TEXT PRIMARY KEY,
                    deleted_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_email_records_status_received
                    ON email_records(processing_status, received_at DESC);
            `);
        },
    },
    {
        version: 9,
        name: 'add_history_and_retention_indexes',
        up: db => {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_email_records_received_at
                    ON email_records(received_at DESC);

                CREATE INDEX IF NOT EXISTS idx_deleted_email_tombstones_deleted_at
                    ON deleted_email_tombstones(deleted_at);
            `);
        },
    },
];

export class WorkflowDatabase {
    private db: DatabaseSync;
    private readonly databasePath: string;

    constructor(dbPath = process.env.WORKFLOW_DB_PATH || DEFAULT_WORKFLOW_DB_PATH) {
        this.databasePath = path.resolve(dbPath);
        fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
        this.db = new DatabaseSync(this.databasePath);
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA journal_mode = WAL');
        this.applyMigrations();
    }

    getPath(): string {
        return this.databasePath;
    }

    close(): void {
        this.db.close();
    }

    migrateLegacyProcessedIds(messageIds: string[]): number {
        let imported = 0;

        const insert = this.db.prepare(`
            INSERT OR IGNORE INTO email_records (
                id,
                external_message_id,
                processing_status,
                processed_at,
                created_at,
                updated_at
            )
            VALUES (?, ?, 'legacy_processed', ?, ?, ?)
        `);

        this.runInTransaction(() => {
            for (const externalMessageId of messageIds) {
                const id = randomUUID();
                const timestamp = nowIso();
                const result = insert.run(id, externalMessageId, timestamp, timestamp, timestamp);
                if (result.changes > 0) {
                    imported += 1;
                    this.insertAuditLog(
                        'email_record',
                        id,
                        'legacy_processed_imported',
                        { externalMessageId },
                    );
                }
            }
        });
        return imported;
    }

    shouldSkipEmail(externalMessageId: string): boolean {
        if (this.isEmailDeleted(externalMessageId)) return true;

        const row = this.db
            .prepare('SELECT processing_status FROM email_records WHERE external_message_id = ?')
            .get(externalMessageId) as { processing_status: EmailProcessingStatus } | undefined;

        return row ? TERMINAL_EMAIL_STATUSES.has(row.processing_status) : false;
    }

    isEmailDeleted(externalMessageId: string): boolean {
        return !!this.db
            .prepare('SELECT 1 FROM deleted_email_tombstones WHERE external_message_id = ?')
            .get(externalMessageId);
    }

    registerEmail(msg: any): EmailRecord {
        const existing = this.db
            .prepare(`
                SELECT id, external_message_id, processing_status
                FROM email_records
                WHERE external_message_id = ?
            `)
            .get(msg.id) as
            | { id: string; external_message_id: string; processing_status: EmailProcessingStatus }
            | undefined;

        const timestamp = nowIso();
        const bodyHtml = (msg as any).body?.content ?? '';
        const rawMetadataJson = toJson({
            from: msg.from,
            receivedDateTime: msg.receivedDateTime,
            subject: msg.subject,
        });

        if (existing) {
            this.db
                .prepare(`
                    UPDATE email_records
                    SET sender = COALESCE(?, sender),
                        subject = COALESCE(?, subject),
                        received_at = COALESCE(?, received_at),
                        body_summary = COALESCE(?, body_summary),
                        raw_metadata_json = COALESCE(?, raw_metadata_json),
                        updated_at = ?
                    WHERE id = ?
                `)
                .run(
                    msg.from?.emailAddress?.address ?? null,
                    msg.subject ?? null,
                    msg.receivedDateTime ?? null,
                    bodyHtml ? bodySummary(bodyHtml) : null,
                    rawMetadataJson,
                    timestamp,
                    existing.id,
                );

            return {
                id: existing.id,
                externalMessageId: existing.external_message_id,
                processingStatus: existing.processing_status,
            };
        }

        const id = randomUUID();

        this.db
            .prepare(`
                INSERT INTO email_records (
                    id,
                    external_message_id,
                    sender,
                    subject,
                    received_at,
                    body_summary,
                    raw_metadata_json,
                    processing_status,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
            `)
            .run(
                id,
                msg.id,
                msg.from?.emailAddress?.address ?? null,
                msg.subject ?? null,
                msg.receivedDateTime ?? null,
                bodySummary(bodyHtml),
                rawMetadataJson,
                timestamp,
                timestamp,
            );

        this.insertAuditLog('email_record', id, 'email_received', {
            externalMessageId: msg.id,
            subject: msg.subject ?? null,
        });

        return { id, externalMessageId: msg.id, processingStatus: 'new' };
    }

    markEmailProcessing(emailId: string): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE email_records
                SET processing_status = 'processing',
                    processing_attempts = processing_attempts + 1,
                    last_attempt_at = ?,
                    processing_error = NULL,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(timestamp, timestamp, emailId);
        this.insertAuditLog('email_record', emailId, 'processing_started');
    }

    markEmailIgnored(emailId: string, reason: string): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE email_records
                SET processing_status = 'ignored',
                    processing_error = ?,
                    processed_at = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(reason, timestamp, timestamp, emailId);
        this.insertAuditLog('email_record', emailId, 'email_ignored', { reason });
    }

    markEmailProcessed(emailId: string): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE email_records
                SET processing_status = 'processed',
                    processing_error = NULL,
                    processed_at = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(timestamp, timestamp, emailId);
        this.insertAuditLog('email_record', emailId, 'email_processed');
    }

    markEmailFailed(
        emailId: string,
        error: unknown,
        status: Extract<EmailProcessingStatus, 'failed' | 'partial_failure'> = 'failed',
    ): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE email_records
                SET processing_status = ?,
                    processing_error = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(status, normalizeError(error), timestamp, emailId);
        this.insertAuditLog('email_record', emailId, 'email_processing_failed', {
            status,
            error: normalizeError(error),
        });
    }

    queueEmailRetry(emailId: string, reason?: string): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE email_records
                SET processing_status = 'new',
                    processing_error = NULL,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(timestamp, emailId);
        this.insertAuditLog('email_record', emailId, 'email_retry_queued', { reason });
    }

    getDocumentRetryPolicy(): { maxAutomaticRetries: number } {
        return { maxAutomaticRetries: MAX_AUTOMATIC_DOCUMENT_RETRIES };
    }

    queueDocumentRetry(documentId: string, reason = 'Queued from admin UI'): void {
        const existing = this.db
            .prepare('SELECT id, source_url, status FROM document_records WHERE id = ?')
            .get(documentId) as { id: string; source_url: string | null; status: string } | undefined;

        if (!existing) throw new Error('Document record not found');
        if (!existing.source_url) throw new Error('This document has no source URL to retry');
        if (!['failed', 'retry_queued'].includes(existing.status)) {
            throw new Error('Only failed documents can be queued for retry');
        }

        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE document_records
                SET status = 'retry_queued',
                    next_retry_at = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(timestamp, timestamp, documentId);
        this.insertAuditLog('document_record', documentId, 'document_manual_retry_queued', { reason });
    }

    recoverStaleDocumentRetries(): number {
        const staleAfterMs = boundedPositiveInt(
            process.env.DOCUMENT_RETRY_STALE_AFTER_MS,
            60 * 60 * 1000,
            5 * 60 * 1000,
            24 * 60 * 60 * 1000,
        );
        const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();
        const timestamp = nowIso();
        const result = this.db
            .prepare(`
                UPDATE document_records
                SET status = 'failed',
                    error_message = 'Retry worker stopped before the document finished; retry rescheduled',
                    next_retry_at = ?,
                    updated_at = ?
                WHERE status = 'retrying'
                  AND last_retry_at IS NOT NULL
                  AND last_retry_at <= ?
            `)
            .run(timestamp, timestamp, staleBefore);
        return Number(result.changes ?? 0);
    }

    claimDueDocumentRetries(limit = 10): DueDocumentRetry[] {
        const normalizedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
        const timestamp = nowIso();
        const candidates = this.db
            .prepare(`
                SELECT
                    d.id AS document_id,
                    d.email_id,
                    e.external_message_id,
                    d.case_draft_id,
                    d.source_url,
                    d.document_type,
                    d.original_filename,
                    d.status
                FROM document_records d
                JOIN email_records e ON e.id = d.email_id
                WHERE d.source_url IS NOT NULL
                  AND d.source_url != ''
                  AND (
                    d.status = 'retry_queued'
                    OR (
                        d.status = 'failed'
                        AND d.next_retry_at IS NOT NULL
                        AND d.next_retry_at <= ?
                        AND d.automatic_retry_count < ?
                    )
                  )
                ORDER BY
                    CASE WHEN d.status = 'retry_queued' THEN 0 ELSE 1 END,
                    d.next_retry_at ASC,
                    d.updated_at ASC
                LIMIT ?
            `)
            .all(timestamp, MAX_AUTOMATIC_DOCUMENT_RETRIES, normalizedLimit) as any[];

        const claimed: DueDocumentRetry[] = [];
        this.runInTransaction(() => {
            for (const candidate of candidates) {
                const retrySource: DueDocumentRetry['retrySource'] =
                    candidate.status === 'retry_queued' ? 'manual' : 'automatic';
                this.db
                    .prepare(`
                        UPDATE document_records
                        SET status = 'retrying',
                            automatic_retry_count = automatic_retry_count + ?,
                            last_retry_at = ?,
                            next_retry_at = NULL,
                            updated_at = ?
                        WHERE id = ?
                    `)
                    .run(retrySource === 'automatic' ? 1 : 0, timestamp, timestamp, candidate.document_id);
                this.insertAuditLog('document_record', candidate.document_id, 'document_retry_started', {
                    retrySource,
                });
                claimed.push({
                    documentId: candidate.document_id,
                    emailId: candidate.email_id,
                    externalMessageId: candidate.external_message_id,
                    caseDraftId: candidate.case_draft_id,
                    sourceUrl: candidate.source_url,
                    documentType: candidate.document_type,
                    documentName: candidate.original_filename,
                    retrySource,
                });
            }
        });
        return claimed;
    }

    markEmailRetrying(emailId: string): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE email_records
                SET processing_status = 'processing',
                    processing_attempts = processing_attempts + 1,
                    last_attempt_at = ?,
                    processing_error = NULL,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(timestamp, timestamp, emailId);
        this.insertAuditLog('email_record', emailId, 'document_retry_processing_started');
    }

    completeDocumentRetrySuccess(input: {
        documentId: string;
        originalFilename: string | null;
        currentFilename: string;
        sourceUrl: string | null;
        oneDriveUrl: string | null;
        storagePath: string | null;
        fileSize: number;
        documentType: string | null;
        uploadSource: string;
        metadata?: unknown;
        downloadAttempts: number;
    }): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE document_records
                SET original_filename = COALESCE(?, original_filename),
                    current_filename = ?,
                    file_url = ?,
                    source_url = COALESCE(?, source_url),
                    one_drive_url = ?,
                    storage_path = ?,
                    mime_type = 'application/pdf',
                    file_size = ?,
                    document_type = COALESCE(?, document_type),
                    upload_source = ?,
                    status = 'uploaded',
                    error_message = NULL,
                    metadata_json = ?,
                    download_attempts = download_attempts + ?,
                    next_retry_at = NULL,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(
                input.originalFilename,
                input.currentFilename,
                input.oneDriveUrl,
                input.sourceUrl,
                input.oneDriveUrl,
                input.storagePath,
                input.fileSize,
                input.documentType,
                input.uploadSource,
                toJson(input.metadata),
                input.downloadAttempts,
                timestamp,
                input.documentId,
            );
        this.insertAuditLog('document_record', input.documentId, 'document_retry_uploaded', {
            downloadAttempts: input.downloadAttempts,
            oneDriveUrl: input.oneDriveUrl,
        });
    }

    completeDocumentRetryFailure(input: {
        documentId: string;
        reason: string;
        downloadAttempts: number;
        metadata?: unknown;
    }): void {
        const existing = this.db
            .prepare(`
                SELECT automatic_retry_count, metadata_json
                FROM document_records
                WHERE id = ?
            `)
            .get(input.documentId) as
            | { automatic_retry_count: number; metadata_json: string | null }
            | undefined;
        if (!existing) throw new Error('Document record not found');

        const retryCount = Number(existing.automatic_retry_count ?? 0);
        const nextRetryAt = nextDocumentRetryAt(retryCount);
        const timestamp = nowIso();
        const existingMetadata = this.safeJson(existing.metadata_json);
        const incomingMetadata = input.metadata && typeof input.metadata === 'object'
            ? input.metadata as Record<string, unknown>
            : {};
        const incomingFailureLog = failureLogFromMetadata(incomingMetadata);
        const mergedFailureLog = [
            ...failureLogFromMetadata(existingMetadata),
            ...(incomingFailureLog.length
                ? incomingFailureLog
                : [{
                    attempt: input.downloadAttempts,
                    at: timestamp,
                    stage: 'retry',
                    message: input.reason,
                }]),
        ].slice(-100);
        const mergedMetadata = {
            ...(existingMetadata && typeof existingMetadata === 'object'
                ? existingMetadata as Record<string, unknown>
                : {}),
            ...incomingMetadata,
            attemptLog: mergedFailureLog,
        };
        this.db
            .prepare(`
                UPDATE document_records
                SET status = 'failed',
                    error_message = ?,
                    metadata_json = ?,
                    download_attempts = download_attempts + ?,
                    next_retry_at = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(
                input.reason,
                toJson(mergedMetadata),
                input.downloadAttempts,
                nextRetryAt,
                timestamp,
                input.documentId,
            );
        this.insertAuditLog('document_record', input.documentId, 'document_retry_failed', {
            reason: input.reason,
            downloadAttempts: input.downloadAttempts,
            nextRetryAt,
            automaticRetryCount: retryCount,
        });
    }

    refreshEmailAfterDocumentRetries(emailId: string, caseDraftId: string | null): void {
        const totals = this.db
            .prepare(`
                SELECT
                    SUM(CASE WHEN status = 'uploaded' OR one_drive_url IS NOT NULL THEN 1 ELSE 0 END) AS uploaded_count,
                    SUM(CASE
                        WHEN source_url IS NOT NULL
                         AND status IN ('pending', 'failed', 'retry_queued', 'retrying')
                        THEN 1 ELSE 0
                    END) AS outstanding_count
                FROM document_records
                WHERE email_id = ?
            `)
            .get(emailId) as { uploaded_count: number | null; outstanding_count: number | null };
        const uploaded = Number(totals.uploaded_count ?? 0);
        const outstanding = Number(totals.outstanding_count ?? 0);

        if (outstanding > 0) {
            const status: Extract<EmailProcessingStatus, 'failed' | 'partial_failure'> =
                uploaded > 0 ? 'partial_failure' : 'failed';
            this.markEmailFailed(
                emailId,
                `${outstanding} document(s) still require download retry`,
                status,
            );
            if (caseDraftId) {
                this.setCaseDraftStatus(caseDraftId, 'needs_review', 'warnings', 'not_started');
            }
            return;
        }

        if (uploaded > 0) {
            this.markEmailProcessed(emailId);
            if (caseDraftId) {
                this.setCaseDraftStatus(caseDraftId, 'ready_to_file', 'passed', 'not_started');
            }
        }
    }

    clearPendingDocuments(caseDraftId: string): void {
        this.db
            .prepare(`
                DELETE FROM document_records
                WHERE case_draft_id = ?
                  AND status IN ('pending', 'not_downloadable')
                  AND upload_source = 'parsed_email'
            `)
            .run(caseDraftId);
    }

    listPlaintiffMappings(): {
        mappings: PlaintiffMappingView[];
        missing: MissingPlaintiffMappingView[];
    } {
        const usage = this.getDraftPlaintiffUsage();
        const rows = this.db
            .prepare(`
                SELECT
                    id,
                    full_name,
                    short_name,
                    is_active,
                    usage_count,
                    last_used_at,
                    created_at,
                    updated_at
                FROM plaintiff_mappings
                ORDER BY full_name COLLATE NOCASE
            `)
            .all() as any[];

        const activeNames = new Set<string>();
        const mappings = rows.map(row => {
            const fullName = row.full_name as string;
            const dynamicUsage = usage.get(fullName);
            const status: PlaintiffMappingView['status'] = !row.short_name
                ? 'needs_short_name'
                : Number(row.is_active) === 1
                    ? 'active'
                    : 'inactive';
            if (Number(row.is_active) === 1) {
                activeNames.add(fullName);
            }

            return {
                id: row.id,
                fullName,
                shortName: row.short_name ?? '',
                isActive: Number(row.is_active) === 1,
                status,
                usageCount: dynamicUsage?.usageCount ?? Number(row.usage_count ?? 0),
                lastUsedAt: dynamicUsage?.lastUsedAt ?? row.last_used_at,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            };
        });

        const missing = [...usage.entries()]
            .filter(([fullName]) => !activeNames.has(fullName))
            .map(([fullName, value]) => ({
                fullName,
                usageCount: value.usageCount,
                lastUsedAt: value.lastUsedAt,
            }))
            .sort((a, b) =>
                b.usageCount - a.usageCount ||
                a.fullName.localeCompare(b.fullName),
            );

        return { mappings, missing };
    }

    exportPlaintiffMappingSeed(): PlaintiffMappingSeed {
        const { mappings } = this.listPlaintiffMappings();
        return {
            version: 1,
            exportedAt: nowIso(),
            mappings: mappings
                .filter(mapping => !!normalizeName(mapping.shortName))
                .map(mapping => ({
                    fullName: mapping.fullName,
                    shortName: mapping.shortName,
                    isActive: mapping.isActive,
                })),
        };
    }

    importPlaintiffMappingSeed(seed: PlaintiffMappingSeed): number {
        if (seed.version !== 1 || !Array.isArray(seed.mappings)) {
            throw new Error('Unsupported Plaintiff mapping seed format');
        }

        let changed = 0;
        for (const mapping of seed.mappings) {
            const fullName = normalizeName(mapping.fullName);
            const shortName = normalizeName(mapping.shortName);
            if (!fullName || !shortName) continue;

            const existing = this.db
                .prepare(`
                    SELECT id, full_name, short_name, is_active
                    FROM plaintiff_mappings
                    WHERE full_name = ? COLLATE NOCASE
                    LIMIT 1
                `)
                .get(fullName) as any | undefined;
            const isActive = mapping.isActive !== false;

            if (
                existing &&
                normalizeName(existing.short_name) === shortName &&
                (Number(existing.is_active) === 1) === isActive
            ) {
                continue;
            }

            this.savePlaintiffMapping({
                id: existing?.id ?? null,
                fullName,
                shortName,
                isActive,
            });
            changed += 1;
        }

        return changed;
    }

    savePlaintiffMapping(input: {
        id?: string | null;
        fullName: string;
        shortName: string;
        isActive?: boolean;
    }): PlaintiffMappingView {
        const fullName = normalizeName(input.fullName);
        const shortName = normalizeName(input.shortName);

        if (!fullName) {
            throw new Error('Full Plaintiff name is required');
        }
        const timestamp = nowIso();
        const isActive = !!shortName && input.isActive !== false;
        const existing = input.id
            ? this.db
                .prepare('SELECT id, full_name, short_name, is_active FROM plaintiff_mappings WHERE id = ?')
                .get(input.id) as any | undefined
            : this.db
                .prepare(`
                    SELECT id, full_name, short_name, is_active
                    FROM plaintiff_mappings
                    WHERE full_name = ? COLLATE NOCASE
                `)
                .get(fullName) as any | undefined;

        const duplicate = this.db
            .prepare(`
                SELECT id
                FROM plaintiff_mappings
                WHERE full_name = ? COLLATE NOCASE
                  AND id != ?
                LIMIT 1
            `)
            .get(fullName, existing?.id ?? '') as { id: string } | undefined;
        if (duplicate) {
            throw new Error('A Plaintiff mapping already exists with this full name');
        }

        if (existing) {
            this.db
                .prepare(`
                    UPDATE plaintiff_mappings
                    SET full_name = ?,
                    short_name = ?,
                        is_active = ?,
                        updated_at = ?
                    WHERE id = ?
                `)
                .run(fullName, shortName ?? '', isActive ? 1 : 0, timestamp, existing.id);

            this.insertAuditLog(
                'plaintiff_mapping',
                existing.id,
                'plaintiff_mapping_updated',
                { fullName, shortName, isActive },
                {
                    fullName: existing.full_name,
                    shortName: existing.short_name,
                    isActive: Number(existing.is_active) === 1,
                },
                { fullName, shortName, isActive },
            );
            return this.getPlaintiffMapping(existing.id);
        }

        const id = randomUUID();
        this.db
            .prepare(`
                INSERT INTO plaintiff_mappings (
                    id,
                    full_name,
                    short_name,
                    is_active,
                    usage_count,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, 0, ?, ?)
            `)
            .run(id, fullName, shortName ?? '', isActive ? 1 : 0, timestamp, timestamp);

        this.insertAuditLog('plaintiff_mapping', id, 'plaintiff_mapping_created', {
            fullName,
            shortName,
            isActive,
        });

        return this.getPlaintiffMapping(id);
    }

    clearPlaintiffShortName(id: string): PlaintiffMappingView {
        const existing = this.db
            .prepare('SELECT id, full_name, short_name, is_active FROM plaintiff_mappings WHERE id = ?')
            .get(id) as any | undefined;

        if (!existing) {
            throw new Error('Plaintiff mapping not found');
        }

        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE plaintiff_mappings
                SET short_name = '',
                    is_active = 0,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(timestamp, id);
        this.insertAuditLog(
            'plaintiff_mapping',
            id,
            'plaintiff_mapping_short_name_cleared',
            { fullName: existing.full_name },
            {
                shortName: existing.short_name,
                isActive: Number(existing.is_active) === 1,
            },
            { shortName: '', isActive: false },
        );

        return this.getPlaintiffMapping(id);
    }

    ensurePlaintiffCandidateFromParsed(parsed: ParsedEmailInfo): PlaintiffMappingView | null {
        const fullName = extractPlaintiffName(parsed);
        if (!fullName) return null;

        const existing = this.db
            .prepare('SELECT id FROM plaintiff_mappings WHERE full_name = ? COLLATE NOCASE LIMIT 1')
            .get(fullName) as { id: string } | undefined;

        if (existing) {
            return this.getPlaintiffMapping(existing.id);
        }

        const id = randomUUID();
        const timestamp = nowIso();
        this.db
            .prepare(`
                INSERT INTO plaintiff_mappings (
                    id,
                    full_name,
                    short_name,
                    is_active,
                    usage_count,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, '', 0, 0, ?, ?)
            `)
            .run(id, fullName, timestamp, timestamp);

        this.insertAuditLog('plaintiff_mapping', id, 'plaintiff_mapping_candidate_created', {
            fullName,
            caseNumber: parsed.caseNumber,
            source: 'parsed_email',
        });

        return this.getPlaintiffMapping(id);
    }

    getActivePlaintiffShortName(parsed: ParsedEmailInfo): string | null {
        return this.lookupPlaintiffNaming(parsed).shortName;
    }

    lookupPlaintiffNaming(parsed: ParsedEmailInfo): PlaintiffNamingLookup {
        const fullName = extractPlaintiffName(parsed);
        const mapping = this.getPlaintiffMappingStatus(fullName);
        return {
            fullName,
            shortName: mapping.status === 'mapped' ? mapping.shortName : null,
            mappingStatus: mapping.status,
        };
    }

    setPlaintiffMappingActive(id: string, isActive: boolean): PlaintiffMappingView {
        const existing = this.db
            .prepare('SELECT id, full_name, short_name, is_active FROM plaintiff_mappings WHERE id = ?')
            .get(id) as any | undefined;

        if (!existing) {
            throw new Error('Plaintiff mapping not found');
        }

        if (isActive && !normalizeName(existing.short_name)) {
            throw new Error('Short Plaintiff name is required before activation');
        }

        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE plaintiff_mappings
                SET is_active = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(isActive ? 1 : 0, timestamp, id);

        this.insertAuditLog(
            'plaintiff_mapping',
            id,
            isActive ? 'plaintiff_mapping_activated' : 'plaintiff_mapping_deactivated',
            { fullName: existing.full_name, shortName: existing.short_name },
            { isActive: Number(existing.is_active) === 1 },
            { isActive },
        );

        return this.getPlaintiffMapping(id);
    }

    getPlaintiffFilenameRenamePlan(mappingId: string): PlaintiffFilenameRenamePlan {
        const mapping = this.db
            .prepare(`
                SELECT id, full_name, short_name, is_active
                FROM plaintiff_mappings
                WHERE id = ?
            `)
            .get(mappingId) as any | undefined;
        if (!mapping) throw new Error('Plaintiff mapping not found');

        const fullName = normalizeName(mapping.full_name);
        const shortName = normalizeName(mapping.short_name);
        if (!fullName || !shortName || Number(mapping.is_active) !== 1) {
            throw new Error('An active Plaintiff mapping with a short name is required');
        }

        const rows = this.db
            .prepare(`
                SELECT
                    d.id,
                    d.current_filename,
                    d.one_drive_url,
                    d.storage_path,
                    c.normalized_data_json
                FROM document_records d
                JOIN case_drafts c ON c.id = d.case_draft_id
                WHERE d.status = 'uploaded'
                  AND d.current_filename IS NOT NULL
                  AND d.one_drive_url IS NOT NULL
            `)
            .all() as any[];

        const targets: PlaintiffFilenameRenameTarget[] = [];
        for (const row of rows) {
            const plaintiff = extractPlaintiffName(this.safeJson(row.normalized_data_json));
            if (!plaintiff || plaintiff.localeCompare(fullName, undefined, { sensitivity: 'accent' }) !== 0) {
                continue;
            }

            const nextFilename = renamePlaintiffInFilename(
                row.current_filename,
                fullName,
                shortName,
            );
            if (!nextFilename || nextFilename === row.current_filename) continue;

            targets.push({
                documentId: row.id,
                currentFilename: row.current_filename,
                nextFilename,
                oneDriveUrl: row.one_drive_url,
                storagePath: row.storage_path,
            });
        }

        return {
            mappingId,
            fullName,
            shortName,
            targets,
        };
    }

    getEmailPlaintiffFilenameMappingState(emailId: string): PlaintiffFilenameMappingState {
        const caseDraft = this.db
            .prepare(`
                SELECT normalized_data_json
                FROM case_drafts
                WHERE email_id = ?
                ORDER BY created_at DESC
                LIMIT 1
            `)
            .get(emailId) as { normalized_data_json: string | null } | undefined;
        const fullName = extractPlaintiffName(this.safeJson(caseDraft?.normalized_data_json));
        const mapping = this.getPlaintiffMappingStatus(fullName);
        const shortName = mapping.status === 'mapped' ? mapping.shortName : null;

        const documents = this.db
            .prepare(`
                SELECT current_filename, one_drive_url
                FROM document_records
                WHERE email_id = ?
                  AND status = 'uploaded'
                  AND current_filename IS NOT NULL
                  AND one_drive_url IS NOT NULL
            `)
            .all(emailId) as Array<{ current_filename: string; one_drive_url: string }>;

        let appliedDocumentCount = 0;
        let needsApplicationCount = 0;
        if (fullName && shortName) {
            for (const document of documents) {
                const next = renamePlaintiffInFilename(document.current_filename, fullName, shortName);
                if (next) {
                    needsApplicationCount += 1;
                } else if (document.current_filename.includes(filenameToken(shortName))) {
                    appliedDocumentCount += 1;
                }
            }
        }

        return {
            fullName,
            shortName,
            eligibleDocumentCount: documents.length,
            appliedDocumentCount,
            needsApplicationCount,
        };
    }

    recordPlaintiffFilenameRenameSuccess(input: {
        documentId: string;
        currentFilename: string;
        storagePath: string | null;
        driveId: string;
        itemId: string;
    }): void {
        const existing = this.db
            .prepare(`
                SELECT current_filename, storage_path, metadata_json
                FROM document_records
                WHERE id = ?
            `)
            .get(input.documentId) as any | undefined;
        if (!existing) throw new Error('Document record not found');

        const existingMetadata = this.safeJson(existing.metadata_json);
        const metadata = {
            ...(existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {}),
            driveId: input.driveId,
            itemId: input.itemId,
        };
        const storagePath = input.storagePath ?? existing.storage_path;
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE document_records
                SET current_filename = ?,
                    storage_path = ?,
                    metadata_json = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(input.currentFilename, storagePath, toJson(metadata), timestamp, input.documentId);
        this.insertAuditLog(
            'document_record',
            input.documentId,
            'document_plaintiff_filename_applied',
            { driveId: input.driveId, itemId: input.itemId },
            { currentFilename: existing.current_filename, storagePath: existing.storage_path },
            { currentFilename: input.currentFilename, storagePath },
        );
    }

    recordPlaintiffFilenameRenameFailure(documentId: string, error: unknown): void {
        this.insertAuditLog('document_record', documentId, 'document_plaintiff_filename_failed', {
            error: normalizeError(error),
        });
    }

    applyProcessingReport(report: ProcessingReportInput): ProcessingReportApplyResult {
        const notApplied: ProcessingReportApplyResult = {
            applied: false,
            targetEmailId: null,
            caseDraftId: null,
            plaintiffMappingId: null,
        };

        if (!report.originalSubject || !report.originalReceivedAt || report.documents.length === 0) {
            return notApplied;
        }

        const target = this.db
            .prepare(`
                SELECT
                    e.id AS email_id,
                    c.id AS case_draft_id,
                    c.normalized_data_json
                FROM email_records e
                JOIN case_drafts c ON c.email_id = e.id
                WHERE e.subject = ?
                  AND e.received_at = ?
                ORDER BY c.created_at DESC
                LIMIT 1
            `)
            .get(report.originalSubject, report.originalReceivedAt) as
            | {
                email_id: string;
                case_draft_id: string;
                normalized_data_json: string | null;
            }
            | undefined;

        if (!target) return notApplied;

        const plaintiffMapping = this.getPlaintiffMappingStatus(
            extractPlaintiffName(this.safeJson(target.normalized_data_json)),
        );
        const targetResult: ProcessingReportApplyResult = {
            applied: false,
            targetEmailId: target.email_id,
            caseDraftId: target.case_draft_id,
            plaintiffMappingId: plaintiffMapping.status === 'mapped'
                ? plaintiffMapping.mappingId
                : null,
        };

        const existingResults = this.db
            .prepare(`
                SELECT COUNT(*) AS count
                FROM document_records
                WHERE case_draft_id = ?
                  AND (
                    status IN ('uploaded', 'failed')
                    OR one_drive_url IS NOT NULL
                  )
                  AND upload_source != 'parsed_email'
            `)
            .get(target.case_draft_id) as { count: number };

        if (Number(existingResults.count ?? 0) > 0) {
            return targetResult;
        }

        const pendingDocuments = this.db
            .prepare(`
                SELECT
                    original_filename,
                    source_url,
                    document_type
                FROM document_records
                WHERE case_draft_id = ?
                  AND status = 'pending'
                  AND upload_source = 'parsed_email'
                ORDER BY created_at
            `)
            .all(target.case_draft_id) as Array<{
                original_filename: string | null;
                source_url: string | null;
                document_type: string | null;
            }>;

        const downloadableDocuments = pendingDocuments.filter(document => !!document.source_url);
        const nonDownloadableDocuments = pendingDocuments.filter(document => !document.source_url);
        const missingExpectedDocuments = downloadableDocuments.slice(report.documents.length);

        this.runInTransaction(() => {
            this.clearPendingDocuments(target.case_draft_id);

            for (let i = 0; i < report.documents.length; i++) {
                const doc = report.documents[i];
                const expected = downloadableDocuments[i];

                this.addDocument({
                    emailId: target.email_id,
                    caseDraftId: target.case_draft_id,
                    originalFilename: expected?.original_filename ?? doc.fileName,
                    currentFilename: doc.fileName,
                    fileUrl: doc.oneDriveUrl,
                    sourceUrl: expected?.source_url ?? null,
                    oneDriveUrl: doc.oneDriveUrl,
                    storagePath: null,
                    mimeType: 'application/pdf',
                    fileSize: null,
                    documentType: expected?.document_type ?? null,
                    uploadSource: 'processing_report',
                    status: 'uploaded',
                    metadata: {
                        reportMessageId: report.reportMessageId,
                        caseNumber: report.caseNumber,
                        caseTitle: report.caseTitle,
                    },
                });
            }

            for (const expected of missingExpectedDocuments) {
                this.addDocument({
                    emailId: target.email_id,
                    caseDraftId: target.case_draft_id,
                    originalFilename: expected.original_filename,
                    currentFilename: null,
                    fileUrl: null,
                    sourceUrl: expected.source_url,
                    oneDriveUrl: null,
                    storagePath: null,
                    mimeType: 'application/pdf',
                    fileSize: null,
                    documentType: expected.document_type,
                    uploadSource: 'processing_report',
                    status: 'failed',
                    errorMessage: expected.source_url
                        ? 'Expected document was not present in the processing report'
                        : 'Expected document has no downloadable source URL',
                    metadata: {
                        reportMessageId: report.reportMessageId,
                        caseNumber: report.caseNumber,
                        caseTitle: report.caseTitle,
                    },
                });
            }

            for (const expected of nonDownloadableDocuments) {
                this.addDocument({
                    emailId: target.email_id,
                    caseDraftId: target.case_draft_id,
                    originalFilename: expected.original_filename,
                    currentFilename: null,
                    fileUrl: null,
                    sourceUrl: null,
                    oneDriveUrl: null,
                    storagePath: null,
                    mimeType: 'application/pdf',
                    fileSize: null,
                    documentType: expected.document_type,
                    uploadSource: 'processing_report',
                    status: 'not_downloadable',
                    errorMessage: 'No downloadable file in source email',
                    metadata: {
                        reportMessageId: report.reportMessageId,
                        caseNumber: report.caseNumber,
                        caseTitle: report.caseTitle,
                    },
                });
            }

            if (missingExpectedDocuments.length > 0) {
                this.markEmailFailed(
                    target.email_id,
                    `${missingExpectedDocuments.length} expected document(s) missing from processing report`,
                    'partial_failure',
                );
                this.setCaseDraftStatus(target.case_draft_id, 'needs_review', 'warnings', 'not_started');
            } else {
                this.markEmailProcessed(target.email_id);
                this.setCaseDraftStatus(target.case_draft_id, 'ready_to_file', 'passed', 'not_started');
            }

            this.insertAuditLog('email_record', target.email_id, 'processing_report_applied', {
                reportMessageId: report.reportMessageId,
                uploadedDocuments: report.documents.length,
                missingExpectedDocuments: missingExpectedDocuments.length,
                nonDownloadableDocuments: nonDownloadableDocuments.length,
            });
        });

        return {
            ...targetResult,
            applied: true,
        };
    }

    getDashboardSummary(): DashboardSummary {
        return {
            emailStatuses: this.countBy('email_records', 'processing_status'),
            draftStatuses: this.countBy('case_drafts', 'status'),
            documentStatuses: this.countBy('document_records', 'status'),
            filingStatuses: this.countBy('case_drafts', 'filing_status'),
            documentsToday: this.countSinceToday('document_records'),
            emailsToday: this.countSinceToday(
                'email_records',
                "processing_status != 'legacy_processed'",
            ),
            missingPlaintiffMappings: this.countMissingPlaintiffMappings(),
            databaseBytes: this.getDatabaseSizeBytes(),
        };
    }

    listQueue(options: QueueListOptions = {}): QueuePage {
        const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? 50), 10), 200);
        const requestedPage = Math.max(Math.floor(options.page ?? 1), 1);
        const scope = options.scope ?? 'active';
        const visibilityWhere = scope === 'all'
            ? `(e.processing_status != 'legacy_processed' OR e.subject IS NOT NULL)`
            : `(
                (e.processing_status != 'legacy_processed' OR e.subject IS NOT NULL)
                AND e.processing_status != 'ignored'
                AND NOT (e.processing_status = 'new' AND c.id IS NULL)
            )`;
        const whereParts = [visibilityWhere];
        const parameters: Array<string | number> = [];

        if (options.status) {
            whereParts.push('e.processing_status = ?');
            parameters.push(options.status);
        }

        const search = options.search?.trim();
        if (search) {
            const pattern = `%${search}%`;
            whereParts.push(`(
                e.subject LIKE ? COLLATE NOCASE
                OR e.sender LIKE ? COLLATE NOCASE
                OR e.processing_error LIKE ? COLLATE NOCASE
                OR c.normalized_data_json LIKE ? COLLATE NOCASE
            )`);
            parameters.push(pattern, pattern, pattern, pattern);
        }

        if (options.dateFrom) {
            whereParts.push('COALESCE(e.received_at, e.created_at) >= ?');
            parameters.push(options.dateFrom);
        }

        if (options.dateTo) {
            whereParts.push('COALESCE(e.received_at, e.created_at) < ?');
            parameters.push(options.dateTo);
        }

        const whereSql = whereParts.join('\n AND ');
        const countRow = this.db
            .prepare(`
                SELECT COUNT(DISTINCT e.id) AS total
                FROM email_records e
                LEFT JOIN case_drafts c ON c.email_id = e.id
                WHERE ${whereSql}
            `)
            .get(...parameters) as { total: number };
        const totalItems = Number(countRow.total ?? 0);
        const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
        const page = Math.min(requestedPage, totalPages);
        const offset = (page - 1) * pageSize;

        const rows = this.db
            .prepare(`
                SELECT
                    e.id AS email_id,
                    c.id AS case_draft_id,
                    e.sender,
                    e.subject,
                    e.received_at,
                    e.processing_status,
                    e.processing_error,
                    e.updated_at,
                    c.status AS draft_status,
                    c.validation_status,
                    c.filing_status,
                    c.workflow_mode,
                    c.normalized_data_json,
                    COUNT(d.id) AS document_count,
                    SUM(CASE WHEN d.status IN ('pending', 'retry_queued', 'retrying', 'uploaded', 'failed') OR d.one_drive_url IS NOT NULL THEN 1 ELSE 0 END) AS expected_document_count,
                    SUM(CASE WHEN d.status = 'uploaded' OR d.one_drive_url IS NOT NULL THEN 1 ELSE 0 END) AS uploaded_document_count,
                    SUM(CASE WHEN d.one_drive_url IS NOT NULL THEN 1 ELSE 0 END) AS one_drive_document_count,
                    SUM(CASE WHEN d.status = 'pending' THEN 1 ELSE 0 END) AS pending_document_count,
                    SUM(CASE WHEN d.status = 'retry_queued' THEN 1 ELSE 0 END) AS retry_queued_document_count,
                    SUM(CASE WHEN d.status = 'retrying' THEN 1 ELSE 0 END) AS retrying_document_count,
                    SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failed_document_count,
                    SUM(CASE WHEN d.status = 'not_downloadable' THEN 1 ELSE 0 END) AS not_downloadable_document_count
                FROM email_records e
                LEFT JOIN case_drafts c ON c.email_id = e.id
                LEFT JOIN document_records d ON d.email_id = e.id
                WHERE ${whereSql}
                GROUP BY e.id, c.id
                ORDER BY
                    ${scope === 'active' ? `
                    CASE
                        WHEN e.processing_status IN ('failed', 'partial_failure') THEN 0
                        WHEN c.id IS NOT NULL THEN 1
                        WHEN e.processing_status = 'new' THEN 2
                        ELSE 3
                    END,` : ''}
                    COALESCE(e.received_at, e.created_at) DESC
                LIMIT ? OFFSET ?
            `)
            .all(...parameters, pageSize, offset) as any[];

        const items = rows.map(row => {
            const normalized = this.safeJson(row.normalized_data_json);
            const plaintiffName = extractPlaintiffName(normalized);
            const plaintiffMapping = this.getPlaintiffMappingStatus(plaintiffName);
            return {
                emailId: row.email_id,
                caseDraftId: row.case_draft_id,
                sender: row.sender,
                subject: row.subject,
                receivedAt: row.received_at,
                processingStatus: row.processing_status,
                processingError: row.processing_error,
                documentCount: Number(row.document_count ?? 0),
                expectedDocumentCount: Number(row.expected_document_count ?? 0),
                uploadedDocumentCount: Number(row.uploaded_document_count ?? 0),
                oneDriveDocumentCount: Number(row.one_drive_document_count ?? 0),
                pendingDocumentCount: Number(row.pending_document_count ?? 0),
                retryQueuedDocumentCount: Number(row.retry_queued_document_count ?? 0),
                retryingDocumentCount: Number(row.retrying_document_count ?? 0),
                failedDocumentCount: Number(row.failed_document_count ?? 0),
                notDownloadableDocumentCount: Number(row.not_downloadable_document_count ?? 0),
                plaintiffName,
                plaintiffShortName: plaintiffMapping.status === 'mapped'
                    ? plaintiffMapping.shortName
                    : null,
                plaintiffMappingStatus: plaintiffMapping.status,
                caseNumber: normalized?.caseNumber ?? null,
                draftStatus: row.draft_status,
                validationStatus: row.validation_status,
                filingStatus: row.filing_status,
                workflowMode: row.workflow_mode,
                updatedAt: row.updated_at,
            };
        });

        return {
            items,
            page,
            pageSize,
            totalItems,
            totalPages,
        };
    }

    countDeletableEmailsBefore(cutoff: string): number {
        const row = this.db
            .prepare(`
                SELECT COUNT(*) AS count
                FROM email_records e
                WHERE COALESCE(e.received_at, e.created_at) < ?
                  AND e.processing_status IN (
                    'processed',
                    'failed',
                    'partial_failure',
                    'ignored',
                    'legacy_processed'
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM document_records d
                    WHERE d.email_id = e.id
                      AND d.status IN ('retry_queued', 'retrying')
                  )
            `)
            .get(cutoff) as { count: number };
        return Number(row.count ?? 0);
    }

    deleteEmailRecord(emailId: string): EmailDeleteResult {
        const email = this.db
            .prepare(`
                SELECT external_message_id, processing_status
                FROM email_records
                WHERE id = ?
            `)
            .get(emailId) as
            | { external_message_id: string; processing_status: EmailProcessingStatus }
            | undefined;
        if (!email) throw new Error('Email record not found');
        if (email.processing_status === 'processing') {
            throw new Error('A processing email cannot be deleted');
        }

        const activeRetry = this.db
            .prepare(`
                SELECT 1
                FROM document_records
                WHERE email_id = ?
                  AND status IN ('retry_queued', 'retrying')
                LIMIT 1
            `)
            .get(emailId);
        if (activeRetry) {
            throw new Error('An email with an active document retry cannot be deleted');
        }

        return this.runInTransaction(() =>
            this.deleteEmailRecordInternal(emailId, email.external_message_id),
        );
    }

    purgeEmailRecordsBefore(cutoff: string): EmailPurgeResult {
        const candidates = this.db
            .prepare(`
                SELECT e.id, e.external_message_id
                FROM email_records e
                WHERE COALESCE(e.received_at, e.created_at) < ?
                  AND e.processing_status IN (
                    'processed',
                    'failed',
                    'partial_failure',
                    'ignored',
                    'legacy_processed'
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM document_records d
                    WHERE d.email_id = e.id
                      AND d.status IN ('retry_queued', 'retrying')
                  )
                ORDER BY COALESCE(e.received_at, e.created_at)
            `)
            .all(cutoff) as Array<{ id: string; external_message_id: string }>;

        const totals: EmailPurgeResult = {
            cutoff,
            emailRecords: 0,
            caseDrafts: 0,
            documentRecords: 0,
            filingJobs: 0,
            auditLogs: 0,
            tombstones: 0,
            oneDriveFilesDeleted: 0,
        };

        this.runInTransaction(() => {
            for (const candidate of candidates) {
                const deleted = this.deleteEmailRecordInternal(
                    candidate.id,
                    candidate.external_message_id,
                );
                totals.emailRecords += deleted.emailRecords;
                totals.caseDrafts += deleted.caseDrafts;
                totals.documentRecords += deleted.documentRecords;
                totals.filingJobs += deleted.filingJobs;
                totals.auditLogs += deleted.auditLogs;
                totals.tombstones += deleted.emailRecords;
            }
        });

        if (totals.emailRecords > 0) {
            this.compactDatabase();
        }
        return totals;
    }

    getEmailDetail(emailId: string): EmailDetail | null {
        const email = this.db
            .prepare(`
                SELECT
                    id,
                    external_message_id,
                    sender,
                    subject,
                    received_at,
                    body_summary,
                    processing_status,
                    processing_error,
                    processing_attempts,
                    last_attempt_at,
                    processed_at,
                    created_at,
                    updated_at
                FROM email_records
                WHERE id = ?
            `)
            .get(emailId) as any | undefined;

        if (!email) return null;

        const caseDraft = this.db
            .prepare(`
                SELECT
                    id,
                    workflow_mode,
                    status,
                    validation_status,
                    filing_status,
                    extracted_data_json,
                    normalized_data_json,
                    reviewer_notes,
                    reviewed_at,
                    created_at,
                    updated_at
                FROM case_drafts
                WHERE email_id = ?
                ORDER BY created_at DESC
                LIMIT 1
            `)
            .get(emailId) as any | undefined;

        const documents = this.db
            .prepare(`
                SELECT
                    id,
                    original_filename,
                    current_filename,
                    file_url,
                    source_url,
                    one_drive_url,
                    storage_path,
                    mime_type,
                    file_size,
                    document_type,
                    upload_source,
                    status,
                    error_message,
                    metadata_json,
                    download_attempts,
                    automatic_retry_count,
                    last_retry_at,
                    next_retry_at,
                    created_at,
                    updated_at
                FROM document_records
                WHERE email_id = ?
                ORDER BY created_at DESC
            `)
            .all(emailId) as any[];

        const auditLogs = this.db
            .prepare(`
                SELECT
                    id,
                    entity_type,
                    entity_id,
                    action,
                    actor_type,
                    actor_id,
                    metadata_json,
                    created_at
                FROM audit_logs
                WHERE entity_id IN (
                    SELECT id FROM email_records WHERE id = ?
                    UNION
                    SELECT id FROM case_drafts WHERE email_id = ?
                    UNION
                    SELECT id FROM document_records WHERE email_id = ?
                )
                ORDER BY created_at DESC
                LIMIT 100
            `)
            .all(emailId, emailId, emailId) as any[];

        const plaintiffMapping = this.getPlaintiffMappingStatus(
            caseDraft
                ? extractPlaintiffName(this.safeJson(caseDraft.normalized_data_json))
                : null,
        );
        const plaintiffFilenameMapping = this.getEmailPlaintiffFilenameMappingState(emailId);

        return {
            email: {
                id: email.id,
                externalMessageId: email.external_message_id,
                sender: email.sender,
                subject: email.subject,
                receivedAt: email.received_at,
                bodySummary: email.body_summary,
                processingStatus: email.processing_status,
                processingError: email.processing_error,
                processingAttempts: Number(email.processing_attempts ?? 0),
                lastAttemptAt: email.last_attempt_at,
                processedAt: email.processed_at,
                createdAt: email.created_at,
                updatedAt: email.updated_at,
            },
            caseDraft: caseDraft
                ? {
                    id: caseDraft.id,
                    workflowMode: caseDraft.workflow_mode,
                    status: caseDraft.status,
                    validationStatus: caseDraft.validation_status,
                    filingStatus: caseDraft.filing_status,
                    extractedDataJson: caseDraft.extracted_data_json,
                    normalizedDataJson: caseDraft.normalized_data_json,
                    reviewerNotes: caseDraft.reviewer_notes,
                    reviewedAt: caseDraft.reviewed_at,
                    createdAt: caseDraft.created_at,
                    updatedAt: caseDraft.updated_at,
                }
                : null,
            plaintiffMapping,
            plaintiffFilenameMapping,
            retryPolicy: this.getDocumentRetryPolicy(),
            documents: documents.map(row => ({
                id: row.id,
                originalFilename: row.original_filename,
                currentFilename: row.current_filename,
                fileUrl: row.file_url,
                sourceUrl: row.source_url,
                oneDriveUrl: row.one_drive_url,
                storagePath: row.storage_path,
                mimeType: row.mime_type,
                fileSize: row.file_size === null ? null : Number(row.file_size),
                documentType: row.document_type,
                uploadSource: row.upload_source,
                status: row.status,
                errorMessage: row.error_message,
                downloadAttempts: Number(row.download_attempts ?? 0),
                automaticRetryCount: Number(row.automatic_retry_count ?? 0),
                lastRetryAt: row.last_retry_at,
                nextRetryAt: row.next_retry_at,
                failureLog: failureLogFromMetadata(this.safeJson(row.metadata_json)),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            })),
            auditLogs: auditLogs.map(row => ({
                id: row.id,
                entityType: row.entity_type,
                entityId: row.entity_id,
                action: row.action,
                actorType: row.actor_type,
                actorId: row.actor_id,
                metadataJson: row.metadata_json,
                createdAt: row.created_at,
            })),
        };
    }

    createCaseDraft(emailId: string, parsed: ParsedEmailInfo): string {
        const parsedJson = toJson(parsed);
        this.ensurePlaintiffCandidateFromParsed(parsed);

        const existing = this.db
            .prepare(`
                SELECT id, normalized_data_json
                FROM case_drafts
                WHERE email_id = ?
                ORDER BY created_at DESC
                LIMIT 1
            `)
            .get(emailId) as { id: string; normalized_data_json: string | null } | undefined;

        if (existing) {
            this.ensureExpectedDocuments(emailId, existing.id, parsed);

            if (existing.normalized_data_json === parsedJson) {
                return existing.id;
            }

            const timestamp = nowIso();
            this.db
                .prepare(`
                    UPDATE case_drafts
                    SET extracted_data_json = ?,
                        normalized_data_json = ?,
                        status = 'parsed',
                        updated_at = ?
                    WHERE id = ?
                `)
                .run(parsedJson, parsedJson, timestamp, existing.id);
            this.insertAuditLog('case_draft', existing.id, 'draft_reparsed');
            return existing.id;
        }

        const id = randomUUID();
        const timestamp = nowIso();
        const workflowMode = process.env.WORKFLOW_MODE || 'review_before_submission';

        this.db
            .prepare(`
                INSERT INTO case_drafts (
                    id,
                    email_id,
                    workflow_mode,
                    status,
                    validation_status,
                    filing_status,
                    extracted_data_json,
                    normalized_data_json,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, 'parsed', 'unknown', 'not_started', ?, ?, ?, ?)
            `)
            .run(id, emailId, workflowMode, parsedJson, parsedJson, timestamp, timestamp);

        this.ensureExpectedDocuments(emailId, id, parsed);

        this.insertAuditLog('case_draft', id, 'draft_created', {
            emailId,
            workflowMode,
            caseNumber: parsed.caseNumber,
        });

        return id;
    }

    setCaseDraftStatus(
        caseDraftId: string,
        status: CaseDraftStatus,
        validationStatus?: ValidationStatus,
        filingStatus?: FilingStatus,
    ): void {
        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE case_drafts
                SET status = ?,
                    validation_status = COALESCE(?, validation_status),
                    filing_status = COALESCE(?, filing_status),
                    updated_at = ?
                WHERE id = ?
            `)
            .run(status, validationStatus ?? null, filingStatus ?? null, timestamp, caseDraftId);
        this.insertAuditLog('case_draft', caseDraftId, 'draft_status_changed', {
            status,
            validationStatus,
            filingStatus,
        });
    }

    reviewCaseDraft(caseDraftId: string, action: ReviewAction, notes?: string | null): void {
        const existing = this.db
            .prepare(`
                SELECT status, validation_status, filing_status, reviewer_notes
                FROM case_drafts
                WHERE id = ?
            `)
            .get(caseDraftId) as
            | {
                status: CaseDraftStatus;
                validation_status: ValidationStatus;
                filing_status: FilingStatus;
                reviewer_notes: string | null;
            }
            | undefined;

        if (!existing) {
            throw new Error('Case draft not found');
        }

        const timestamp = nowIso();
        const next = {
            status: existing.status,
            validationStatus: existing.validation_status,
            filingStatus: existing.filing_status,
            reviewerNotes: notes === undefined ? existing.reviewer_notes : notes,
            reviewedAt: null as string | null,
            auditAction: 'review_note_saved',
        };

        if (action === 'move_to_review') {
            next.status = 'needs_review';
            next.validationStatus = 'warnings';
            next.filingStatus = 'not_started';
            next.auditAction = 'moved_to_review';
        } else if (action === 'approve') {
            next.status = 'ready_to_file';
            next.validationStatus = 'passed';
            next.filingStatus = 'not_started';
            next.reviewedAt = timestamp;
            next.auditAction = 'approval_granted';
        } else if (action === 'reject') {
            next.status = 'rejected';
            next.validationStatus = 'failed';
            next.filingStatus = 'not_started';
            next.reviewedAt = timestamp;
            next.auditAction = 'draft_rejected';
        }

        this.db
            .prepare(`
                UPDATE case_drafts
                SET status = ?,
                    validation_status = ?,
                    filing_status = ?,
                    reviewer_notes = ?,
                    reviewed_at = COALESCE(?, reviewed_at),
                    updated_at = ?
                WHERE id = ?
            `)
            .run(
                next.status,
                next.validationStatus,
                next.filingStatus,
                next.reviewerNotes,
                next.reviewedAt,
                timestamp,
                caseDraftId,
            );

        this.insertAuditLog(
            'case_draft',
            caseDraftId,
            next.auditAction,
            { action, notes: next.reviewerNotes },
            {
                status: existing.status,
                validationStatus: existing.validation_status,
                filingStatus: existing.filing_status,
                reviewerNotes: existing.reviewer_notes,
            },
            {
                status: next.status,
                validationStatus: next.validationStatus,
                filingStatus: next.filingStatus,
                reviewerNotes: next.reviewerNotes,
            },
        );
    }

    addDocument(input: StoredDocumentInput): string {
        const id = randomUUID();
        const timestamp = nowIso();
        const automaticRetryCount = input.automaticRetryCount ?? 0;
        const nextRetryAt = input.nextRetryAt === undefined
            ? (input.status === 'failed' && input.sourceUrl
                ? nextDocumentRetryAt(automaticRetryCount)
                : null)
            : input.nextRetryAt;
        const lastRetryAt = input.lastRetryAt === undefined
            ? (input.status === 'failed' ? timestamp : null)
            : input.lastRetryAt;
        this.db
            .prepare(`
                INSERT INTO document_records (
                    id,
                    email_id,
                    case_draft_id,
                    original_filename,
                    current_filename,
                    file_url,
                    source_url,
                    one_drive_url,
                    storage_path,
                    mime_type,
                    file_size,
                    document_type,
                    upload_source,
                    status,
                    error_message,
                    metadata_json,
                    download_attempts,
                    automatic_retry_count,
                    last_retry_at,
                    next_retry_at,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
                id,
                input.emailId,
                input.caseDraftId ?? null,
                input.originalFilename ?? null,
                input.currentFilename ?? null,
                input.fileUrl ?? null,
                input.sourceUrl ?? null,
                input.oneDriveUrl ?? null,
                input.storagePath ?? null,
                input.mimeType ?? null,
                input.fileSize ?? null,
                input.documentType ?? null,
                input.uploadSource,
                input.status,
                input.errorMessage ?? null,
                toJson(input.metadata),
                input.downloadAttempts ?? 0,
                automaticRetryCount,
                lastRetryAt,
                nextRetryAt,
                timestamp,
                timestamp,
            );

        this.insertAuditLog('document_record', id, `document_${input.status}`, {
            emailId: input.emailId,
            caseDraftId: input.caseDraftId ?? null,
            documentType: input.documentType ?? null,
        });

        return id;
    }

    private applyMigrations(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL
            )
        `);

        for (const migration of migrations) {
            const applied = this.db
                .prepare('SELECT version FROM schema_migrations WHERE version = ?')
                .get(migration.version);

            if (applied) continue;

            this.runInTransaction(() => {
                migration.up(this.db);
                this.db
                    .prepare(`
                        INSERT INTO schema_migrations (version, name, applied_at)
                        VALUES (?, ?, ?)
                    `)
                    .run(migration.version, migration.name, nowIso());
            });
        }
    }

    private runInTransaction<T>(fn: () => T): T {
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    private countBy(tableName: string, columnName: string): Record<string, number> {
        const rows = this.db
            .prepare(`
                SELECT ${columnName} AS key, COUNT(*) AS count
                FROM ${tableName}
                GROUP BY ${columnName}
            `)
            .all() as { key: string; count: number }[];

        return Object.fromEntries(rows.map(row => [row.key, Number(row.count)]));
    }

    private getDatabaseSizeBytes(): number {
        return [
            this.databasePath,
            `${this.databasePath}-wal`,
            `${this.databasePath}-shm`,
        ].reduce((total, filePath) => {
            try {
                return total + fs.statSync(filePath).size;
            } catch {
                return total;
            }
        }, 0);
    }

    private deleteEmailRecordInternal(
        emailId: string,
        externalMessageId: string,
    ): EmailDeleteResult {
        const timestamp = nowIso();
        this.db
            .prepare(`
                INSERT INTO deleted_email_tombstones (external_message_id, deleted_at)
                VALUES (?, ?)
                ON CONFLICT(external_message_id) DO UPDATE SET deleted_at = excluded.deleted_at
            `)
            .run(externalMessageId, timestamp);

        const auditLogs = this.db
            .prepare(`
                DELETE FROM audit_logs
                WHERE entity_id = ?
                   OR entity_id IN (SELECT id FROM case_drafts WHERE email_id = ?)
                   OR entity_id IN (SELECT id FROM document_records WHERE email_id = ?)
                   OR entity_id IN (
                        SELECT f.id
                        FROM filing_jobs f
                        JOIN case_drafts c ON c.id = f.case_draft_id
                        WHERE c.email_id = ?
                   )
            `)
            .run(emailId, emailId, emailId, emailId);

        this.db
            .prepare('UPDATE case_drafts SET primary_document_id = NULL WHERE email_id = ?')
            .run(emailId);
        const filingJobs = this.db
            .prepare(`
                DELETE FROM filing_jobs
                WHERE case_draft_id IN (SELECT id FROM case_drafts WHERE email_id = ?)
            `)
            .run(emailId);
        const documentRecords = this.db
            .prepare('DELETE FROM document_records WHERE email_id = ?')
            .run(emailId);
        const caseDrafts = this.db
            .prepare('DELETE FROM case_drafts WHERE email_id = ?')
            .run(emailId);
        const emailRecords = this.db
            .prepare('DELETE FROM email_records WHERE id = ?')
            .run(emailId);

        return {
            emailRecords: Number(emailRecords.changes ?? 0),
            caseDrafts: Number(caseDrafts.changes ?? 0),
            documentRecords: Number(documentRecords.changes ?? 0),
            filingJobs: Number(filingJobs.changes ?? 0),
            auditLogs: Number(auditLogs.changes ?? 0),
            oneDriveFilesDeleted: 0,
        };
    }

    private compactDatabase(): void {
        try {
            this.db.exec('PRAGMA optimize');
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            this.db.exec('VACUUM');
        } catch (error) {
            console.warn('Database records were deleted, but SQLite compaction failed:', error);
        }
    }

    private countSinceToday(tableName: string, extraWhere?: string): number {
        const extra = extraWhere ? ` AND (${extraWhere})` : '';
        const row = this.db
            .prepare(`
                SELECT COUNT(*) AS count
                FROM ${tableName}
                WHERE created_at >= date('now')
                ${extra}
            `)
            .get() as { count: number };

        return Number(row.count ?? 0);
    }

    private getPlaintiffMapping(id: string): PlaintiffMappingView {
        const row = this.db
            .prepare(`
                SELECT
                    id,
                    full_name,
                    short_name,
                    is_active,
                    usage_count,
                    last_used_at,
                    created_at,
                    updated_at
                FROM plaintiff_mappings
                WHERE id = ?
            `)
            .get(id) as any | undefined;

        if (!row) {
            throw new Error('Plaintiff mapping not found');
        }

        const usage = this.getDraftPlaintiffUsage().get(row.full_name);
        const status: PlaintiffMappingView['status'] = !row.short_name
            ? 'needs_short_name'
            : Number(row.is_active) === 1
                ? 'active'
                : 'inactive';

        return {
            id: row.id,
            fullName: row.full_name,
            shortName: row.short_name ?? '',
            isActive: Number(row.is_active) === 1,
            status,
            usageCount: usage?.usageCount ?? Number(row.usage_count ?? 0),
            lastUsedAt: usage?.lastUsedAt ?? row.last_used_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    private getDraftPlaintiffUsage(): Map<string, { usageCount: number; lastUsedAt: string | null }> {
        const rows = this.db
            .prepare(`
                SELECT
                    c.normalized_data_json,
                    COALESCE(e.received_at, c.updated_at) AS used_at
                FROM case_drafts c
                JOIN email_records e ON e.id = c.email_id
                WHERE c.normalized_data_json IS NOT NULL
            `)
            .all() as Array<{ normalized_data_json: string | null; used_at: string | null }>;

        const usage = new Map<string, { usageCount: number; lastUsedAt: string | null }>();
        for (const row of rows) {
            const plaintiff = extractPlaintiffName(this.safeJson(row.normalized_data_json));
            if (!plaintiff) continue;

            const existing = usage.get(plaintiff) ?? { usageCount: 0, lastUsedAt: null };
            existing.usageCount += 1;
            if (row.used_at && (!existing.lastUsedAt || row.used_at > existing.lastUsedAt)) {
                existing.lastUsedAt = row.used_at;
            }
            usage.set(plaintiff, existing);
        }

        return usage;
    }

    private getPlaintiffMappingStatus(fullName: string | null): PlaintiffMappingStatusView {
        const normalized = normalizeName(fullName);
        if (!normalized) {
            return {
                fullName: null,
                mappingId: null,
                shortName: null,
                isActive: false,
                status: 'unknown',
            };
        }

        const row = this.db
            .prepare(`
                SELECT id, short_name, is_active
                FROM plaintiff_mappings
                WHERE full_name = ? COLLATE NOCASE
                ORDER BY is_active DESC, updated_at DESC
                LIMIT 1
            `)
            .get(normalized) as any | undefined;

        if (!row) {
            return {
                fullName: normalized,
                mappingId: null,
                shortName: null,
                isActive: false,
                status: 'missing',
            };
        }

        if (!normalizeName(row.short_name)) {
            return {
                fullName: normalized,
                mappingId: row.id,
                shortName: null,
                isActive: false,
                status: 'needs_short_name',
            };
        }

        const isActive = Number(row.is_active) === 1;
        return {
            fullName: normalized,
            mappingId: row.id,
            shortName: row.short_name,
            isActive,
            status: isActive ? 'mapped' : 'inactive',
        };
    }

    private countMissingPlaintiffMappings(): number {
        return this.listPlaintiffMappings().missing.length;
    }

    private safeJson(value: string | null | undefined): any {
        if (!value) return null;
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }

    private ensureExpectedDocuments(
        emailId: string,
        caseDraftId: string,
        parsed: ParsedEmailInfo,
    ): void {
        const expectedDocuments = parsed.filedDocuments ?? [];
        if (!expectedDocuments.length) return;

        const existing = this.db
            .prepare(`
                SELECT
                    SUM(CASE WHEN status IN ('pending', 'not_downloadable') AND upload_source = 'parsed_email' THEN 1 ELSE 0 END) AS pending_count,
                    SUM(CASE WHEN status IN ('uploaded', 'failed', 'not_downloadable') OR one_drive_url IS NOT NULL THEN 1 ELSE 0 END) AS result_count
                FROM document_records
                WHERE case_draft_id = ?
            `)
            .get(caseDraftId) as { pending_count: number | null; result_count: number | null };

        if (Number(existing.result_count ?? 0) > 0) {
            return;
        }

        if (Number(existing.pending_count ?? 0) === expectedDocuments.length) {
            return;
        }

        const timestamp = nowIso();
        const replaceExpected = () => {
            this.clearPendingDocuments(caseDraftId);

            const insert = this.db.prepare(`
                INSERT INTO document_records (
                    id,
                    email_id,
                    case_draft_id,
                    original_filename,
                    current_filename,
                    file_url,
                    source_url,
                    one_drive_url,
                    storage_path,
                    mime_type,
                    file_size,
                    document_type,
                    upload_source,
                    status,
                    error_message,
                    metadata_json,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 'application/pdf', NULL, ?, 'parsed_email', ?, ?, ?, ?, ?)
            `);

            for (const doc of expectedDocuments) {
                const status: DocumentStatus = doc.downloadUrl ? 'pending' : 'not_downloadable';
                const errorMessage = doc.downloadUrl ? null : 'No downloadable file in source email';

                insert.run(
                    randomUUID(),
                    emailId,
                    caseDraftId,
                    doc.documentName ?? null,
                    doc.downloadUrl ?? null,
                    doc.documentType ?? null,
                    status,
                    errorMessage,
                    toJson({
                        documentName: doc.documentName ?? null,
                        documentType: doc.documentType ?? null,
                        status: doc.status ?? null,
                        comments: doc.comments ?? null,
                        downloadUrl: doc.downloadUrl ?? null,
                    }),
                    timestamp,
                    timestamp,
                );
            }
        };

        this.runInTransaction(replaceExpected);
        this.insertAuditLog('case_draft', caseDraftId, 'expected_documents_synced', {
            count: expectedDocuments.length,
        });
    }

    private insertAuditLog(
        entityType: string,
        entityId: string,
        action: string,
        metadata?: unknown,
        oldValue?: unknown,
        newValue?: unknown,
    ): void {
        this.db
            .prepare(`
                INSERT INTO audit_logs (
                    id,
                    entity_type,
                    entity_id,
                    action,
                    actor_type,
                    old_value_json,
                    new_value_json,
                    metadata_json,
                    created_at
                )
                VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)
            `)
            .run(
                randomUUID(),
                entityType,
                entityId,
                action,
                toJson(oldValue),
                toJson(newValue),
                toJson(metadata),
                nowIso(),
            );
    }
}

export function getWorkflowDatabase(): WorkflowDatabase {
    if (!sharedDatabase) {
        sharedDatabase = new WorkflowDatabase();
    }
    return sharedDatabase;
}
