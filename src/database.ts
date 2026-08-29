import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ParsedEmailInfo } from './emailProcessor';
import {
    ComplaintExtractionResult,
    isComplaintDocument,
} from './complaintExtractor';

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
    | 'filing_prepared'
    | 'filed_successfully'
    | 'filing_failed'
    | 'rejected'
    | 'archived';

export type ValidationStatus = 'unknown' | 'passed' | 'warnings' | 'failed';
export type FilingStatus =
    | 'not_started'
    | 'queued'
    | 'running'
    | 'prepared'
    | 'succeeded'
    | 'failed';
export type FilingJobMode = 'prepare' | 'submit';
export type FilingJobStatus =
    | 'queued'
    | 'running'
    | 'prepared'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
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

export interface DraftListOptions {
    page?: number;
    pageSize?: number;
    status?: CaseDraftStatus | '';
    validationStatus?: ValidationStatus | '';
    search?: string;
    dateFrom?: string | null;
    dateTo?: string | null;
}

export interface DraftListItem {
    draftId: string;
    emailId: string;
    subject: string | null;
    sender: string | null;
    receivedAt: string | null;
    caseNumber: string | null;
    caseTitle: string | null;
    plaintiff: string | null;
    defendant: string | null;
    status: CaseDraftStatus;
    validationStatus: ValidationStatus;
    filingStatus: FilingStatus;
    documentCount: number;
    viewableDocumentCount: number;
    failedDocumentCount: number;
    updatedAt: string;
}

export interface DraftPage {
    items: DraftListItem[];
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
}

export interface DraftValidationIssue {
    field: string;
    severity: 'error' | 'warning';
    message: string;
}

export type DraftFieldSource = 'email' | 'complaint' | 'manual' | 'derived' | 'empty';
export type DraftFilingFieldSource =
    | 'complaint'
    | 'manual'
    | 'email'
    | 'default'
    | 'empty';

export type DraftDocumentRole = 'primary_source' | 'supporting' | 'fee' | 'unknown';
export type FilingPackageRole =
    | 'complaint'
    | 'advice'
    | 'local'
    | 'request'
    | 'summons'
    | 'ancillary'
    | 'fee'
    | 'unknown';
export type DraftFilingRelation = 'separate' | 'connected_to_complaint' | 'unknown';

export type DraftPartyType = 'person' | 'entity';
export type RelatedCivilAction = 'none' | 'previously_filed' | 'unknown';

export interface DraftParty {
    id: string;
    partyType: DraftPartyType;
    displayName: string | null;
    entityName: string | null;
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
    suffix: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    phone: string | null;
    email: string | null;
}

export interface DraftAttorney {
    name: string | null;
    barNumber: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    phone: string | null;
    email: string | null;
}

export interface DraftFilingData {
    courtDistrict: string | null;
    action: string | null;
    caseType: string | null;
    relatedCivilAction: RelatedCivilAction;
    relatedCaseCourt: string | null;
    relatedCaseDocketNumber: string | null;
    relatedCaseJudge: string | null;
    relatedCasePending: boolean | null;
    moneyJudgmentRequested: boolean | null;
    claimAmount: string | null;
    mailingRequested: boolean;
    includeAllOtherOccupants: boolean;
    plaintiff: DraftParty;
    defendants: DraftParty[];
    attorney: DraftAttorney;
}

export interface DraftDocumentFilingUpdate {
    id: string;
    filingName?: unknown;
    filingType?: unknown;
    filingRelation?: unknown;
    filingSequence?: unknown;
    requiredForFiling?: unknown;
}

