import { extractComplaintPdf, CURRENT_COMPLAINT_EXTRACTOR_VERSION, type ComplaintExtractionResult } from './complaintExtractor';
import type { WorkflowDatabase, EmailDetail } from './database';
import { applyLibraryForms } from './formLibrary';
import { recognizeDocumentPdf } from './documentRecognition';
import type { DocumentRecognition } from './documentRecognition';
import { createHash } from 'node:crypto';

const running = new WeakMap<WorkflowDatabase, Map<string, Promise<EmailDetail>>>();
const recognizing = new WeakMap<WorkflowDatabase, Map<string, Promise<EmailDetail>>>();

export function ensureDraftDocumentRecognitions(db:WorkflowDatabase,draftId:string,download?: (url:string)=>Promise<Buffer>):Promise<EmailDetail> {
    let jobs=recognizing.get(db);
    if(!jobs){jobs=new Map();recognizing.set(db,jobs);}
    const active=jobs.get(draftId);if(active)return active;
    const job=(async()=>{
        const initial=db.getDraftDetail(draftId);
        if(!initial?.caseDraft)throw new Error('Draft not found');
        const editable=(detail:EmailDetail)=>detail.caseDraft?.filingEligible && ['not_started','failed'].includes(detail.caseDraft.filingStatus) &&
            ['parsed','needs_review','validation_failed','ready_to_file','filing_failed'].includes(detail.caseDraft.status);
        if(!editable(initial) || initial.email.processingStatus==='processing')return initial;
        const root=JSON.parse(initial.caseDraft.normalizedDataJson || '{}');
        if(Date.parse(root.supportingRecognitionRetryAt || '')>Date.now())return initial;
        try {
            for(const candidate of initial.documents.filter(doc=>doc.requiredForFiling && doc.uploadSource!=='form_library' && doc.oneDriveUrl &&
                ['uploaded','downloaded','replaced'].includes(doc.status) && ((doc.recognition?.recognitionVersion || 0)<2 ||
                    !/^[a-f0-9]{64}$/.test(doc.recognition?.contentHash || ''))).slice(0,20)) {
                const current=db.getDraftDetail(draftId);
                if(!current || !editable(current))return current || initial;
                const document=current.documents.find(doc=>doc.id===candidate.id && doc.requiredForFiling && doc.oneDriveUrl &&
                    ['uploaded','downloaded','replaced'].includes(doc.status));
                if(!document)continue;
                const version=db.getComplaintSourceVersion(document.id);
                const content=await (download || (async url=>{
                    const drive=await import('./oneDriveClient'),item=await drive.resolveSharedDriveItem(url);
                    return drive.downloadDriveItemBuffer(item.driveId,item.itemId);
                }))(document.oneDriveUrl!);
                const recognition=await recognizeDocumentPdf(content,document.originalFilename || document.currentFilename || 'document.pdf');
                const latest=db.getDraftDetail(draftId);
                if(!latest || !editable(latest))return latest || initial;
                if(db.getComplaintSourceVersion(document.id)!==version)continue;
                if (latest.caseDraft?.primaryDocumentId === document.id &&
                    latest.caseDraft.complaintExtraction?.contentHash !== recognition.contentHash) {
                    if(recognition.role === 'complaint' && recognition.source !== 'conflict') {
                        await ensureDraftComplaintExtraction(db,draftId,{documentId:document.id,content,
                            recognition,expectedSourceVersion:version});
                    } else {
                        db.recordDocumentRecognition(document.id,recognition);
                        db.recordComplaintExtractionFailure(draftId,document.id,
                            new Error('The primary PDF changed and cannot be confirmed as a Complaint. Review or replace it before preparation.'));
                    }
                } else db.recordDocumentRecognition(document.id,recognition);
            }
            db.recordDocumentRecognitionRefresh(draftId);
        }catch(error){if(editable(db.getDraftDetail(draftId) || initial))db.recordDocumentRecognitionRefresh(draftId,error);}
        return db.refreshCaseDraftValidation(draftId);
    })();
    jobs.set(draftId,job);void job.finally(()=>jobs!.delete(draftId)).catch(()=>{});return job;
}

