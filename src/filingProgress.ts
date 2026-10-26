import type { FilingJobView } from './database';

export interface FilingPreparationProgress {
    stage: string;
    total: number;
    uploaded: number | null;
    evidence: 'verified' | 'confirmed' | 'reported' | 'unavailable';
    currentFilename: string | null;
    documents: Array<{ documentId: string; filename: string; status: 'pending' | 'uploading' | 'uploaded' | 'failed' | 'uncertain'; error: string | null }>;
}

export function filingPreparationProgress(job: Pick<FilingJobView, 'payload' | 'executionLog' | 'status' | 'checkpoint' | 'result'>): FilingPreparationProgress {
    const documents: FilingPreparationProgress['documents'] = (Array.isArray(job.payload?.documents) ? job.payload.documents : []).map(document => ({
        documentId: document.id, filename: document.filename, status: 'pending', error: null,
    }));
    let active: string | null = null;
    for (const entry of job.executionLog) {
        const document = documents.find(item => item.documentId === entry.details?.documentId);
        if (!document) continue;
        if (entry.details?.event === 'document_started') { document.status = 'uploading'; active = document.documentId; }
        if (entry.details?.event === 'document_ready') { document.status = 'uploaded'; document.error = null; if (active === document.documentId) active = null; }
        if (entry.details?.event === 'document_failed') { document.status = 'failed'; document.error = entry.message; active = document.documentId; }
    }
    // Do not invent per-file proof for historical jobs that only stored a total.
    const manifest = job.result?.documentManifest;
    if (job.status === 'prepared' && Array.isArray(manifest)) {
        for (const document of documents) if (manifest.some(item => item?.documentId === document.documentId)) {
            document.status = 'uploaded'; document.error = null;
        }
    }
    const checked = job.result?.reconciliationVerifiedDocumentIds;
    const confirmed = job.status === 'prepared' && documents.length > 0 && Array.isArray(checked) &&
        checked.length === documents.length && documents.every(document => checked.includes(document.documentId));
    if (confirmed) for (const document of documents) { document.status = 'uploaded'; document.error = null; }
    if (['failed', 'reconciliation_required'].includes(job.status)) {
        for (const document of documents) if (document.status === 'uploading') document.status = 'uncertain';
    }
    const stages: Record<string, string> = { materialize_documents: 'Reading PDFs from OneDrive', account_preflight: 'Checking account',
        starting: 'Starting preparation', login: 'Signing in to MiFILE', select_filing: 'Selecting court', case_form: 'Completing case details',
        document_upload: 'Uploading PDFs', save_progress: 'Saving to Unsubmitted', verify_saved_bundle: 'Checking the saved bundle', saved_unsubmitted: 'Saved in Unsubmitted' };
    const stage = job.status === 'queued' ? 'Waiting for preparation' : job.status === 'prepared' ? 'Saved in Unsubmitted' :
        job.status === 'reconciliation_required' ? 'Check the partial bundle in MiFILE' : job.status === 'failed' ? 'Preparation stopped' : stages[job.checkpoint || ''] || 'Preparing in MiFILE';
    const known = job.executionLog.some(entry => ['document_started', 'document_ready', 'document_failed'].includes(String(entry.details?.event))) || Array.isArray(manifest);
    let uploaded: number | null = documents.filter(document => document.status === 'uploaded').length;
    let evidence: FilingPreparationProgress['evidence'] = confirmed ? 'confirmed' : 'verified';
    if (!known && !confirmed && (['prepared', 'reconciliation_required'].includes(job.status) ||
        (job.status === 'failed' && ['document_upload','save_progress','verify_saved_bundle','saved_unsubmitted'].includes(job.checkpoint || '')))) {
        const reported = job.result?.uploadedDocuments;
        if (job.status === 'prepared' && typeof reported === 'number' && Number.isInteger(reported) && reported >= 0 && reported <= documents.length) {
            uploaded = reported; evidence = 'reported';
        } else { uploaded = null; evidence = 'unavailable'; }
    }
    return { stage, total: documents.length, uploaded, evidence,
        currentFilename: documents.find(document => document.documentId === active)?.filename || null, documents };
}