export interface DraftDocumentAccess {
    id: string;
    caseDraftId: string | null;
    oneDriveUrl: string;
    currentFilename: string | null;
    mimeType: string | null;
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
    filingName: string | null;
    filingType: string | null;
    filingTypeSource: 'suggested' | 'complaint' | 'manual' | null;
    filingRelation: DraftFilingRelation;
    filingRelationSource: 'suggested' | 'manual' | null;
    filingSequence: number | null;
    suggestedFilingSequence: number | null;
    requiredForFiling: boolean;
    isPrimary: boolean;
    documentRole: DraftDocumentRole;
    packageRole: FilingPackageRole;
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

export interface ActivityLogItem extends AuditLogView {
    emailId: string | null;
    subject: string | null;
    sender: string | null;
    oldValueJson: string | null;
    newValueJson: string | null;
}

export interface ActivityListOptions {
    page?: number;
    pageSize?: number;
    entityType?: string;
    search?: string;
    dateFrom?: string | null;
    dateTo?: string | null;
}

export interface ActivityPage {
    items: ActivityLogItem[];
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
}

export interface QueuedEmailRetry {
    emailId: string;
    externalMessageId: string;
    subject: string | null;
    sender: string | null;
    receivedAt: string | null;
}

export interface FilingDocumentPayload {
    id: string;
    filename: string;
    filingName: string;
    filingType: string;
    filingRelation: DraftFilingRelation;
    packageRole: FilingPackageRole;
    oneDriveUrl: string;
    mimeType: string | null;
    fileSize: number | null;
    isPrimary: boolean;
}

export interface FilingPayload {
    version: 1;
    caseDraftId: string;
    emailId: string;
    subject: string | null;
    courtName: string;
    action: 'Initiate a new case';
    caseType: 'LT - Landlord-Tenant Summary Proceedings';
    filingData: DraftFilingData;
    documents: FilingDocumentPayload[];
    createdAt: string;
}

export interface FilingJobLogEntry {
    at: string;
    level: 'info' | 'warning' | 'error';
    checkpoint: string;
    message: string;
    details?: Record<string, unknown>;
}

export interface FilingJobView {
    id: string;
    caseDraftId: string;
    emailId: string | null;
    subject: string | null;
    attemptNumber: number;
    mode: FilingJobMode;
    status: FilingJobStatus;
    triggerSource: string | null;
    checkpoint: string | null;
    externalBundleId: string | null;
    temporaryCaseNumber: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    executionLog: FilingJobLogEntry[];
    payload: FilingPayload | null;
    result: Record<string, unknown> | null;
    debugArtifactPath: string | null;
    triggeredBy: string | null;
    createdAt: string;
    updatedAt: string;
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
        primaryDocumentId: string | null;
        editableData: Record<string, string | null>;
        filingData: DraftFilingData;
        fieldSources: Record<string, DraftFieldSource>;
        filingFieldSources: Record<string, DraftFilingFieldSource>;
        complaintExtraction: (ComplaintExtractionResult & {
            documentId: string;
            extractedAt: string;
            appliedFields: string[];
        }) | null;
        validationIssues: DraftValidationIssue[];
        filingEligible: boolean;
        filingEligibilityIssues: DraftValidationIssue[];
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
    subject: string | null;
    sender: string | null;
    receivedAt: string | null;
    parsedEmail: ParsedEmailInfo | null;
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

const EDITABLE_DRAFT_FIELDS = [
    'courtName',
    'caseNumber',
    'caseTitle',
    'plaintiff',
    'defendant',
    'bundleNumber',
    'filerName',
    'submitterName',
    'temporaryCaseNumber',
    'newCaseNumber',
    'filedAt',
] as const;

type EditableDraftField = typeof EDITABLE_DRAFT_FIELDS[number];

function editableDraftValue(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const normalized = String(value).replace(/\s+/g, ' ').trim();
    return normalized || null;
}

function boundedDraftValue(value: unknown, field: string, limit = 1000): string | null {
    const normalized = editableDraftValue(value);
    if (normalized && normalized.length > limit) {
        throw new Error(`${field} must be ${limit} characters or fewer`);
    }
    return normalized;
}

function partiesFromCaseTitle(caseTitle: unknown): {
    plaintiff: string | null;
    defendant: string | null;
} {
    const normalized = editableDraftValue(caseTitle);
    if (!normalized) return { plaintiff: null, defendant: null };
    const match = normalized.match(/^(.+?)\s+v(?:\.|s\.?)?\s+(.+)$/i);
    return {
        plaintiff: editableDraftValue(match?.[1]),
        defendant: editableDraftValue(match?.[2]),
    };
}

function inferCourtDistrict(courtName: unknown): string | null {
    const normalized = editableDraftValue(courtName);
    if (!normalized) return null;
    const match = normalized.match(/\b(\d{1,3}[A-Z]?)(?:st|nd|rd|th)?\s+District\b/i);
    return match?.[1] ?? null;
}

function inferCaseType(data: Record<string, unknown>): string | null {
    const explicit = editableDraftValue(data.caseType);
    if (explicit) return explicit;
    const caseNumber = editableDraftValue(
        data.newCaseNumber ?? data.caseNumber ?? data.temporaryCaseNumber,
    );
    if (caseNumber && /(?:^|[-\s])LT(?:$|[-\s])/i.test(caseNumber)) {
        return 'LT - Landlord-Tenant Summary Proceedings';
    }
    return null;
}

function draftPartyName(party: DraftParty): string | null {
    if (party.partyType === 'entity') {
        return party.entityName || party.displayName;
    }
    const personName = [party.firstName, party.middleName, party.lastName, party.suffix]
        .filter(Boolean)
        .join(' ');
    return editableDraftValue(personName) || party.displayName;
}

function emptyDraftParty(id: string, partyType: DraftPartyType): DraftParty {
    return {
        id,
        partyType,
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
    };
}

function sanitizeDraftParty(
    input: unknown,
    fallbackId: string,
    fallbackType: DraftPartyType,
): DraftParty {
    const source = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    const partyType: DraftPartyType = source.partyType === 'person' || source.partyType === 'entity'
        ? source.partyType
        : fallbackType;
    return {
        id: boundedDraftValue(source.id, 'party.id', 100) || fallbackId,
        partyType,
        displayName: boundedDraftValue(source.displayName, 'party.displayName', 300),
        entityName: boundedDraftValue(source.entityName, 'party.entityName', 300),
        firstName: boundedDraftValue(source.firstName, 'party.firstName', 150),
        middleName: boundedDraftValue(source.middleName, 'party.middleName', 150),
        lastName: boundedDraftValue(source.lastName, 'party.lastName', 150),
        suffix: boundedDraftValue(source.suffix, 'party.suffix', 50),
        address1: boundedDraftValue(source.address1, 'party.address1', 300),
        address2: boundedDraftValue(source.address2, 'party.address2', 150),
        city: boundedDraftValue(source.city, 'party.city', 150),
        state: boundedDraftValue(source.state, 'party.state', 50),
        postalCode: boundedDraftValue(source.postalCode, 'party.postalCode', 30),
        phone: boundedDraftValue(source.phone, 'party.phone', 50),
        email: boundedDraftValue(source.email, 'party.email', 254),
    };
}

function sanitizeDraftAttorney(input: unknown, fallbackName: unknown): DraftAttorney {
    const source = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    return {
        name: boundedDraftValue(source.name ?? fallbackName, 'attorney.name', 300),
        barNumber: boundedDraftValue(source.barNumber, 'attorney.barNumber', 80),
        address1: boundedDraftValue(source.address1, 'attorney.address1', 300),
        address2: boundedDraftValue(source.address2, 'attorney.address2', 150),
        city: boundedDraftValue(source.city, 'attorney.city', 150),
        state: boundedDraftValue(source.state, 'attorney.state', 50),
        postalCode: boundedDraftValue(source.postalCode, 'attorney.postalCode', 30),
        phone: boundedDraftValue(source.phone, 'attorney.phone', 50),
        email: boundedDraftValue(source.email, 'attorney.email', 254),
    };
}

function draftFilingData(data: unknown): DraftFilingData {
    const root = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
    const source = root.filingData && typeof root.filingData === 'object' &&
        !Array.isArray(root.filingData)
        ? root.filingData as Record<string, unknown>
        : {};
    const titleParties = partiesFromCaseTitle(root.caseTitle);
    const plaintiffName = editableDraftValue(root.plaintiff) || titleParties.plaintiff;
    const defendantName = editableDraftValue(root.defendant) || titleParties.defendant;
    const plaintiffInput = source.plaintiff && typeof source.plaintiff === 'object'
        ? source.plaintiff
        : {
            partyType: 'entity',
            entityName: plaintiffName,
            displayName: plaintiffName,
        };
    const rawDefendants = Array.isArray(source.defendants)
        ? source.defendants
        : defendantName
            ? [{
                partyType: 'person',
                displayName: defendantName,
            }]
            : [];
    const relatedCivilAction: RelatedCivilAction =
        source.relatedCivilAction === 'none' ||
        source.relatedCivilAction === 'previously_filed'
            ? source.relatedCivilAction
            : 'unknown';
    const relatedCasePending = typeof source.relatedCasePending === 'boolean'
        ? source.relatedCasePending
        : null;
    const moneyJudgmentRequested = typeof source.moneyJudgmentRequested === 'boolean'
        ? source.moneyJudgmentRequested
        : source.claimAmount !== undefined && source.claimAmount !== null
            ? Number(String(source.claimAmount).replace(/[$,\s]/g, '')) > 0
            : null;
    const claimAmount = moneyJudgmentRequested === false
        ? '0.00'
        : boundedDraftValue(source.claimAmount, 'claimAmount', 50);
    if (claimAmount && !/^\d+(?:\.\d{1,2})?$/.test(claimAmount.replace(/[$,\s]/g, ''))) {
        throw new Error('Claim amount must be a valid non-negative amount');
    }

    return {
        courtDistrict: boundedDraftValue(
            source.courtDistrict ?? inferCourtDistrict(root.courtName),
            'courtDistrict',
            20,
        ),
        action: boundedDraftValue(
            source.action ?? 'Initiate a new case',
            'action',
            150,
        ),
        caseType: boundedDraftValue(
            source.caseType ?? inferCaseType(root),
            'caseType',
            250,
        ),
        relatedCivilAction,
        relatedCaseCourt: boundedDraftValue(source.relatedCaseCourt, 'relatedCaseCourt', 300),
        relatedCaseDocketNumber: boundedDraftValue(
            source.relatedCaseDocketNumber,
            'relatedCaseDocketNumber',
            150,
        ),
        relatedCaseJudge: boundedDraftValue(source.relatedCaseJudge, 'relatedCaseJudge', 200),
        relatedCasePending,
        moneyJudgmentRequested,
        claimAmount: claimAmount ? claimAmount.replace(/[$,\s]/g, '') : null,
        mailingRequested: typeof source.mailingRequested === 'boolean'
            ? source.mailingRequested
            : true,
        includeAllOtherOccupants: source.includeAllOtherOccupants === true,
        plaintiff: sanitizeDraftParty(plaintiffInput, 'plaintiff-1', 'entity'),
        defendants: rawDefendants
            .slice(0, 50)
            .map((party, index) =>
                sanitizeDraftParty(party, `defendant-${index + 1}`, 'person')),
        attorney: sanitizeDraftAttorney(source.attorney, root.filerName ?? root.submitterName),
    };
}

const DRAFT_FILING_DATA_KEYS = [
    'courtDistrict',
    'action',
    'caseType',
    'relatedCivilAction',
    'relatedCaseCourt',
    'relatedCaseDocketNumber',
    'relatedCaseJudge',
    'relatedCasePending',
    'moneyJudgmentRequested',
    'claimAmount',
    'mailingRequested',
    'includeAllOtherOccupants',
    'plaintiff',
    'defendants',
    'attorney',
] as const;

type DraftFilingDataKey = typeof DRAFT_FILING_DATA_KEYS[number];

type StoredComplaintExtraction = ComplaintExtractionResult & {
    documentId: string;
    extractedAt: string;
    appliedFields: string[];
};

function jsonValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function complaintExtractionFromDraft(data: unknown): StoredComplaintExtraction | null {
    const root = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
    const extraction = root.complaintExtraction;
    if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) return null;
    const source = extraction as Record<string, unknown>;
    if (
        typeof source.documentId !== 'string' ||
        typeof source.extractedAt !== 'string' ||
        (source.extractorVersion !== 1 && source.extractorVersion !== 2) ||
        !source.data ||
        typeof source.data !== 'object'
    ) {
        return null;
    }
    return source as unknown as StoredComplaintExtraction;
}

function storedManualFilingFields(data: unknown): Set<DraftFilingDataKey> {
    const root = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
    const values = Array.isArray(root.manualFilingFields) ? root.manualFilingFields : [];
    const allowed = new Set<string>(DRAFT_FILING_DATA_KEYS);
    return new Set(values.filter((value): value is DraftFilingDataKey =>
        typeof value === 'string' && allowed.has(value)));
}

function inferredManualFilingFields(
    extractedData: unknown,
    normalizedData: unknown,
): Set<DraftFilingDataKey> {
    const stored = storedManualFilingFields(normalizedData);
    if (stored.size || complaintExtractionFromDraft(normalizedData)) return stored;

    const extracted = draftFilingData(extractedData);
    const normalized = draftFilingData(normalizedData);
    for (const key of DRAFT_FILING_DATA_KEYS) {
        if (!jsonValuesEqual(extracted[key], normalized[key])) stored.add(key);
    }
    return stored;
}

function draftFilingFieldSources(
    extractedData: unknown,
    normalizedData: unknown,
): Record<DraftFilingDataKey, DraftFilingFieldSource> {
    const filing = draftFilingData(normalizedData);
    const manualFields = inferredManualFilingFields(extractedData, normalizedData);
    const complaintFields = new Set(
        complaintExtractionFromDraft(normalizedData)?.appliedFields ?? [],
    );
    const result = {} as Record<DraftFilingDataKey, DraftFilingFieldSource>;
    const defaultFields = new Set<DraftFilingDataKey>([
        'action',
        'caseType',
        'mailingRequested',
        'includeAllOtherOccupants',
    ]);

    for (const key of DRAFT_FILING_DATA_KEYS) {
        const value = filing[key];
        const empty = value === null || value === undefined || value === '' ||
            (Array.isArray(value) && value.length === 0);
        result[key] = manualFields.has(key)
            ? 'manual'
            : complaintFields.has(key)
                ? 'complaint'
                : empty
                    ? 'empty'
                    : defaultFields.has(key)
                        ? 'default'
                        : 'email';
    }
    return result;
}

function draftEditableData(data: unknown): Record<EditableDraftField, string | null> {
    const source = data && typeof data === 'object'
        ? data as Record<string, unknown>
        : {};
    const titleParties = partiesFromCaseTitle(source.caseTitle);
    const result = {} as Record<EditableDraftField, string | null>;
    for (const field of EDITABLE_DRAFT_FIELDS) {
        const direct = editableDraftValue(source[field]);
        result[field] = direct ??
            (field === 'plaintiff' ? titleParties.plaintiff : null) ??
            (field === 'defendant' ? titleParties.defendant : null);
    }
    return result;
}

function draftFieldSources(
    extracted: unknown,
    normalized: unknown,
): Record<EditableDraftField, DraftFieldSource> {
    const original = draftEditableData(extracted);
    const current = draftEditableData(normalized);
    const complaint = complaintExtractionFromDraft(normalized);
    const complaintValues: Partial<Record<EditableDraftField, string>> = {};
    if (complaint?.data.caseNumber) {
        complaintValues.caseNumber = complaint.data.caseNumber;
    }
    if (complaint?.data.plaintiff?.displayName) {
        complaintValues.plaintiff = complaint.data.plaintiff.displayName;
    }
    if (complaint?.data.defendants?.length) {
        complaintValues.defendant = complaint.data.defendants
            .map(party => party.displayName)
            .join(', ');
    }
    if (complaint?.data.attorney?.displayName) {
        complaintValues.filerName = complaint.data.attorney.displayName;
    }
    const normalizedObject = normalized && typeof normalized === 'object'
        ? normalized as Record<string, unknown>
        : {};
    const sources = {} as Record<EditableDraftField, DraftFieldSource>;

    for (const field of EDITABLE_DRAFT_FIELDS) {
        if (!current[field]) {
            sources[field] = 'empty';
        } else if (current[field] === complaintValues[field]) {
            sources[field] = 'complaint';
        } else if (
            (field === 'plaintiff' || field === 'defendant') &&
            !editableDraftValue(normalizedObject[field])
        ) {
            sources[field] = 'derived';
        } else if (current[field] !== original[field]) {
            sources[field] = 'manual';
        } else {
            sources[field] = 'email';
        }
    }
    return sources;
}

function validateDraftData(data: unknown): DraftValidationIssue[] {
    const values = draftEditableData(data);
    const filing = draftFilingData(data);
    const issues: DraftValidationIssue[] = [];
    if (!values.courtName) {
        issues.push({
            field: 'courtName',
            severity: 'error',
            message: 'Select the MiFILE court before preparing this filing.',
        });
    }
    if (!values.caseTitle) {
        issues.push({
            field: 'caseTitle',
            severity: 'warning',
            message: 'Case title was not extracted.',
        });
    }
    if (!values.plaintiff) {
        issues.push({
            field: 'plaintiff',
            severity: 'warning',
            message: 'Plaintiff was not extracted and could not be derived from the case title.',
        });
    }
    if (!values.defendant) {
        issues.push({
            field: 'defendant',
            severity: 'warning',
            message: 'Defendant was not extracted and could not be derived from the case title.',
        });
    }
    if (!filing.caseType) {
        issues.push({
            field: 'filingData.caseType',
            severity: 'warning',
            message: 'Select the MiFILE case type.',
        });
    }
    if (filing.relatedCivilAction === 'unknown') {
        issues.push({
            field: 'filingData.relatedCivilAction',
            severity: 'warning',
            message: 'Paragraph 2 could not be read; confirm whether a related civil action exists.',
        });
    }
    if (filing.relatedCivilAction === 'previously_filed') {
        const missingRelatedFields = [
            !filing.relatedCaseCourt ? 'court' : null,
            !filing.relatedCaseDocketNumber ? 'docket number' : null,
            filing.relatedCasePending === null ? 'status' : null,
        ].filter((value): value is string => Boolean(value));
        if (missingRelatedFields.length) {
            issues.push({
                field: 'filingData.relatedCivilAction',
                severity: 'warning',
                message: `Complete the prior civil action ${missingRelatedFields.join(', ')} from paragraph 2.`,
            });
        }
    }
    if (filing.moneyJudgmentRequested === null) {
        issues.push({
            field: 'filingData.moneyJudgmentRequested',
            severity: 'warning',
            message: 'Paragraph 10 could not be read; confirm whether a money judgment is requested.',
        });
    } else if (
        filing.moneyJudgmentRequested &&
        (!filing.claimAmount || Number(filing.claimAmount) <= 0)
    ) {
        issues.push({
            field: 'filingData.claimAmount',
            severity: 'error',
            message: 'A positive claim amount is required when paragraph 10 requests a money judgment.',
        });
    }
    if (!filing.mailingRequested) {
        issues.push({
            field: 'filingData.mailingRequested',
            severity: 'error',
            message: 'Court service by mail must be requested for the supported filing workflow.',
        });
    }
    if (!draftPartyName(filing.plaintiff)) {
        issues.push({
            field: 'filingData.plaintiff',
            severity: 'error',
            message: 'Complete the Plaintiff party information.',
        });
    }
    const missingPlaintiffAddress = [
        !filing.plaintiff.address1 ? 'street address' : null,
        !filing.plaintiff.city ? 'city' : null,
        !filing.plaintiff.state ? 'state' : null,
        !filing.plaintiff.postalCode ? 'ZIP code' : null,
    ].filter((value): value is string => Boolean(value));
    if (missingPlaintiffAddress.length) {
        issues.push({
            field: 'filingData.plaintiff',
            severity: 'error',
            message: `Complete Plaintiff ${missingPlaintiffAddress.join(', ')} from the Complaint.`,
        });
    }
    if (!filing.defendants.length) {
        issues.push({
            field: 'filingData.defendants',
            severity: 'error',
            message: 'Add at least one Defendant.',
        });
    }
    filing.defendants.forEach((party, index) => {
        if (!draftPartyName(party)) {
            issues.push({
                field: `filingData.defendants.${index}`,
                severity: 'error',
                message: `Complete the name for Defendant ${index + 1}.`,
            });
        }
        const missingAddress = [
            !party.address1 ? 'street address' : null,
            !party.city ? 'city' : null,
            !party.state ? 'state' : null,
            !party.postalCode ? 'ZIP code' : null,
        ].filter((value): value is string => Boolean(value));
        if (missingAddress.length) {
            issues.push({
                field: `filingData.defendants.${index}`,
                severity: 'error',
                message: `Complete Defendant ${index + 1} ${missingAddress.join(', ')} from the Complaint.`,
            });
        }
    });
    return issues;
}

export const MIFILE_FILING_TYPES = [
    'Advice of Rights and Information (Landlord-Tenant)',
    'Local Rental and Housing Information',
    'Complaint for Possession and Supplemental Money Judgment (Fee Varies)',
    'Complaint for Possession Only',
    'Other',
    'Request for Court Mailing and Record (Landlord-Tenant)',
    'Summons, Landlord-Tenant/Land Contract',
] as const;

function suggestMiFileFilingType(
    documentType: string | null | undefined,
    filename: string | null | undefined,
    moneyJudgmentRequested?: boolean | null,
): string | null {
    const value = `${documentType || ''} ${filename || ''}`.toLowerCase();
    if (!value.trim()) return null;
    if (value.includes('advice')) return MIFILE_FILING_TYPES[0];
    if (value.includes('local')) return MIFILE_FILING_TYPES[1];
    if (value.includes('complaint')) {
        if (moneyJudgmentRequested === true) return MIFILE_FILING_TYPES[2];
        if (moneyJudgmentRequested === false) return MIFILE_FILING_TYPES[3];
        if (value.includes('possession only')) return MIFILE_FILING_TYPES[3];
        return MIFILE_FILING_TYPES[2];
    }
    if (/\b(?:demand|notice|lease|deed|ancillary|other)\b/.test(value)) {
        return MIFILE_FILING_TYPES[4];
    }
    if (value.includes('request')) return MIFILE_FILING_TYPES[5];
    if (value.includes('summons')) return MIFILE_FILING_TYPES[6];
    if (value.includes('connected filing')) return MIFILE_FILING_TYPES[4];
    return null;
}

function suggestedDocumentSequence(
    _documentType: string | null | undefined,
    _filename: string | null | undefined,
): number | null {
    return null;
}

function filingPackageRole(
    documentType: string | null | undefined,
    filename: string | null | undefined,
): FilingPackageRole {
    const value = `${documentType || ''} ${filename || ''}`.toLowerCase();
    if (isComplaintDocument(documentType, filename)) return 'complaint';
    if (/\b(?:mailing|filing) fee\b/.test(value)) return 'fee';
    if (/\badvice\b/.test(value)) return 'advice';
    if (/\blocal\b/.test(value)) return 'local';
    if (/\brequest\b/.test(value)) return 'request';
    if (/\bsummons\b/.test(value)) return 'summons';
    if (/connected filing|\b(?:demand|notice|lease|deed|ancillary|other)\b/.test(value)) {
        return 'ancillary';
    }
    return 'unknown';
}

function suggestedFilingRelation(
    documentType: string | null | undefined,
    filename: string | null | undefined,
): DraftFilingRelation {
    const role = filingPackageRole(documentType, filename);
    const value = `${documentType || ''} ${filename || ''}`.toLowerCase();
    if (['complaint', 'advice', 'local', 'request', 'summons'].includes(role)) {
        return 'separate';
    }
    if (role === 'ancillary') {
        if (value.includes('connected filing')) return 'connected_to_complaint';
        if (/\bother\b/.test(value)) return 'separate';
    }
    return 'unknown';
}

function requiredForStandardPackage(
    documentType: string | null | undefined,
    filename: string | null | undefined,
): boolean {
    return filingPackageRole(documentType, filename) !== 'fee';
}

function draftDocumentRole(
    documentType: string | null | undefined,
    filename: string | null | undefined,
): DraftDocumentRole {
    const role = filingPackageRole(documentType, filename);
    if (role === 'complaint') return 'primary_source';
    if (role === 'fee') return 'fee';
    return role === 'unknown' ? 'unknown' : 'supporting';
}

function validatePrimaryComplaint(
    primaryDocumentId: string | null,
    documents: DocumentRecordView[],
    extraction: StoredComplaintExtraction | null,
    filing: DraftFilingData,
): DraftValidationIssue[] {
    const complaintDocuments = documents.filter(document =>
        isComplaintDocument(
            document.documentType,
            document.currentFilename || document.originalFilename,
        ));
    const primary = primaryDocumentId
        ? documents.find(document => document.id === primaryDocumentId) ?? null
        : null;
    const issues: DraftValidationIssue[] = [];

    if (!primary) {
        issues.push({
            field: 'primaryDocumentId',
            severity: 'error',
            message: complaintDocuments.length
                ? 'Select the Complaint as the primary data source.'
                : 'No Complaint document is available for this Draft.',
        });
        return issues;
    }

    if (!isComplaintDocument(
        primary.documentType,
        primary.currentFilename || primary.originalFilename,
    )) {
        issues.push({
            field: 'primaryDocumentId',
            severity: 'error',
            message: 'The selected primary source is not recognized as a Complaint.',
        });
    }
    if (!primary.oneDriveUrl || !['uploaded', 'downloaded', 'replaced'].includes(primary.status)) {
        issues.push({
            field: 'primaryDocumentId',
            severity: 'error',
            message: 'The primary Complaint is not yet available for field extraction.',
        });
    } else if (!extraction || extraction.documentId !== primary.id) {
        issues.push({
            field: 'complaintExtraction',
            severity: 'error',
            message: 'Complaint fields have not been extracted; automatic filing is blocked.',
        });
    }

    if (extraction?.documentId === primary.id) {
        if (extraction.extractorVersion < 2) {
            issues.push({
                field: 'complaintExtraction',
                severity: 'warning',
                message: 'Re-extract this Complaint to read paragraphs 2 and 10 with the current rules.',
            });
        }
        if (extraction.formType !== 'NONPAYMENT OF RENT') {
            issues.push({
                field: 'complaintExtraction.formType',
                severity: 'error',
                message: 'Automatic filing is currently limited to first-hearing nonpayment Complaints.',
            });
        }
        for (const warning of extraction.warnings) {
            if (
                (warning.code === 'related_action_review' && filing.relatedCivilAction !== 'unknown') ||
                (warning.code === 'claim_amount_review' &&
                    filing.moneyJudgmentRequested !== null &&
                    (!filing.moneyJudgmentRequested || Boolean(filing.claimAmount))) ||
                (warning.code === 'multiple_defendants_review' && filing.defendants.length > 1) ||
                (warning.code === 'missing_plaintiff' && Boolean(draftPartyName(filing.plaintiff))) ||
                (warning.code === 'missing_defendant' && filing.defendants.length > 0)
            ) {
                continue;
            }
            issues.push({
                field: `complaintExtraction.${warning.code}`,
                severity: warning.code === 'unsupported_form' ||
                    warning.code === 'missing_filled_section'
                    ? 'error'
                    : 'warning',
                message: warning.message,
            });
        }
    }
    return issues;
}

function validateNewCaseSource(
    data: unknown,
    subject: string | null | undefined,
    sender: string | null | undefined,
): DraftValidationIssue[] {
    const root = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
    const normalizedSubject = String(subject || '').toLowerCase();
    const normalizedSender = String(sender || '').toLowerCase();
    const isFiledNotification =
        root.isMiFile === true ||
        Boolean(editableDraftValue(root.bundleNumber)) ||
        Boolean(editableDraftValue(root.filedAt)) ||
        /mifile\s*-\s*document filed|filing (?:accepted|submitted)|processed:/.test(
            normalizedSubject,
        ) ||
        (
            normalizedSender.includes('truefiling.com') &&
            /document filed|filing accepted|filing submitted/.test(normalizedSubject)
        );
    if (!isFiledNotification) return [];
    return [{
        field: 'filingEligibility',
        severity: 'error',
        message: 'This email records an existing court filing and cannot be submitted as a new case.',
    }];
}

function validateDraftDocuments(
    documents: DocumentRecordView[],
    filing: DraftFilingData,
): DraftValidationIssue[] {
    const issues: DraftValidationIssue[] = [];
    const coreRoles: Array<{ role: FilingPackageRole; label: string }> = [
        { role: 'complaint', label: 'Complaint' },
        { role: 'advice', label: 'Advice' },
        { role: 'local', label: 'court-specific Local form' },
        { role: 'request', label: 'Request' },
        { role: 'summons', label: 'Summons' },
    ];
    for (const { role, label } of coreRoles) {
        const matching = documents.filter(document => document.packageRole === role);
        if (!matching.length) {
            issues.push({
                field: `package.${role}`,
                severity: 'error',
                message: `The standard nonpayment package is missing ${label}.`,
            });
            continue;
        }
        if (matching.length > 1) {
            issues.push({
                field: `package.${role}`,
                severity: 'error',
                message: `The standard nonpayment package contains ${matching.length} ${label} documents; exactly one is required.`,
            });
        }
        if (matching.some(document => !document.requiredForFiling)) {
            issues.push({
                field: `package.${role}`,
                severity: 'error',
                message: `${label} cannot be excluded from the standard nonpayment package.`,
            });
        }
    }

    const includedAncillary = documents.filter(document =>
        document.packageRole === 'ancillary' && document.requiredForFiling);
    if (!includedAncillary.length) {
        issues.push({
            field: 'package.ancillary',
            severity: 'error',
            message: 'Attach at least one demand, notice, lease, deed, or other ancillary document.',
        });
    }

    for (const document of documents) {
        if (document.packageRole === 'fee' || !document.requiredForFiling) continue;
        if (document.packageRole === 'unknown') {
            issues.push({
                field: `document.${document.id}`,
                severity: 'error',
                message: `${document.currentFilename || document.documentType || 'Additional document'} is not recognized; classify or exclude it before filing.`,
            });
            continue;
        }
        if (document.status === 'not_downloadable') {
            issues.push({
                field: `document.${document.id}`,
                severity: 'error',
                message: `${document.currentFilename || document.documentType || 'Document'} has no downloadable PDF.`,
            });
            continue;
        }
        if (['failed', 'invalid'].includes(document.status)) {
            issues.push({
                field: `document.${document.id}`,
                severity: 'error',
                message: `${document.currentFilename || document.documentType || 'Document'} is not ready.`,
            });
            continue;
        }
        if (['pending', 'retry_queued', 'retrying'].includes(document.status)) {
            issues.push({
                field: `document.${document.id}`,
                severity: 'error',
                message: `${document.currentFilename || document.documentType || 'Document'} is still processing.`,
            });
        }
        const expectedFilingType = document.packageRole === 'complaint'
            ? suggestMiFileFilingType(
                document.documentType,
                document.currentFilename || document.originalFilename,
                filing.moneyJudgmentRequested,
            )
            : suggestMiFileFilingType(
                document.documentType,
                document.currentFilename || document.originalFilename,
            );
        if (!document.filingType || document.filingType !== expectedFilingType) {
            issues.push({
                field: `document.${document.id}`,
                severity: 'error',
                message: `Set the MiFILE Filing Type to "${expectedFilingType || 'Other'}" for ${
                    document.currentFilename || document.documentType || 'the document'
                }.`,
            });
        }
        if (
            document.packageRole !== 'ancillary' &&
            document.filingRelation !== 'separate'
        ) {
            issues.push({
                field: `document.${document.id}`,
                severity: 'error',
                message: `${document.documentType || 'This document'} must be a separate filing.`,
            });
        }
        if (
            document.packageRole === 'ancillary' &&
            document.filingRelation === 'unknown'
        ) {
            issues.push({
                field: `document.${document.id}`,
                severity: 'warning',
                message: `Choose whether ${document.currentFilename || document.documentType || 'the ancillary document'} is filed as Other or connected to the Complaint.`,
            });
        }
    }
    return issues;
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
    {
        version: 10,
        name: 'add_mifile_document_metadata',
        up: db => {
            const columns = db
                .prepare('PRAGMA table_info(document_records)')
                .all() as Array<{ name: string }>;
            const names = new Set(columns.map(column => column.name));

            if (!names.has('filing_name')) {
                db.exec('ALTER TABLE document_records ADD COLUMN filing_name TEXT');
            }
            if (!names.has('filing_type')) {
                db.exec('ALTER TABLE document_records ADD COLUMN filing_type TEXT');
            }
            if (!names.has('filing_type_source')) {
                db.exec('ALTER TABLE document_records ADD COLUMN filing_type_source TEXT');
            }
            if (!names.has('filing_sequence')) {
                db.exec('ALTER TABLE document_records ADD COLUMN filing_sequence INTEGER');
            }
            if (!names.has('required_for_filing')) {
                db.exec(
                    'ALTER TABLE document_records ADD COLUMN required_for_filing INTEGER NOT NULL DEFAULT 0',
                );
            }

            db.exec(`
                UPDATE document_records
                SET required_for_filing = 0
                WHERE upload_source IN (
                    'parsed_email',
                    'processing_report',
                    'mifile_download',
                    'document_retry',
                    'retry'
                )
                   OR status = 'not_downloadable';

                CREATE INDEX IF NOT EXISTS idx_documents_filing_sequence
                    ON document_records(case_draft_id, filing_sequence, created_at);
            `);
        },
    },
    {
        version: 11,
        name: 'requeue_documents_after_source_independent_retry_fix',
        up: db => {
            const timestamp = nowIso();
            db.prepare(`
                UPDATE document_records
                SET status = 'retry_queued',
                    automatic_retry_count = 0,
                    next_retry_at = ?,
                    updated_at = ?
                WHERE status = 'failed'
                  AND one_drive_url IS NULL
                  AND source_url IS NOT NULL
                  AND source_url != ''
            `).run(timestamp, timestamp);
        },
    },
    {
        version: 12,
        name: 'requeue_mifile_documents_for_history_download_fallback',
        up: db => {
            const timestamp = nowIso();
            db.prepare(`
                UPDATE document_records
                SET status = 'retry_queued',
                    automatic_retry_count = 0,
                    next_retry_at = ?,
                    updated_at = ?
                WHERE status = 'failed'
                  AND one_drive_url IS NULL
                  AND source_url LIKE '%mifile.courts.michigan.gov%'
            `).run(timestamp, timestamp);
        },
    },
    {
        version: 13,
        name: 'ignore_non_court_backlog_recovery_failures',
        up: db => {
            const timestamp = nowIso();
            db.prepare(`
                UPDATE email_records
                SET processing_status = 'ignored',
                    processing_error = 'Non-court email excluded from worker backlog',
                    processed_at = COALESCE(processed_at, ?),
                    updated_at = ?
                WHERE processing_status = 'failed'
                  AND processing_error LIKE 'Unable to fetch the source email for queued processing:%'
                  AND LOWER(COALESCE(sender, '')) NOT LIKE '%@truefiling.com'
                  AND LOWER(COALESCE(subject, '')) NOT LIKE '%mifile%'
                  AND LOWER(COALESCE(subject, '')) NOT LIKE '%truefiling%'
                  AND NOT EXISTS (
                      SELECT 1 FROM case_drafts c WHERE c.email_id = email_records.id
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM document_records d WHERE d.email_id = email_records.id
                  )
            `).run(timestamp, timestamp);
        },
    },
    {
        version: 14,
        name: 'assign_existing_complaints_as_primary_draft_sources',
        up: db => {
            const timestamp = nowIso();
            db.prepare(`
                UPDATE case_drafts
                SET primary_document_id = (
                        SELECT d.id
                        FROM document_records d
                        WHERE d.case_draft_id = case_drafts.id
                          AND d.is_active = 1
                          AND LOWER(
                              COALESCE(d.document_type, '') || ' ' ||
                              COALESCE(d.current_filename, '') || ' ' ||
                              COALESCE(d.original_filename, '')
                          ) LIKE '%complaint%'
                          AND LOWER(
                              COALESCE(d.document_type, '') || ' ' ||
                              COALESCE(d.current_filename, '') || ' ' ||
                              COALESCE(d.original_filename, '')
                          ) NOT LIKE '%supplemental complaint attachment%'
                        ORDER BY
                            CASE
                                WHEN d.one_drive_url IS NOT NULL OR d.status = 'uploaded' THEN 0
                                ELSE 1
                            END,
                            d.created_at DESC
                        LIMIT 1
                    ),
                    updated_at = ?
                WHERE primary_document_id IS NULL
                  AND EXISTS (
                      SELECT 1
                      FROM document_records d
                      WHERE d.case_draft_id = case_drafts.id
                        AND d.is_active = 1
                        AND LOWER(
                            COALESCE(d.document_type, '') || ' ' ||
                            COALESCE(d.current_filename, '') || ' ' ||
                            COALESCE(d.original_filename, '')
                        ) LIKE '%complaint%'
                        AND LOWER(
                            COALESCE(d.document_type, '') || ' ' ||
                            COALESCE(d.current_filename, '') || ' ' ||
                            COALESCE(d.original_filename, '')
                        ) NOT LIKE '%supplemental complaint attachment%'
                  )
            `).run(timestamp);
        },
    },
    {
        version: 15,
        name: 'require_primary_complaints_for_filing',
        up: db => {
            db.exec(`
                UPDATE document_records
                SET required_for_filing = 1
                WHERE is_active = 1
                  AND id IN (
                      SELECT primary_document_id
                      FROM case_drafts
                      WHERE primary_document_id IS NOT NULL
                  )
            `);
        },
    },
    {
        version: 16,
        name: 'review_unextracted_primary_complaint_drafts',
        up: db => {
            const timestamp = nowIso();
            db.prepare(`
                UPDATE case_drafts
                SET status = 'needs_review',
                    validation_status = 'warnings',
                    updated_at = ?
                WHERE primary_document_id IS NOT NULL
                  AND status IN ('new', 'parsed', 'ready_to_file')
                  AND (
                      normalized_data_json IS NULL
                      OR normalized_data_json NOT LIKE '%"complaintExtraction"%'
                  )
            `).run(timestamp);
        },
    },
    {
        version: 17,
        name: 'standard_nonpayment_package_rules',
        up: db => {
            const columns = db
                .prepare('PRAGMA table_info(document_records)')
                .all() as Array<{ name: string }>;
            const names = new Set(columns.map(column => column.name));
            if (!names.has('filing_relation')) {
                db.exec("ALTER TABLE document_records ADD COLUMN filing_relation TEXT");
            }
            if (!names.has('filing_relation_source')) {
                db.exec("ALTER TABLE document_records ADD COLUMN filing_relation_source TEXT");
            }

            db.exec(`
                UPDATE document_records
                SET filing_sequence = NULL,
                    required_for_filing = CASE
                        WHEN LOWER(
                            COALESCE(document_type, '') || ' ' ||
                            COALESCE(current_filename, '') || ' ' ||
                            COALESCE(original_filename, '')
                        ) LIKE '%mailing fee%'
                          OR LOWER(
                            COALESCE(document_type, '') || ' ' ||
                            COALESCE(current_filename, '') || ' ' ||
                            COALESCE(original_filename, '')
                        ) LIKE '%filing fee%'
                        THEN 0
                        ELSE 1
                    END
                WHERE is_active = 1;

                UPDATE document_records
                SET filing_type = CASE
                        WHEN filing_type_source = 'manual' THEN filing_type
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%advice%'
                            THEN 'Advice of Rights and Information (Landlord-Tenant)'
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%local%'
                            THEN 'Local Rental and Housing Information'
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%complaint%possession only%'
                            THEN 'Complaint for Possession Only'
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%complaint%'
                            THEN 'Complaint for Possession and Supplemental Money Judgment (Fee Varies)'
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%request%'
                            THEN 'Request for Court Mailing and Record (Landlord-Tenant)'
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%summons%'
                            THEN 'Summons, Landlord-Tenant/Land Contract'
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%connected filing%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%demand%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%notice%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%lease%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%deed%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%other%'
                            THEN 'Other'
                        ELSE filing_type
                    END,
                    filing_type_source = CASE
                        WHEN filing_type_source = 'manual' THEN 'manual'
                        ELSE 'suggested'
                    END
                WHERE is_active = 1;

                UPDATE document_records
                SET filing_relation = CASE
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%connected filing%'
                            THEN 'connected_to_complaint'
                        WHEN LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%complaint%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%advice%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%local%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%request%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%summons%'
                          OR LOWER(COALESCE(document_type, '') || ' ' || COALESCE(current_filename, '')) LIKE '%other%'
                            THEN 'separate'
                        ELSE 'unknown'
                    END,
                    filing_relation_source = 'suggested'
                WHERE is_active = 1;
            `);

            const timestamp = nowIso();
            db.prepare(`
                UPDATE case_drafts
                SET status = 'needs_review',
                    validation_status = 'warnings',
                    updated_at = ?
                WHERE status IN ('new', 'parsed', 'ready_to_file')
            `).run(timestamp);
        },
    },
    {
        version: 18,
        name: 'persistent_mifile_filing_jobs',
        up: db => {
            const columns = db
                .prepare('PRAGMA table_info(filing_jobs)')
                .all() as Array<{ name: string }>;
            const names = new Set(columns.map(column => column.name));
            const additions: Array<[string, string]> = [
                ['mode', "TEXT NOT NULL DEFAULT 'prepare'"],
                ['checkpoint', 'TEXT'],
                ['payload_json', 'TEXT'],
                ['result_json', 'TEXT'],
                ['external_bundle_id', 'TEXT'],
                ['temporary_case_number', 'TEXT'],
                ['last_heartbeat_at', 'TEXT'],
                ['error_code', 'TEXT'],
                ['debug_artifact_path', 'TEXT'],
            ];
            for (const [name, definition] of additions) {
                if (!names.has(name)) {
                    db.exec(`ALTER TABLE filing_jobs ADD COLUMN ${name} ${definition}`);
                }
            }
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_filing_jobs_status_created
                    ON filing_jobs(status, created_at);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_filing_jobs_one_active_per_draft
                    ON filing_jobs(case_draft_id)
                    WHERE status IN ('queued', 'running');
            `);
        },
    },
    {
        version: 19,
        name: 'classify_existing_court_filings_as_completed',
        up: db => {
            const timestamp = nowIso();
            db.prepare(`
                UPDATE case_drafts
                SET status = 'filed_successfully',
                    validation_status = 'passed',
                    filing_status = 'succeeded',
                    updated_at = ?
                WHERE normalized_data_json IS NOT NULL
                  AND (
                    json_extract(normalized_data_json, '$.isMiFile') = 1
                    OR NULLIF(json_extract(normalized_data_json, '$.bundleNumber'), '') IS NOT NULL
                    OR NULLIF(json_extract(normalized_data_json, '$.filedAt'), '') IS NOT NULL
                  )
                  AND filing_status NOT IN ('queued', 'running', 'prepared')
            `).run(timestamp);
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
        const existing = this.db
            .prepare(`
                SELECT id, processing_status
                FROM email_records
                WHERE id = ?
            `)
            .get(emailId) as { id: string; processing_status: EmailProcessingStatus } | undefined;
        if (!existing) throw new Error('Email record not found');
        if (existing.processing_status === 'processing') {
            throw new Error('A processing email cannot be queued again');
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
            throw new Error('This email already has an active document retry');
        }

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

    listQueuedEmailRetries(limit = 25): QueuedEmailRetry[] {
        const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
        const rows = this.db
            .prepare(`
                SELECT
                    e.id,
                    e.external_message_id,
                    e.subject,
                    e.sender,
                    e.received_at
                FROM email_records e
                WHERE e.processing_status = 'new'
                  AND EXISTS (
                    SELECT 1
                    FROM audit_logs a
                    WHERE a.entity_type = 'email_record'
                      AND a.entity_id = e.id
                      AND a.action = 'email_retry_queued'
                  )
                ORDER BY e.updated_at, e.id
                LIMIT ?
            `)
            .all(safeLimit) as Array<{
                id: string;
                external_message_id: string;
                subject: string | null;
                sender: string | null;
                received_at: string | null;
            }>;

        return rows.map(row => ({
            emailId: row.id,
            externalMessageId: row.external_message_id,
            subject: row.subject,
            sender: row.sender,
            receivedAt: row.received_at,
        }));
    }

    listPendingEmails(limit = 25): QueuedEmailRetry[] {
        const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
        const rows = this.db
            .prepare(`
                SELECT
                    e.id,
                    e.external_message_id,
                    e.subject,
                    e.sender,
                    e.received_at
                FROM email_records e
                WHERE e.processing_status = 'new'
                  AND (
                    EXISTS (
                        SELECT 1 FROM case_drafts c WHERE c.email_id = e.id
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM audit_logs a
                        WHERE a.entity_type = 'email_record'
                          AND a.entity_id = e.id
                          AND a.action = 'email_retry_queued'
                    )
                    OR LOWER(COALESCE(e.sender, '')) LIKE '%@truefiling.com'
                    OR LOWER(COALESCE(e.subject, '')) LIKE '%mifile%'
                    OR LOWER(COALESCE(e.subject, '')) LIKE '%truefiling%'
                  )
                ORDER BY
                    CASE WHEN EXISTS (
                        SELECT 1
                        FROM audit_logs a
                        WHERE a.entity_type = 'email_record'
                          AND a.entity_id = e.id
                          AND a.action = 'email_retry_queued'
                    ) THEN 0 ELSE 1 END,
                    e.updated_at,
                    e.id
                LIMIT ?
            `)
            .all(safeLimit) as Array<{
                id: string;
                external_message_id: string;
                subject: string | null;
                sender: string | null;
                received_at: string | null;
            }>;

        return rows.map(row => ({
            emailId: row.id,
            externalMessageId: row.external_message_id,
            subject: row.subject,
            sender: row.sender,
            receivedAt: row.received_at,
        }));
    }

    updateEmailExternalMessageId(emailId: string, externalMessageId: string): void {
        const conflict = this.db
            .prepare('SELECT id FROM email_records WHERE external_message_id = ?')
            .get(externalMessageId) as { id: string } | undefined;
        if (conflict && conflict.id !== emailId) {
            throw new Error('The recovered Outlook message is already linked to another email record');
        }

        const timestamp = nowIso();
        this.db
            .prepare(`
                UPDATE email_records
                SET external_message_id = ?, updated_at = ?
                WHERE id = ?
            `)
            .run(externalMessageId, timestamp, emailId);
        this.insertAuditLog('email_record', emailId, 'email_source_message_recovered', {
            externalMessageId,
        });
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
        if (!['pending', 'failed', 'retry_queued'].includes(existing.status)) {
            throw new Error('Only pending or failed documents can be queued for retry');
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

    recoverInterruptedDocumentRetries(): number {
        const timestamp = nowIso();
        const result = this.db
            .prepare(`
                UPDATE document_records
                SET status = 'failed',
                    error_message = 'Worker restarted before the document finished; retry rescheduled',
                    next_retry_at = ?,
                    updated_at = ?
                WHERE status = 'retrying'
            `)
            .run(timestamp, timestamp);
        const recovered = Number(result.changes ?? 0);
        if (recovered > 0) {
            this.insertAuditLog('worker', 'document_retry_worker', 'interrupted_retries_recovered', {
                recovered,
            });
        }
        return recovered;
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
                    e.subject,
                    e.sender,
                    e.received_at,
                    d.case_draft_id,
                    d.source_url,
                    d.document_type,
                    d.original_filename,
                    d.status,
                    COALESCE(c.normalized_data_json, c.extracted_data_json) AS parsed_email_json
                FROM document_records d
                JOIN email_records e ON e.id = d.email_id
                LEFT JOIN case_drafts c ON c.id = d.case_draft_id
                WHERE d.source_url IS NOT NULL
                  AND d.source_url != ''
                  AND (
                    d.status = 'retry_queued'
                    OR (
                        d.status = 'pending'
                        AND e.processing_status IN ('failed', 'partial_failure')
                    )
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
                const parsedCandidate = this.safeJson(candidate.parsed_email_json);
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
                    subject: candidate.subject,
                    sender: candidate.sender,
                    receivedAt: candidate.received_at,
                    parsedEmail:
                        parsedCandidate &&
                        typeof parsedCandidate === 'object' &&
                        Array.isArray(parsedCandidate.filedDocuments)
                            ? parsedCandidate as ParsedEmailInfo
                            : null,
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
        const uploaded = this.db
            .prepare(`
                SELECT case_draft_id, document_type, current_filename, original_filename
                FROM document_records
                WHERE id = ?
            `)
            .get(input.documentId) as
            | {
                case_draft_id: string | null;
                document_type: string | null;
                current_filename: string | null;
                original_filename: string | null;
            }
            | undefined;
        if (uploaded?.case_draft_id) {
            this.assignPrimaryComplaint(
                uploaded.case_draft_id,
                input.documentId,
                uploaded.document_type,
                uploaded.current_filename || uploaded.original_filename,
            );
        }
    }

    completeDocumentRetryNotDownloadable(input: {
        documentId: string;
        reason: string;
        downloadAttempts: number;
        metadata?: unknown;
    }): void {
        const existing = this.db
            .prepare('SELECT metadata_json FROM document_records WHERE id = ?')
            .get(input.documentId) as { metadata_json: string | null } | undefined;
        if (!existing) throw new Error('Document record not found');

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
                    stage: 'download',
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
                SET status = 'not_downloadable',
                    error_message = ?,
                    metadata_json = ?,
                    download_attempts = download_attempts + ?,
                    next_retry_at = NULL,
                    updated_at = ?
                WHERE id = ?
            `)
            .run(
                input.reason,
                toJson(mergedMetadata),
                input.downloadAttempts,
                timestamp,
                input.documentId,
            );
        this.insertAuditLog('document_record', input.documentId, 'document_not_downloadable', {
            reason: input.reason,
            downloadAttempts: input.downloadAttempts,
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
                    SUM(CASE WHEN status = 'not_downloadable' THEN 1 ELSE 0 END) AS not_downloadable_count,
                    SUM(CASE
                        WHEN source_url IS NOT NULL
                         AND status IN ('pending', 'failed', 'retry_queued', 'retrying')
                        THEN 1 ELSE 0
                    END) AS outstanding_count
                FROM document_records
                WHERE email_id = ?
            `)
            .get(emailId) as {
                uploaded_count: number | null;
                not_downloadable_count: number | null;
                outstanding_count: number | null;
            };
        const uploaded = Number(totals.uploaded_count ?? 0);
        const notDownloadable = Number(totals.not_downloadable_count ?? 0);
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
            return;
        }

        if (notDownloadable > 0) {
            this.markEmailProcessed(emailId);
            if (caseDraftId) {
                this.setCaseDraftStatus(caseDraftId, 'needs_review', 'warnings', 'not_started');
            }
        }
    }

    clearPendingDocuments(caseDraftId: string): void {
        this.db
            .prepare(`
                UPDATE case_drafts
                SET primary_document_id = NULL
                WHERE id = ?
                  AND primary_document_id IN (
                      SELECT id
                      FROM document_records
                      WHERE case_draft_id = ?
                        AND status IN ('pending', 'not_downloadable')
                        AND upload_source = 'parsed_email'
                  )
            `)
            .run(caseDraftId, caseDraftId);
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

        // Processing reports from an older worker prove that files reached OneDrive,
        // but they do not prove that the filing package is safe to submit.
        this.refreshCaseDraftValidation(target.case_draft_id);

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

    listDrafts(options: DraftListOptions = {}): DraftPage {
        const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? 25), 10), 100);
        const requestedPage = Math.max(Math.floor(options.page ?? 1), 1);
        const whereParts = ['1 = 1'];
        const parameters: Array<string | number> = [];

        if (options.status) {
            whereParts.push('c.status = ?');
            parameters.push(options.status);
        }
        if (options.validationStatus) {
            whereParts.push('c.validation_status = ?');
            parameters.push(options.validationStatus);
        }

        const search = options.search?.trim();
        if (search) {
            const pattern = `%${search}%`;
            whereParts.push(`(
                e.subject LIKE ? COLLATE NOCASE
                OR e.sender LIKE ? COLLATE NOCASE
                OR c.normalized_data_json LIKE ? COLLATE NOCASE
            )`);
            parameters.push(pattern, pattern, pattern);
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
                SELECT COUNT(*) AS total
                FROM case_drafts c
                JOIN email_records e ON e.id = c.email_id
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
                    c.id AS draft_id,
                    c.email_id,
                    c.status,
                    c.validation_status,
                    c.filing_status,
                    c.normalized_data_json,
                    c.updated_at,
                    e.subject,
                    e.sender,
                    e.received_at,
                    COUNT(d.id) AS document_count,
                    SUM(CASE WHEN d.one_drive_url IS NOT NULL THEN 1 ELSE 0 END)
                        AS viewable_document_count,
                    SUM(CASE WHEN d.status IN ('failed', 'invalid') THEN 1 ELSE 0 END)
                        AS failed_document_count
                FROM case_drafts c
                JOIN email_records e ON e.id = c.email_id
                LEFT JOIN document_records d
                  ON d.case_draft_id = c.id
                 AND d.is_active = 1
                WHERE ${whereSql}
                GROUP BY c.id, e.id
                ORDER BY
                    CASE
                        WHEN c.status IN ('validation_failed', 'needs_review', 'filing_failed') THEN 0
                        WHEN c.status = 'parsed' THEN 1
                        WHEN c.status = 'ready_to_file' THEN 2
                        ELSE 3
                    END,
                    COALESCE(e.received_at, e.created_at) DESC
                LIMIT ? OFFSET ?
            `)
            .all(...parameters, pageSize, offset) as any[];

        return {
            items: rows.map(row => {
                const normalized = this.safeJson(row.normalized_data_json);
                const values = draftEditableData(normalized);
                return {
                    draftId: row.draft_id,
                    emailId: row.email_id,
                    subject: row.subject,
                    sender: row.sender,
                    receivedAt: row.received_at,
                    caseNumber:
                        values.caseNumber ||
                        values.newCaseNumber ||
                        values.temporaryCaseNumber,
                    caseTitle: values.caseTitle,
                    plaintiff: values.plaintiff,
                    defendant: values.defendant,
                    status: row.status,
                    validationStatus: row.validation_status,
                    filingStatus: row.filing_status,
                    documentCount: Number(row.document_count ?? 0),
                    viewableDocumentCount: Number(row.viewable_document_count ?? 0),
                    failedDocumentCount: Number(row.failed_document_count ?? 0),
                    updatedAt: row.updated_at,
                };
            }),
            page,
            pageSize,
            totalItems,
            totalPages,
        };
    }

    listActivity(options: ActivityListOptions = {}): ActivityPage {
        const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? 50), 10), 200);
        const requestedPage = Math.max(Math.floor(options.page ?? 1), 1);
        const whereParts = ['1 = 1'];
        const parameters: Array<string | number> = [];