/** Reuse a single extraction per Draft; always merge into the latest persisted manual edits. */
export function ensureDraftComplaintExtraction(db: WorkflowDatabase, draftId: string, options: {
    documentId?: string;
    content?: Buffer;
    force?: boolean;
    extract?: (content: Buffer) => Promise<ComplaintExtractionResult>;
    download?: (url: string) => Promise<Buffer>;
    recognition?: DocumentRecognition;
    expectedSourceVersion?: string | null;
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
        if (options.expectedSourceVersion !== undefined && options.expectedSourceVersion !== sourceVersion) return initial;
        const sourcePin = source.recognition?.contentHash;
        const expectedHash = options.content ? createHash('sha256').update(options.content).digest('hex') : sourcePin;
        const root = JSON.parse(draft.normalizedDataJson || '{}');
        if (root.sourceKind !== 'new_filing_intake') return initial;
        const previous = root.complaintAutoExtraction;
        const same = previous?.sourceVersion === sourceVersion && previous?.extractorVersion === CURRENT_COMPLAINT_EXTRACTOR_VERSION &&
            (!expectedHash || previous?.contentHash === expectedHash);
        if (!options.force) {
            if (draft.complaintExtraction?.documentId === source.id && draft.complaintExtraction.extractorVersion === CURRENT_COMPLAINT_EXTRACTOR_VERSION &&
                draft.complaintExtraction.contentHash && (!expectedHash || draft.complaintExtraction.contentHash === expectedHash) &&
                !root.complaintExtractionError && (!previous || same)) return initial;
            if (same && (previous.attempts >= 3 || Date.parse(previous.nextRetryAt || '') > Date.now())) return initial;
        }
        const attempts = same ? Number(previous.attempts || 0) + 1 : 1;
        const state = { documentId: source.id, sourceVersion, contentHash:expectedHash, extractorVersion: CURRENT_COMPLAINT_EXTRACTOR_VERSION,
            attempts, startedAt: new Date().toISOString() };
        db.setComplaintAutoExtractionState(draftId, { ...state, status: 'running' });
        try {
            if (options.recognition) db.recordDocumentRecognition(source.id,options.recognition);
            const content = options.content || await (options.download || (async url => {
                const { downloadDriveItemBuffer, resolveSharedDriveItem } = await import('./oneDriveClient');
                const item = await resolveSharedDriveItem(url);
                return downloadDriveItemBuffer(item.driveId, item.itemId);
            }))(source.oneDriveUrl!);
            const contentHash = createHash('sha256').update(content).digest('hex');
            state.contentHash = contentHash;
            const extraction = {...await (options.extract || extractComplaintPdf)(content),contentHash};
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
            const latestPin = latest.documents.find(doc => doc.id === source.id)?.recognition?.contentHash;
            if (latestPin && latestPin !== sourcePin && latestPin !== contentHash) {
                throw new Error('The Complaint contents changed during extraction. Read the current PDF again before preparation.');
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
                try {
                    const detail = await ensureDraftComplaintExtraction(db, draftId);
                    if (!signal.aborted && detail.caseDraft?.filingEligible &&
                        ['not_started','failed'].includes(detail.caseDraft.filingStatus)) await applyLibraryForms(db, draftId);
                } catch (error) {
                    console.error('Automatic Complaint extraction for Draft ' + draftId + ':', (error as Error).message);
                }
            }
            for (const draftId of db.listPendingDocumentRecognitions()) {
                if(signal.aborted)break;
                try{await ensureDraftDocumentRecognitions(db,draftId);}
                catch(error){console.error('Automatic supporting-document recognition:',(error as Error).message);}
            }
        } catch (error) { console.error('Automatic Complaint extraction:', (error as Error).message); }
        if (!signal.aborted) await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 10_000);
            signal.addEventListener('abort', finish, {once:true});
        });
    }
}
