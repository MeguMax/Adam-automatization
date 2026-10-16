import { extractComplaintPdf, CURRENT_COMPLAINT_EXTRACTOR_VERSION, type ComplaintExtractionResult } from './complaintExtractor';
import type { WorkflowDatabase, EmailDetail } from './database';
import { applyLibraryForms } from './formLibrary';

const running = new WeakMap<WorkflowDatabase, Map<string, Promise<EmailDetail>>>();

/** Reuse a single extraction per Draft; always merge into the latest persisted manual edits. */
export function ensureDraftComplaintExtraction(db: WorkflowDatabase, draftId: string, options: {
    documentId?: string;
    content?: Buffer;
    force?: boolean;
    extract?: (content: Buffer) => Promise<ComplaintExtractionResult>;
    download?: (url: string) => Promise<Buffer>;
} = {}): Promise<EmailDetail> {
    let jobs = running.get(db);
    if (!jobs) { jobs = new Map(); running.set(db, jobs); }
    const existing = jobs.get(draftId);
    if (existing) return existing.then(() => ensureDraftComplaintExtraction(db, draftId, options));
    const job = run();
    jobs.set(draftId, job);
    void job.finally(() => { if (jobs!.get(draftId) === job) jobs!.delete(draftId); }).catch(() => {});
    return job;

    async function run(): Promise<EmailDetail> {
        const initial = db.getDraftDetail(draftId);
        if (!initial?.caseDraft) throw new Error('Draft not found');
        const draft = initial.caseDraft;
        if (initial.email.processingStatus === 'processing' && !options.content) return initial;
        if (!draft.filingEligible || !['not_started', 'failed'].includes(draft.filingStatus) ||
            !['parsed', 'needs_review', 'validation_failed', 'ready_to_file', 'filing_failed'].includes(draft.status)) return initial;
        const complaints = initial.documents.filter(doc => doc.packageRole === 'complaint' &&
            doc.recognition?.source !== 'conflict' && doc.oneDriveUrl && ['uploaded', 'replaced', 'downloaded'].includes(doc.status));
        const source = options.documentId ? complaints.find(doc => doc.id === options.documentId) :
            complaints.find(doc => doc.id === draft.primaryDocumentId) || (complaints.length === 1 ? complaints[0] : undefined);
        if (!source || (draft.primaryDocumentId && source.id !== draft.primaryDocumentId)) return initial;
        const sourceVersion = db.getComplaintSourceVersion(source.id);
        const root = JSON.parse(draft.normalizedDataJson || '{}');
        if (root.sourceKind !== 'new_filing_intake') return initial;
        const previous = root.complaintAutoExtraction;
        const same = previous?.sourceVersion === sourceVersion && previous?.extractorVersion === CURRENT_COMPLAINT_EXTRACTOR_VERSION;
        if (!options.force) {
            if (draft.complaintExtraction?.documentId === source.id && draft.complaintExtraction.extractorVersion === CURRENT_COMPLAINT_EXTRACTOR_VERSION &&
                !root.complaintExtractionError && (!previous || same)) return initial;
            if (same && (previous.attempts >= 3 || Date.parse(previous.nextRetryAt || '') > Date.now())) return initial;
        }
        const attempts = same ? Number(previous.attempts || 0) + 1 : 1;
        const state = { documentId: source.id, sourceVersion, extractorVersion: CURRENT_COMPLAINT_EXTRACTOR_VERSION,
            attempts, startedAt: new Date().toISOString() };
        db.setComplaintAutoExtractionState(draftId, { ...state, status: 'running' });
        try {
            const content = options.content || await (options.download || (async url => {
                const { downloadDriveItemBuffer, resolveSharedDriveItem } = await import('./oneDriveClient');
                const item = await resolveSharedDriveItem(url);
                return downloadDriveItemBuffer(item.driveId, item.itemId);
            }))(source.oneDriveUrl!);
            const extraction = await (options.extract || extractComplaintPdf)(content);
            const latest = db.getDraftDetail(draftId);
            // A replacement, removal or primary-source change invalidates work already in flight.
            if (!latest?.caseDraft || db.getComplaintSourceVersion(source.id) !== sourceVersion ||
                !['not_started','failed'].includes(latest.caseDraft.filingStatus) ||
                !['parsed','needs_review','validation_failed','ready_to_file','filing_failed'].includes(latest.caseDraft.status) ||
                (latest.caseDraft.primaryDocumentId && latest.caseDraft.primaryDocumentId !== source.id) ||
                !latest.documents.some(doc => doc.id === source.id && doc.packageRole === 'complaint' && doc.oneDriveUrl && doc.status !== 'retrying')) {
                db.clearStaleComplaintExtractionState(draftId,sourceVersion);
                return latest || initial;
            }
            db.applyComplaintExtraction(draftId, source.id, extraction);
            db.setComplaintAutoExtractionState(draftId, { ...state, status: 'complete', attempts: 0,
                finishedAt: new Date().toISOString() });
            return db.refreshCaseDraftValidation(draftId);
        } catch (error) {
            const latest = db.getDraftDetail(draftId);
            if (db.getComplaintSourceVersion(source.id) === sourceVersion && latest?.documents.some(doc=>doc.id===source.id && doc.packageRole==='complaint') &&
                latest.caseDraft && ['not_started','failed'].includes(latest.caseDraft.filingStatus) &&
                ['parsed','needs_review','validation_failed','ready_to_file','filing_failed'].includes(latest.caseDraft.status) &&
                (!latest.caseDraft?.primaryDocumentId || latest.caseDraft.primaryDocumentId===source.id)) {
                db.recordComplaintExtractionFailure(draftId, source.id, error);
                db.setComplaintAutoExtractionState(draftId, { ...state, status: 'failed',
                    nextRetryAt: attempts < 3 ? new Date(Date.now() + attempts * 5 * 60_000).toISOString() : null });
            } else db.clearStaleComplaintExtractionState(draftId,sourceVersion);
            return db.getDraftDetail(draftId) || initial;
        }
    }
}

export async function runDraftExtractionWorker(db: WorkflowDatabase, signal: AbortSignal): Promise<void> {
    db.recoverInterruptedComplaintExtractions();
    while (!signal.aborted) {
        try {
            for (const draftId of db.listPendingComplaintExtractions(CURRENT_COMPLAINT_EXTRACTOR_VERSION)) {
                if (signal.aborted) break;
                await ensureDraftComplaintExtraction(db, draftId);
                if (!signal.aborted) await applyLibraryForms(db, draftId);
            }
        } catch (error) { console.error('Automatic Complaint extraction:', (error as Error).message); }
        if (!signal.aborted) await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 10_000);
            signal.addEventListener('abort', finish, {once:true});
        });
    }
}