        const entityType = options.entityType?.trim();
        if (entityType) {
            whereParts.push('a.entity_type = ?');
            parameters.push(entityType);
        }

        const search = options.search?.trim();
        if (search) {
            const pattern = `%${search}%`;
            whereParts.push(`(
                a.action LIKE ? COLLATE NOCASE
                OR a.entity_type LIKE ? COLLATE NOCASE
                OR a.metadata_json LIKE ? COLLATE NOCASE
                OR related_email.subject LIKE ? COLLATE NOCASE
                OR related_email.sender LIKE ? COLLATE NOCASE
            )`);
            parameters.push(pattern, pattern, pattern, pattern, pattern);
        }

        if (options.dateFrom) {
            whereParts.push('a.created_at >= ?');
            parameters.push(options.dateFrom);
        }
        if (options.dateTo) {
            whereParts.push('a.created_at < ?');
            parameters.push(options.dateTo);
        }

        const joins = `
            LEFT JOIN email_records direct_email
              ON a.entity_type = 'email_record'
             AND direct_email.id = a.entity_id
            LEFT JOIN case_drafts related_draft
              ON a.entity_type = 'case_draft'
             AND related_draft.id = a.entity_id
            LEFT JOIN document_records related_document
              ON a.entity_type = 'document_record'
             AND related_document.id = a.entity_id
            LEFT JOIN filing_jobs related_job
              ON a.entity_type = 'filing_job'
             AND related_job.id = a.entity_id
            LEFT JOIN case_drafts filing_draft
              ON filing_draft.id = related_job.case_draft_id
            LEFT JOIN email_records related_email
              ON related_email.id = COALESCE(
                direct_email.id,
                related_draft.email_id,
                related_document.email_id,
                filing_draft.email_id
              )
        `;
        const whereSql = whereParts.join('\n AND ');
        const countRow = this.db
            .prepare(`
                SELECT COUNT(*) AS total
                FROM audit_logs a
                ${joins}
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
                    a.id,
                    a.entity_type,
                    a.entity_id,
                    a.action,
                    a.actor_type,
                    a.actor_id,
                    a.old_value_json,
                    a.new_value_json,
                    a.metadata_json,
                    a.created_at,
                    related_email.id AS email_id,
                    related_email.subject,
                    related_email.sender
                FROM audit_logs a
                ${joins}
                WHERE ${whereSql}
                ORDER BY a.created_at DESC, a.id DESC
                LIMIT ? OFFSET ?
            `)
            .all(...parameters, pageSize, offset) as any[];

        return {
            items: rows.map(row => ({
                id: row.id,
                entityType: row.entity_type,
                entityId: row.entity_id,
                action: row.action,
                actorType: row.actor_type,
                actorId: row.actor_id,
                oldValueJson: row.old_value_json,
                newValueJson: row.new_value_json,
                metadataJson: row.metadata_json,
                createdAt: row.created_at,
                emailId: row.email_id,
                subject: row.subject,
                sender: row.sender,
            })),
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
                    primary_document_id,
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
                    filing_name,
                    filing_type,
                    filing_type_source,
                    filing_relation,
                    filing_relation_source,
                    filing_sequence,
                    required_for_filing,
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
                  AND is_active = 1
                ORDER BY created_at ASC
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
        const extractedDraftData = caseDraft
            ? this.safeJson(caseDraft.extracted_data_json)
            : null;
        const normalizedDraftData = caseDraft
            ? this.safeJson(caseDraft.normalized_data_json)
            : null;
        const normalizedFilingData = draftFilingData(normalizedDraftData);
        const complaintExtraction = caseDraft
            ? complaintExtractionFromDraft(normalizedDraftData)
            : null;
        const documentViews: DocumentRecordView[] = documents.map(row => {
            const suggestedFilingType = suggestMiFileFilingType(
                row.document_type,
                row.current_filename || row.original_filename,
                normalizedFilingData.moneyJudgmentRequested,
            );
            const suggestedRelation = suggestedFilingRelation(
                row.document_type,
                row.current_filename || row.original_filename,
            );
            const packageRole = filingPackageRole(
                row.document_type,
                row.current_filename || row.original_filename,
            );
            const suggestedSequence = suggestedDocumentSequence(
                row.document_type,
                row.current_filename || row.original_filename,
            );
            return {
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
                filingName: row.filing_name || row.current_filename || row.original_filename,
                filingType: row.filing_type || suggestedFilingType,
                filingTypeSource: row.filing_type
                    ? row.filing_type_source === 'manual'
                        ? 'manual'
                        : row.filing_type_source === 'complaint'
                            ? 'complaint'
                            : 'suggested'
                    : suggestedFilingType
                        ? 'suggested'
                        : null,
                filingRelation:
                    row.filing_relation === 'separate' ||
                    row.filing_relation === 'connected_to_complaint'
                        ? row.filing_relation
                        : suggestedRelation,
                filingRelationSource: row.filing_relation
                    ? (row.filing_relation_source === 'manual' ? 'manual' : 'suggested')
                    : 'suggested',
                filingSequence: row.filing_sequence === null
                    ? suggestedSequence
                    : Number(row.filing_sequence),
                suggestedFilingSequence: suggestedSequence,
                requiredForFiling: Number(row.required_for_filing ?? 0) === 1,
                isPrimary: caseDraft?.primary_document_id === row.id,
                documentRole: draftDocumentRole(
                    row.document_type,
                    row.current_filename || row.original_filename,
                ),
                packageRole,
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
            };
        });
        documentViews.sort((left, right) => {
            if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
            return left.createdAt.localeCompare(right.createdAt);
        });
        const validationIssues = caseDraft
            ? [
                ...validateDraftData(normalizedDraftData),
                ...validatePrimaryComplaint(
                    caseDraft.primary_document_id,
                    documentViews,
                    complaintExtraction,
                    normalizedFilingData,
                ),
                ...validateDraftDocuments(documentViews, normalizedFilingData),
            ]
            : [];
        const filingEligibilityIssues = caseDraft
            ? validateNewCaseSource(
                normalizedDraftData,
                email.subject,
                email.sender,
            )
            : [];

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
                    primaryDocumentId: caseDraft.primary_document_id,
                    editableData: draftEditableData(normalizedDraftData),
                    filingData: draftFilingData(normalizedDraftData),
                    fieldSources: draftFieldSources(extractedDraftData, normalizedDraftData),
                    filingFieldSources: draftFilingFieldSources(
                        extractedDraftData,
                        normalizedDraftData,
                    ),
                    complaintExtraction,
                    validationIssues,
                    filingEligible: filingEligibilityIssues.length === 0,
                    filingEligibilityIssues,
                    createdAt: caseDraft.created_at,
                    updatedAt: caseDraft.updated_at,
                }
                : null,
            plaintiffMapping,
            plaintiffFilenameMapping,
            retryPolicy: this.getDocumentRetryPolicy(),
            documents: documentViews,
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

    getDraftDetail(caseDraftId: string): EmailDetail | null {
        const row = this.db
            .prepare('SELECT email_id FROM case_drafts WHERE id = ?')
            .get(caseDraftId) as { email_id: string } | undefined;
        return row ? this.getEmailDetail(row.email_id) : null;
    }

    buildFilingPayload(caseDraftId: string): FilingPayload {
        const detail = this.getDraftDetail(caseDraftId);
        if (!detail?.caseDraft) throw new Error('Case draft not found');
        const blockingIssue = detail.caseDraft.validationIssues.find(
            issue => issue.severity === 'error',
        );
        if (blockingIssue) {
            throw new Error(`Filing is blocked: ${blockingIssue.message}`);
        }
        const eligibilityIssue = detail.caseDraft.filingEligibilityIssues[0];
        if (eligibilityIssue) {
            throw new Error(`Filing is blocked: ${eligibilityIssue.message}`);
        }
        const courtName = detail.caseDraft.editableData.courtName;
        if (!courtName) throw new Error('Filing is blocked: MiFILE court is required');
        const filingData = detail.caseDraft.filingData;
        if (filingData.action !== 'Initiate a new case') {
            throw new Error('Only new-case initiation is supported');
        }
        if (filingData.caseType !== 'LT - Landlord-Tenant Summary Proceedings') {
            throw new Error('Only LT - Landlord-Tenant Summary Proceedings is supported');
        }

        const documents = detail.documents
            .filter(document => document.requiredForFiling && document.packageRole !== 'fee')
            .map(document => {
                const filename = document.currentFilename || document.originalFilename;
                if (!filename || !document.oneDriveUrl || !document.filingType) {
                    throw new Error(
                        `${filename || document.documentType || 'Document'} is not ready for MiFILE`,
                    );
                }
                return {
                    id: document.id,
                    filename,
                    filingName: document.filingName || filename.replace(/\.pdf$/i, ''),
                    filingType: document.filingType,
                    filingRelation: document.filingRelation,
                    packageRole: document.packageRole,
                    oneDriveUrl: document.oneDriveUrl,
                    mimeType: document.mimeType,
                    fileSize: document.fileSize,
                    isPrimary: document.isPrimary,
                } satisfies FilingDocumentPayload;
            });
        const uploadRank = (document: FilingDocumentPayload): number => {
            if (document.isPrimary) return 0;
            if (document.filingRelation === 'connected_to_complaint') return 1;
            return 2;
        };
        documents.sort((left, right) => uploadRank(left) - uploadRank(right));

        return {
            version: 1,
            caseDraftId,
            emailId: detail.email.id,
            subject: detail.email.subject,
            courtName,
            action: 'Initiate a new case',
            caseType: 'LT - Landlord-Tenant Summary Proceedings',
            filingData,
            documents,
            createdAt: nowIso(),
        };
    }

    queueFilingJob(
        caseDraftId: string,
        mode: FilingJobMode = 'prepare',
        triggerSource = 'admin',
        triggeredBy = 'admin',
    ): FilingJobView {
        const detail = this.getDraftDetail(caseDraftId);
        if (!detail?.caseDraft) throw new Error('Case draft not found');
        const allowedStatuses = mode === 'submit'
            ? new Set(['filing_prepared'])
            : new Set(['ready_to_file', 'filing_failed']);
        if (!allowedStatuses.has(detail.caseDraft.status)) {
            throw new Error(
                mode === 'submit'
                    ? 'The filing must be prepared in MiFILE before final submission'
                    : 'Approve the Draft before preparing it in MiFILE',
            );
        }
        const active = this.db
            .prepare(`
                SELECT id FROM filing_jobs
                WHERE case_draft_id = ? AND status IN ('queued', 'running')
                LIMIT 1
            `)
            .get(caseDraftId) as { id: string } | undefined;
        if (active) throw new Error('This Draft already has an active MiFILE job');

        const payload = this.buildFilingPayload(caseDraftId);
        const attempt = this.db
            .prepare(`
                SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt
                FROM filing_jobs WHERE case_draft_id = ?
            `)
            .get(caseDraftId) as { attempt: number };
        const previousPrepared = mode === 'submit'
            ? this.db.prepare(`
                SELECT external_bundle_id, temporary_case_number
                FROM filing_jobs
                WHERE case_draft_id = ? AND status = 'prepared'
                ORDER BY attempt_number DESC LIMIT 1
            `).get(caseDraftId) as
                | { external_bundle_id: string | null; temporary_case_number: string | null }
                | undefined
            : undefined;
        if (mode === 'submit' && !previousPrepared?.external_bundle_id) {
            throw new Error('Prepared MiFILE bundle reference is missing');
        }

        const id = randomUUID();
        const timestamp = nowIso();
        const initialLog: FilingJobLogEntry[] = [{
            at: timestamp,
            level: 'info',
            checkpoint: 'queued',
            message: mode === 'prepare'
                ? 'MiFILE preparation queued from Draft Editor.'
                : 'Final MiFILE submission queued from Draft Editor.',
        }];
        this.runInTransaction(() => {
            this.db.prepare(`
                INSERT INTO filing_jobs (
                    id, case_draft_id, attempt_number, mode, status,
                    trigger_source, checkpoint, payload_json, execution_log,
                    external_bundle_id, temporary_case_number, triggered_by,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'queued', ?, 'queued', ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                caseDraftId,
                Number(attempt.attempt),
                mode,
                triggerSource,
                toJson(payload),
                toJson(initialLog),
                previousPrepared?.external_bundle_id ?? null,
                previousPrepared?.temporary_case_number ?? null,
                triggeredBy,
                timestamp,
                timestamp,
            );
            this.db.prepare(`
                UPDATE case_drafts
                SET filing_status = 'queued', updated_at = ?
                WHERE id = ?
            `).run(timestamp, caseDraftId);
            this.insertAuditLog('filing_job', id, 'filing_job_queued', {
                caseDraftId,
                mode,
                attemptNumber: Number(attempt.attempt),
                triggerSource,
            });
        });
        const job = this.getFilingJob(id);
        if (!job) throw new Error('Queued MiFILE job could not be loaded');
        return job;
    }

    recoverInterruptedFilingJobs(): number {
        const rows = this.db.prepare(`
            SELECT id, case_draft_id, execution_log
            FROM filing_jobs
            WHERE status = 'running'
        `).all() as Array<{
            id: string;
            case_draft_id: string;
            execution_log: string | null;
        }>;
        if (!rows.length) return 0;
        const timestamp = nowIso();
        this.runInTransaction(() => {
            for (const row of rows) {
                const parsed = this.safeJson(row.execution_log);
                const log = Array.isArray(parsed) ? parsed.slice(-999) : [];
                log.push({
                    at: timestamp,
                    level: 'error',
                    checkpoint: 'process_interrupted',
                    message: 'The service restarted while this MiFILE attempt was running. Retry it from the Draft.',
                    details: { code: 'PROCESS_INTERRUPTED' },
                } satisfies FilingJobLogEntry);
                this.db.prepare(`
                    UPDATE filing_jobs
                    SET status = 'failed', checkpoint = 'process_interrupted',
                        finished_at = ?, error_code = 'PROCESS_INTERRUPTED',
                        error_message = 'The service restarted during MiFILE preparation.',
                        execution_log = ?, updated_at = ?
                    WHERE id = ?
                `).run(timestamp, toJson(log), timestamp, row.id);
                this.db.prepare(`
                    UPDATE case_drafts
                    SET status = 'filing_failed', filing_status = 'failed', updated_at = ?
                    WHERE id = ?
                `).run(timestamp, row.case_draft_id);
                this.insertAuditLog('filing_job', row.id, 'filing_job_interrupted', {
                    caseDraftId: row.case_draft_id,
                });
            }
        });
        return rows.length;
    }

    claimNextFilingJob(): FilingJobView | null {
        const jobId = this.runInTransaction(() => {
            const queued = this.db.prepare(`
                SELECT id, case_draft_id
                FROM filing_jobs
                WHERE status = 'queued'
                ORDER BY created_at ASC
                LIMIT 1
            `).get() as { id: string; case_draft_id: string } | undefined;
            if (!queued) return null;
            const timestamp = nowIso();
            const result = this.db.prepare(`
                UPDATE filing_jobs
                SET status = 'running', checkpoint = 'starting',
                    started_at = COALESCE(started_at, ?), last_heartbeat_at = ?, updated_at = ?
                WHERE id = ? AND status = 'queued'
            `).run(timestamp, timestamp, timestamp, queued.id);
            if (Number(result.changes ?? 0) !== 1) return null;
            this.db.prepare(`
                UPDATE case_drafts
                SET status = 'filing_in_progress', filing_status = 'running', updated_at = ?
                WHERE id = ?
            `).run(timestamp, queued.case_draft_id);
            return queued.id;
        });
        return jobId ? this.getFilingJob(jobId) : null;
    }

    getFilingJob(filingJobId: string): FilingJobView | null {
        const row = this.db.prepare(`
            SELECT fj.*, cd.email_id, er.subject
            FROM filing_jobs fj
            JOIN case_drafts cd ON cd.id = fj.case_draft_id
            JOIN email_records er ON er.id = cd.email_id
            WHERE fj.id = ?
        `).get(filingJobId) as Record<string, unknown> | undefined;
        return row ? this.filingJobFromRow(row) : null;
    }

    listFilingJobs(caseDraftId?: string, limit = 100): FilingJobView[] {
        const safeLimit = Math.min(Math.max(Math.floor(limit) || 100, 1), 500);
        const rows = (caseDraftId
            ? this.db.prepare(`
                SELECT fj.*, cd.email_id, er.subject
                FROM filing_jobs fj
                JOIN case_drafts cd ON cd.id = fj.case_draft_id
                JOIN email_records er ON er.id = cd.email_id
                WHERE fj.case_draft_id = ?
                ORDER BY fj.created_at DESC LIMIT ?
            `).all(caseDraftId, safeLimit)
            : this.db.prepare(`
                SELECT fj.*, cd.email_id, er.subject
                FROM filing_jobs fj
                JOIN case_drafts cd ON cd.id = fj.case_draft_id
                JOIN email_records er ON er.id = cd.email_id
                ORDER BY fj.created_at DESC LIMIT ?
            `).all(safeLimit)) as Array<Record<string, unknown>>;
        return rows.map(row => this.filingJobFromRow(row));
    }

    appendFilingJobLog(
        filingJobId: string,
        entry: Omit<FilingJobLogEntry, 'at'> & { at?: string },
    ): void {
        const row = this.db.prepare(
            'SELECT execution_log FROM filing_jobs WHERE id = ?',
        ).get(filingJobId) as { execution_log: string | null } | undefined;
        if (!row) throw new Error('MiFILE job not found');
        const parsed = this.safeJson(row.execution_log);
        const log = Array.isArray(parsed) ? parsed.slice(-999) : [];
        log.push({ ...entry, at: entry.at || nowIso() });
        const timestamp = nowIso();
        this.db.prepare(`
            UPDATE filing_jobs
            SET execution_log = ?, checkpoint = ?, last_heartbeat_at = ?, updated_at = ?
            WHERE id = ?
        `).run(toJson(log), entry.checkpoint, timestamp, timestamp, filingJobId);
    }

    completeFilingJob(input: {
        filingJobId: string;
        status: 'prepared' | 'succeeded' | 'failed';
        checkpoint: string;
        errorCode?: string | null;
        errorMessage?: string | null;
        externalBundleId?: string | null;
        temporaryCaseNumber?: string | null;
        result?: Record<string, unknown> | null;
        debugArtifactPath?: string | null;
    }): FilingJobView {
        const existing = this.getFilingJob(input.filingJobId);
        if (!existing) throw new Error('MiFILE job not found');
        const timestamp = nowIso();
        const startedAt = existing.startedAt ? Date.parse(existing.startedAt) : Date.now();
        const durationMs = Math.max(0, Date.now() - startedAt);
        const draftState = input.status === 'prepared'
            ? { status: 'filing_prepared', filingStatus: 'prepared' }
            : input.status === 'succeeded'
                ? { status: 'filed_successfully', filingStatus: 'succeeded' }
                : { status: 'filing_failed', filingStatus: 'failed' };
        this.runInTransaction(() => {
            this.db.prepare(`
                UPDATE filing_jobs
                SET status = ?, checkpoint = ?, finished_at = ?, duration_ms = ?,
                    error_code = ?, error_message = ?, result_json = ?,
                    external_bundle_id = COALESCE(?, external_bundle_id),
                    temporary_case_number = COALESCE(?, temporary_case_number),
                    debug_artifact_path = ?, last_heartbeat_at = ?, updated_at = ?
                WHERE id = ?
            `).run(
                input.status,
                input.checkpoint,
                timestamp,
                durationMs,
                input.errorCode ?? null,
                input.errorMessage ?? null,
                toJson(input.result),
                input.externalBundleId ?? null,
                input.temporaryCaseNumber ?? null,
                input.debugArtifactPath ?? null,
                timestamp,
                timestamp,
                input.filingJobId,
            );
            this.db.prepare(`
                UPDATE case_drafts
                SET status = ?, filing_status = ?, updated_at = ?
                WHERE id = ?
            `).run(
                draftState.status,
                draftState.filingStatus,
                timestamp,
                existing.caseDraftId,
            );
            this.insertAuditLog('filing_job', input.filingJobId, `filing_job_${input.status}`, {
                caseDraftId: existing.caseDraftId,
                checkpoint: input.checkpoint,
                durationMs,
                errorCode: input.errorCode ?? null,
            });
        });
        const completed = this.getFilingJob(input.filingJobId);
        if (!completed) throw new Error('Completed MiFILE job could not be loaded');
        return completed;
    }

    updateCaseDraft(
        caseDraftId: string,
        fields: Record<string, unknown>,
        reviewerNotes?: string,
        filingDataInput?: unknown,
        documentMappings: DraftDocumentFilingUpdate[] = [],
        primaryDocumentIdInput?: unknown,
    ): EmailDetail {
        const existing = this.db
            .prepare(`
                SELECT
                    email_id,
                    status,
                    validation_status,
                    filing_status,
                    primary_document_id,
                    normalized_data_json,
                    reviewer_notes
                FROM case_drafts
                WHERE id = ?
            `)
            .get(caseDraftId) as
            | {
                email_id: string;
                status: CaseDraftStatus;
                validation_status: ValidationStatus;
                filing_status: FilingStatus;
                primary_document_id: string | null;
                normalized_data_json: string | null;
                reviewer_notes: string | null;
            }
            | undefined;
        if (!existing) throw new Error('Case draft not found');
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
            throw new Error('Draft fields must be an object');
        }
        if (!Array.isArray(documentMappings)) {
            throw new Error('Draft document mappings must be an array');
        }
        if (documentMappings.length > 200) {
            throw new Error('A draft cannot update more than 200 documents at once');
        }

        const allowed = new Set<string>(EDITABLE_DRAFT_FIELDS);
        const requestedFields = Object.keys(fields);
        const invalidField = requestedFields.find(field => !allowed.has(field));
        if (invalidField) throw new Error(`Draft field is not editable: ${invalidField}`);

        const current = this.safeJson(existing.normalized_data_json);
        const next = current && typeof current === 'object' && !Array.isArray(current)
            ? { ...current }
            : {};
        const oldFields: Record<string, string | null> = {};
        const newFields: Record<string, string | null> = {};

        for (const field of requestedFields as EditableDraftField[]) {
            const value = editableDraftValue(fields[field]);
            if (value && value.length > 1000) {
                throw new Error(`${field} must be 1000 characters or fewer`);
            }
            const previous = editableDraftValue(next[field]);
            if (previous === value) continue;
            oldFields[field] = previous;
            newFields[field] = value;
            next[field] = value;
        }

        const previousFilingData = draftFilingData(next);
        const nextFilingData = filingDataInput === undefined
            ? previousFilingData
            : draftFilingData({
                ...next,
                filingData: filingDataInput,
            });
        const filingDataChanged =
            JSON.stringify(previousFilingData) !== JSON.stringify(nextFilingData);
        next.filingData = nextFilingData;

        const manualFilingFields = storedManualFilingFields(next);
        if (filingDataInput !== undefined) {
            for (const key of DRAFT_FILING_DATA_KEYS) {
                if (!jsonValuesEqual(previousFilingData[key], nextFilingData[key])) {
                    manualFilingFields.add(key);
                }
            }
            next.manualFilingFields = Array.from(manualFilingFields).sort();
        }

        if (filingDataInput !== undefined) {
            const plaintiffName = draftPartyName(nextFilingData.plaintiff);
            const defendantNames = nextFilingData.defendants
                .map(draftPartyName)
                .filter((value): value is string => Boolean(value));
            const compatibilityFields: Partial<Record<EditableDraftField, string | null>> = {
                plaintiff: plaintiffName,
                defendant: defendantNames.length ? defendantNames.join(', ') : null,
                filerName: nextFilingData.attorney.name,
            };
            for (const [field, value] of Object.entries(compatibilityFields) as Array<
                [EditableDraftField, string | null]
            >) {
                const previous = editableDraftValue(next[field]);
                if (previous === value) continue;
                oldFields[field] = previous;
                newFields[field] = value;
                next[field] = value;
            }
        }

        const notes = reviewerNotes === undefined
            ? existing.reviewer_notes
            : reviewerNotes.trim().slice(0, 10_000) || null;
        let primaryDocumentId = existing.primary_document_id;
        if (primaryDocumentIdInput !== undefined) {
            primaryDocumentId = editableDraftValue(primaryDocumentIdInput);
            if (primaryDocumentId) {
                const primaryDocument = this.db
                    .prepare(`
                        SELECT id, document_type, current_filename, original_filename
                        FROM document_records
                        WHERE id = ?
                          AND case_draft_id = ?
                          AND is_active = 1
                    `)
                    .get(primaryDocumentId, caseDraftId) as
                    | {
                        id: string;
                        document_type: string | null;
                        current_filename: string | null;
                        original_filename: string | null;
                    }
                    | undefined;
                if (!primaryDocument) {
                    throw new Error('The selected primary document does not belong to this Draft');
                }
                if (!isComplaintDocument(
                    primaryDocument.document_type,
                    primaryDocument.current_filename || primaryDocument.original_filename,
                )) {
                    throw new Error('Only a Complaint can be selected as the primary data source');
                }
            }
        }
        const primaryDocumentChanged = primaryDocumentId !== existing.primary_document_id;
        if (primaryDocumentChanged) delete next.complaintExtraction;
        const issues = validateDraftData(next);
        const validationStatus: ValidationStatus = issues.some(issue => issue.severity === 'error')
            ? 'failed'
            : issues.length > 0
                ? 'warnings'
                : 'passed';
        const protectedStatuses = new Set<CaseDraftStatus>([
            'filing_in_progress',
            'filed_successfully',
            'archived',
        ]);
        const changed =
            Object.keys(newFields).length > 0 ||
            filingDataChanged ||
            documentMappings.length > 0 ||
            primaryDocumentChanged;
        const status = changed && !protectedStatuses.has(existing.status)
            ? 'needs_review'
            : existing.status;
        const timestamp = nowIso();

        const updatedDocumentIds: string[] = [];
        this.runInTransaction(() => {
            this.db
                .prepare(`
                    UPDATE case_drafts
                    SET normalized_data_json = ?,
                        primary_document_id = ?,
                        reviewer_notes = ?,
                        status = ?,
                        validation_status = ?,
                        updated_at = ?
                    WHERE id = ?
                `)
                .run(
                    toJson(next),
                    primaryDocumentId,
                    notes,
                    status,
                    validationStatus,
                    timestamp,
                    caseDraftId,
                );

            for (const [index, mapping] of documentMappings.entries()) {
                const documentId = boundedDraftValue(mapping?.id, 'document.id', 100);
                if (!documentId) throw new Error('Every document mapping requires an id');
                const existingDocument = this.db
                    .prepare(`
                        SELECT id, document_type, current_filename, original_filename
                        FROM document_records
                        WHERE id = ?
                          AND case_draft_id = ?
                          AND is_active = 1
                    `)
                    .get(documentId, caseDraftId);
                if (!existingDocument) {
                    throw new Error(`Document does not belong to this draft: ${documentId}`);
                }

                const filingName = boundedDraftValue(
                    mapping.filingName,
                    'document.filingName',
                    300,
                );
                const filingType = boundedDraftValue(
                    mapping.filingType,
                    'document.filingType',
                    300,
                );
                const requestedRelation = boundedDraftValue(
                    mapping.filingRelation,
                    'document.filingRelation',
                    100,
                );
                if (
                    requestedRelation &&
                    !['separate', 'connected_to_complaint', 'unknown'].includes(requestedRelation)
                ) {
                    throw new Error(`Invalid filing relation for document: ${documentId}`);
                }
                const packageRole = filingPackageRole(
                    (existingDocument as any).document_type,
                    (existingDocument as any).current_filename ||
                        (existingDocument as any).original_filename,
                );
                const coreDocument = [
                    'complaint',
                    'advice',
                    'local',
                    'request',
                    'summons',
                ].includes(packageRole);
                const filingRelation: DraftFilingRelation = coreDocument
                    ? 'separate'
                    : requestedRelation === 'separate' ||
                        requestedRelation === 'connected_to_complaint'
                        ? requestedRelation
                        : 'unknown';
                const requiredForFiling = coreDocument
                    ? true
                    : packageRole === 'fee'
                        ? false
                        : mapping.requiredForFiling !== false;

                this.db
                    .prepare(`
                        UPDATE document_records
                        SET filing_name = ?,
                            filing_type = ?,
                            filing_type_source = ?,
                            filing_relation = ?,
                            filing_relation_source = ?,
                            filing_sequence = NULL,
                            required_for_filing = ?,
                            updated_at = ?
                        WHERE id = ?
                    `)
                    .run(
                        filingName,
                        filingType,
                        filingType ? 'manual' : null,
                        filingRelation,
                        'manual',
                        requiredForFiling ? 1 : 0,
                        timestamp,
                        documentId,
                    );
                updatedDocumentIds.push(documentId);
            }

            if (primaryDocumentId) {
                this.db
                    .prepare(`
                        UPDATE document_records
                        SET required_for_filing = 1, updated_at = ?
                        WHERE id = ?
                          AND case_draft_id = ?
                          AND is_active = 1
                    `)
                    .run(timestamp, primaryDocumentId, caseDraftId);
            }
        });

        const detailAfterUpdate = this.getEmailDetail(existing.email_id);
        if (!detailAfterUpdate?.caseDraft) {
            throw new Error('Draft email record not found after update');
        }
        const completeIssues = detailAfterUpdate.caseDraft.validationIssues;
        const completeValidationStatus: ValidationStatus = completeIssues.some(
            issue => issue.severity === 'error',
        )
            ? 'failed'
            : completeIssues.length
                ? 'warnings'
                : 'passed';
        if (completeValidationStatus !== validationStatus) {
            this.db
                .prepare(`
                    UPDATE case_drafts
                    SET validation_status = ?, updated_at = ?
                    WHERE id = ?
                `)
                .run(completeValidationStatus, timestamp, caseDraftId);
        }

        this.insertAuditLog(
            'case_draft',
            caseDraftId,
            changed ? 'draft_fields_updated' : 'draft_note_updated',
            {
                changedFields: Object.keys(newFields),
                filingDataChanged,
                primaryDocumentChanged,
                primaryDocumentId,
                updatedDocumentIds,
                validationIssues: completeIssues,
            },
            {
                fields: oldFields,
                reviewerNotes: existing.reviewer_notes,
                primaryDocumentId: existing.primary_document_id,
                status: existing.status,
                validationStatus: existing.validation_status,
            },
            {
                fields: newFields,
                filingData: filingDataChanged ? nextFilingData : undefined,
                updatedDocumentIds,
                reviewerNotes: notes,
                primaryDocumentId,
                status,
                validationStatus: completeValidationStatus,
            },
        );

        const detail = this.getEmailDetail(existing.email_id);
        if (!detail) throw new Error('Draft email record not found');
        return detail;
    }

    getDocumentAccess(documentId: string): DraftDocumentAccess | null {
        const row = this.db
            .prepare(`
                SELECT id, case_draft_id, one_drive_url, current_filename, mime_type
                FROM document_records
                WHERE id = ?
                  AND is_active = 1
                  AND one_drive_url IS NOT NULL
            `)
            .get(documentId) as any | undefined;
        return row
            ? {
                id: row.id,
                caseDraftId: row.case_draft_id,
                oneDriveUrl: row.one_drive_url,
                currentFilename: row.current_filename,
                mimeType: row.mime_type,
            }
            : null;
    }

    recordDocumentReplacement(
        documentId: string,
        input: { fileSize: number; mimeType?: string | null },
    ): EmailDetail {
        const row = this.db.prepare(`
            SELECT d.case_draft_id, d.email_id, c.primary_document_id,
                   c.extracted_data_json, c.normalized_data_json
            FROM document_records d
            LEFT JOIN case_drafts c ON c.id = d.case_draft_id
            WHERE d.id = ? AND d.is_active = 1
        `).get(documentId) as
            | {
                case_draft_id: string | null;
                email_id: string;
                primary_document_id: string | null;
                extracted_data_json: string | null;
                normalized_data_json: string | null;
            }
            | undefined;
        if (!row) throw new Error('Document not found');
        const timestamp = nowIso();
        this.runInTransaction(() => {
            this.db.prepare(`
                UPDATE document_records
                SET status = 'replaced', file_size = ?, mime_type = ?,
                    error_message = NULL, updated_at = ?
                WHERE id = ?
            `).run(input.fileSize, input.mimeType || 'application/pdf', timestamp, documentId);
            if (row.case_draft_id) {
                if (row.primary_document_id === documentId) {
                    const extracted = this.safeJson(row.extracted_data_json) || {};
                    const normalized = this.safeJson(row.normalized_data_json) || {};
                    delete extracted.complaintExtraction;
                    delete normalized.complaintExtraction;
                    this.db.prepare(`
                        UPDATE case_drafts
                        SET extracted_data_json = ?, normalized_data_json = ?,
                            status = 'needs_review', validation_status = 'warnings',
                            filing_status = 'not_started', updated_at = ?
                        WHERE id = ?
                    `).run(
                        toJson(extracted),
                        toJson(normalized),
                        timestamp,
                        row.case_draft_id,
                    );
                } else {
                    this.db.prepare(`
                        UPDATE case_drafts
                        SET status = 'needs_review', filing_status = 'not_started', updated_at = ?
                        WHERE id = ?
                    `).run(timestamp, row.case_draft_id);
                }
            }
            this.insertAuditLog('document_record', documentId, 'draft_document_replaced', {
                fileSize: input.fileSize,
                primaryComplaint: row.primary_document_id === documentId,
            });
        });
        if (row.case_draft_id) return this.refreshCaseDraftValidation(row.case_draft_id);
        const detail = this.getEmailDetail(row.email_id);
        if (!detail) throw new Error('Document email record not found');
        return detail;
    }

    applyComplaintExtraction(
        caseDraftId: string,
        documentId: string,
        extraction: ComplaintExtractionResult,
    ): EmailDetail {
        const existing = this.db
            .prepare(`
                SELECT
                    email_id,
                    status,
                    extracted_data_json,
                    normalized_data_json
                FROM case_drafts
                WHERE id = ?
            `)
            .get(caseDraftId) as
            | {
                email_id: string;
                status: CaseDraftStatus;
                extracted_data_json: string | null;
                normalized_data_json: string | null;
            }
            | undefined;
        if (!existing) throw new Error('Case draft not found');

        const document = this.db
            .prepare(`
                SELECT id, document_type, current_filename, original_filename
                FROM document_records
                WHERE id = ?
                  AND case_draft_id = ?
                  AND is_active = 1
            `)
            .get(documentId, caseDraftId) as
            | {
                id: string;
                document_type: string | null;
                current_filename: string | null;
                original_filename: string | null;
            }
            | undefined;
        if (!document) throw new Error('Complaint document does not belong to this Draft');
        if (!isComplaintDocument(
            document.document_type,
            document.current_filename || document.original_filename,
        )) {
            throw new Error('Only a Complaint can be used for Complaint field extraction');
        }

        const extractedData = this.safeJson(existing.extracted_data_json);
        const normalizedData = this.safeJson(existing.normalized_data_json);
        const next = normalizedData && typeof normalizedData === 'object' &&
            !Array.isArray(normalizedData)
            ? { ...normalizedData } as Record<string, unknown>
            : {};
        const filing = draftFilingData(next);
        const manualFields = inferredManualFilingFields(extractedData, next);
        const appliedFields: string[] = [];
        const apply = <K extends DraftFilingDataKey>(key: K, value: DraftFilingData[K]) => {
            if (manualFields.has(key) || value === undefined || value === null) return;
            filing[key] = value;
            appliedFields.push(key);
        };

        if (extraction.data.courtDistrict) {
            apply('courtDistrict', extraction.data.courtDistrict);
        }
        if (extraction.data.plaintiff) {
            apply('plaintiff', sanitizeDraftParty({
                ...extraction.data.plaintiff,
                partyType: 'entity',
            }, 'plaintiff-1', 'entity'));
        }
        if (extraction.data.defendants?.length) {
            apply('defendants', extraction.data.defendants.map((party, index) =>
                sanitizeDraftParty({
                    ...party,
                    partyType: 'person',
                }, `defendant-${index + 1}`, 'person')));
        }
        if (extraction.data.attorney) {
            apply('attorney', sanitizeDraftAttorney(
                extraction.data.attorney,
                extraction.data.attorney.displayName,
            ));
        }
        if (typeof extraction.data.includeAllOtherOccupants === 'boolean') {
            apply('includeAllOtherOccupants', extraction.data.includeAllOtherOccupants);
        }
        if (extraction.data.relatedCivilAction) {
            apply('relatedCivilAction', extraction.data.relatedCivilAction);
        }
        if (extraction.data.relatedCaseCourt) {
            apply('relatedCaseCourt', extraction.data.relatedCaseCourt);
        }
        if (extraction.data.relatedCaseDocketNumber) {
            apply('relatedCaseDocketNumber', extraction.data.relatedCaseDocketNumber);
        }
        if (extraction.data.relatedCaseJudge) {
            apply('relatedCaseJudge', extraction.data.relatedCaseJudge);
        }
        if (typeof extraction.data.relatedCasePending === 'boolean') {
            apply('relatedCasePending', extraction.data.relatedCasePending);
        }
        if (typeof extraction.data.moneyJudgmentRequested === 'boolean') {
            apply('moneyJudgmentRequested', extraction.data.moneyJudgmentRequested);
        }
        if (extraction.data.claimAmount) {
            apply('claimAmount', extraction.data.claimAmount);
        }
        if (extraction.data.mailingRequested === true) {
            apply('mailingRequested', true);
        }

        const legacySources = draftFieldSources(extractedData, next);
        if (extraction.data.caseNumber && legacySources.caseNumber !== 'manual') {
            next.caseNumber = extraction.data.caseNumber;
        }
        if (extraction.data.plaintiff && legacySources.plaintiff !== 'manual') {
            next.plaintiff = extraction.data.plaintiff.displayName;
        }
        if (extraction.data.defendants?.length && legacySources.defendant !== 'manual') {
            next.defendant = extraction.data.defendants
                .map(party => party.displayName)
                .join(', ');
        }
        if (extraction.data.attorney && legacySources.filerName !== 'manual') {
            next.filerName = extraction.data.attorney.displayName;
        }

        const timestamp = nowIso();
        next.filingData = filing;
        next.manualFilingFields = Array.from(manualFields).sort();
        next.complaintExtraction = {
            ...extraction,
            documentId,
            extractedAt: timestamp,
            appliedFields,
        } satisfies StoredComplaintExtraction;

        const protectedStatuses = new Set<CaseDraftStatus>([
            'filing_in_progress',
            'filing_prepared',
            'filed_successfully',
            'archived',
        ]);
        const nextStatus = protectedStatuses.has(existing.status)
            ? existing.status
            : 'needs_review';
        this.db
            .prepare(`
                UPDATE case_drafts
                SET primary_document_id = ?,
                    normalized_data_json = ?,
                    status = ?,
                    validation_status = 'warnings',
                    updated_at = ?
                WHERE id = ?
            `)
            .run(documentId, toJson(next), nextStatus, timestamp, caseDraftId);
        this.db
            .prepare(`
                UPDATE document_records
                SET filing_type = CASE
                        WHEN filing_type_source = 'manual' THEN filing_type
                        ELSE ?
                    END,
                    filing_type_source = CASE
                        WHEN filing_type_source = 'manual' THEN filing_type_source
                        ELSE 'complaint'
                    END,
                    filing_relation = 'separate',
                    filing_relation_source = CASE
                        WHEN filing_relation_source = 'manual' THEN filing_relation_source
                        ELSE 'suggested'
                    END,
                    required_for_filing = 1,
                    updated_at = ?
                WHERE id = ?
                  AND case_draft_id = ?
                  AND is_active = 1
            `)
            .run(
                suggestMiFileFilingType(
                    document.document_type,
                    document.current_filename || document.original_filename,
                    filing.moneyJudgmentRequested,
                ),
                timestamp,
                documentId,
                caseDraftId,
            );

        this.insertAuditLog('case_draft', caseDraftId, 'complaint_fields_extracted', {
            documentId,
            extractorVersion: extraction.extractorVersion,
            appliedFields,
            preservedManualFields: Array.from(manualFields).sort(),
            warnings: extraction.warnings.map(warning => warning.code),
        });

        const detail = this.getEmailDetail(existing.email_id);
        if (!detail) throw new Error('Draft email record not found after Complaint extraction');
        return detail;
    }

    refreshCaseDraftValidation(caseDraftId: string): EmailDetail {
        const detail = this.getDraftDetail(caseDraftId);
        if (!detail?.caseDraft) throw new Error('Case draft not found');
        if (['filing_in_progress', 'filing_prepared', 'filed_successfully', 'archived'].includes(
            detail.caseDraft.status,
        )) {
            return detail;
        }

        const issues = detail.caseDraft.validationIssues;
        const hasErrors = issues.some(issue => issue.severity === 'error');
        const status: CaseDraftStatus = hasErrors
            ? 'validation_failed'
            : issues.length
                ? 'needs_review'
                : 'ready_to_file';
        const validationStatus: ValidationStatus = hasErrors
            ? 'failed'
            : issues.length
                ? 'warnings'
                : 'passed';
        if (
            detail.caseDraft.status !== status ||
            detail.caseDraft.validationStatus !== validationStatus
        ) {
            const timestamp = nowIso();
            this.db
                .prepare(`
                    UPDATE case_drafts
                    SET status = ?, validation_status = ?, updated_at = ?
                    WHERE id = ?
                `)
                .run(status, validationStatus, timestamp, caseDraftId);
            this.insertAuditLog('case_draft', caseDraftId, 'draft_validation_refreshed', {
                status,
                validationStatus,
                issueCount: issues.length,
            });
        }

        return this.getDraftDetail(caseDraftId) ?? detail;
    }

    createCaseDraft(emailId: string, parsed: ParsedEmailInfo): string {
        const parsedJson = toJson(parsed);
        this.ensurePlaintiffCandidateFromParsed(parsed);

        const existing = this.db
            .prepare(`
                SELECT id, extracted_data_json, normalized_data_json
                FROM case_drafts
                WHERE email_id = ?
                ORDER BY created_at DESC
                LIMIT 1
            `)
            .get(emailId) as
            | {
                id: string;
                extracted_data_json: string | null;
                normalized_data_json: string | null;
            }
            | undefined;

        if (existing) {
            this.ensureExpectedDocuments(emailId, existing.id, parsed);

            const previousExtracted = this.safeJson(existing.extracted_data_json);
            const previousNormalized = this.safeJson(existing.normalized_data_json);
            const nextNormalized = {
                ...parsed,
                filingData: draftFilingData(parsed),
            } as Record<string, unknown>;
            const oldExtractedObject = previousExtracted && typeof previousExtracted === 'object'
                ? previousExtracted as Record<string, unknown>
                : {};
            const oldNormalizedObject = previousNormalized && typeof previousNormalized === 'object'
                ? previousNormalized as Record<string, unknown>
                : {};

            for (const field of EDITABLE_DRAFT_FIELDS) {
                if (
                    editableDraftValue(oldNormalizedObject[field]) !==
                    editableDraftValue(oldExtractedObject[field])
                ) {
                    nextNormalized[field] = oldNormalizedObject[field] ?? null;
                }
            }
            if (
                oldNormalizedObject.filingData &&
                typeof oldNormalizedObject.filingData === 'object' &&
                !Array.isArray(oldNormalizedObject.filingData)
            ) {
                nextNormalized.filingData = oldNormalizedObject.filingData;
            }
            if (
                oldNormalizedObject.complaintExtraction &&
                typeof oldNormalizedObject.complaintExtraction === 'object' &&
                !Array.isArray(oldNormalizedObject.complaintExtraction)
            ) {
                nextNormalized.complaintExtraction = oldNormalizedObject.complaintExtraction;
            }
            if (Array.isArray(oldNormalizedObject.manualFilingFields)) {
                nextNormalized.manualFilingFields = oldNormalizedObject.manualFilingFields;
            }
            const nextNormalizedJson = toJson(nextNormalized);

            if (
                existing.extracted_data_json === parsedJson &&
                existing.normalized_data_json === nextNormalizedJson
            ) {
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
                .run(parsedJson, nextNormalizedJson, timestamp, existing.id);
            this.insertAuditLog('case_draft', existing.id, 'draft_reparsed', {
                preservedManualFields: EDITABLE_DRAFT_FIELDS.filter(field =>
                    editableDraftValue(oldNormalizedObject[field]) !==
                    editableDraftValue(oldExtractedObject[field]),
                ),
            });
            return existing.id;
        }

        const id = randomUUID();
        const timestamp = nowIso();
        const workflowMode = process.env.WORKFLOW_MODE || 'review_before_submission';
        const normalizedJson = toJson({
            ...parsed,
            filingData: draftFilingData(parsed),
        });

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
            .run(id, emailId, workflowMode, parsedJson, normalizedJson, timestamp, timestamp);

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
                SELECT
                    status,
                    validation_status,
                    filing_status,
                    normalized_data_json,
                    reviewer_notes
                FROM case_drafts
                WHERE id = ?
            `)
            .get(caseDraftId) as
            | {
                status: CaseDraftStatus;
                validation_status: ValidationStatus;
                filing_status: FilingStatus;
                normalized_data_json: string | null;
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
            const detail = this.getDraftDetail(caseDraftId);
            const issues = detail?.caseDraft?.validationIssues ??
                validateDraftData(this.safeJson(existing.normalized_data_json));
            const blockingIssue = issues.find(issue => issue.severity === 'error');
            if (blockingIssue) {
                throw new Error(`Cannot approve draft: ${blockingIssue.message}`);
            }
            next.status = 'ready_to_file';
            next.validationStatus = issues.length ? 'warnings' : 'passed';
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

    private assignPrimaryComplaint(
        caseDraftId: string,
        documentId: string,
        documentType: string | null | undefined,
        filename: string | null | undefined,
    ): boolean {
        if (!isComplaintDocument(documentType, filename)) return false;
        const timestamp = nowIso();
        const result = this.db
            .prepare(`
                UPDATE case_drafts
                SET primary_document_id = ?, updated_at = ?
                WHERE id = ?
                  AND primary_document_id IS NULL
            `)
            .run(documentId, timestamp, caseDraftId);
        const assigned = Number(result.changes ?? 0) > 0;
        if (assigned) {
            this.db
                .prepare(`
                    UPDATE document_records
                    SET required_for_filing = 1, updated_at = ?
                    WHERE id = ?
                `)
                .run(timestamp, documentId);
            this.insertAuditLog('case_draft', caseDraftId, 'primary_complaint_assigned', {
                documentId,
            });
        }
        return assigned;
    }

    addDocument(input: StoredDocumentInput): string {
        const id = randomUUID();
        const timestamp = nowIso();
        const filingFilename = input.currentFilename || input.originalFilename;
        const suggestedFilingType = suggestMiFileFilingType(
            input.documentType,
            filingFilename,
        );
        const filingRelation = suggestedFilingRelation(input.documentType, filingFilename);
        const requiredForFiling = requiredForStandardPackage(
            input.documentType,
            filingFilename,
        );
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
                    filing_name,
                    filing_type,
                    filing_type_source,
                    filing_relation,
                    filing_relation_source,
                    required_for_filing,
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
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                filingFilename ?? null,
                suggestedFilingType,
                suggestedFilingType ? 'suggested' : null,
                filingRelation,
                'suggested',
                requiredForFiling ? 1 : 0,
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

        if (input.caseDraftId) {
            this.assignPrimaryComplaint(
                input.caseDraftId,
                id,
                input.documentType,
                input.currentFilename || input.originalFilename,
            );
        }

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

    private filingJobFromRow(row: Record<string, unknown>): FilingJobView {
        const executionLog = this.safeJson(String(row.execution_log || ''));
        const payload = this.safeJson(String(row.payload_json || ''));
        const result = this.safeJson(String(row.result_json || ''));
        return {
            id: String(row.id),
            caseDraftId: String(row.case_draft_id),
            emailId: row.email_id ? String(row.email_id) : null,
            subject: row.subject ? String(row.subject) : null,
            attemptNumber: Number(row.attempt_number || 0),
            mode: row.mode === 'submit' ? 'submit' : 'prepare',
            status: String(row.status) as FilingJobStatus,
            triggerSource: row.trigger_source ? String(row.trigger_source) : null,
            checkpoint: row.checkpoint ? String(row.checkpoint) : null,
            externalBundleId: row.external_bundle_id ? String(row.external_bundle_id) : null,
            temporaryCaseNumber: row.temporary_case_number
                ? String(row.temporary_case_number)
                : null,
            startedAt: row.started_at ? String(row.started_at) : null,
            finishedAt: row.finished_at ? String(row.finished_at) : null,
            durationMs: row.duration_ms === null || row.duration_ms === undefined
                ? null
                : Number(row.duration_ms),
            errorCode: row.error_code ? String(row.error_code) : null,
            errorMessage: row.error_message ? String(row.error_message) : null,
            executionLog: Array.isArray(executionLog)
                ? executionLog as FilingJobLogEntry[]
                : [],
            payload: payload && typeof payload === 'object'
                ? payload as FilingPayload
                : null,
            result: result && typeof result === 'object' && !Array.isArray(result)
                ? result as Record<string, unknown>
                : null,
            debugArtifactPath: row.debug_artifact_path
                ? String(row.debug_artifact_path)
                : null,
            triggeredBy: row.triggered_by ? String(row.triggered_by) : null,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
        };
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
                    filing_name,
                    filing_type,
                    filing_type_source,
                    filing_relation,
                    filing_relation_source,
                    required_for_filing,
                    upload_source,
                    status,
                    error_message,
                    metadata_json,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 'application/pdf', NULL, ?, ?, ?, ?, ?, 'suggested', ?, 'parsed_email', ?, ?, ?, ?, ?)
            `);

            for (const doc of expectedDocuments) {
                const status: DocumentStatus = doc.downloadUrl ? 'pending' : 'not_downloadable';
                const errorMessage = doc.downloadUrl ? null : 'No downloadable file in source email';
                const filingType = suggestMiFileFilingType(
                    doc.documentType,
                    doc.documentName,
                );
                const filingRelation = suggestedFilingRelation(
                    doc.documentType,
                    doc.documentName,
                );
                const requiredForFiling = requiredForStandardPackage(
                    doc.documentType,
                    doc.documentName,
                );

                insert.run(
                    randomUUID(),
                    emailId,
                    caseDraftId,
                    doc.documentName ?? null,
                    doc.downloadUrl ?? null,
                    doc.documentType ?? null,
                    doc.documentName ?? null,
                    filingType,
                    filingType ? 'suggested' : null,
                    filingRelation,
                    requiredForFiling ? 1 : 0,
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
