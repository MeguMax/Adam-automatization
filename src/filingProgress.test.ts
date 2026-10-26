import test from 'node:test';
import assert from 'node:assert/strict';
import type { FilingJobView } from './database';
import { filingPreparationProgress } from './filingProgress';

const job = (status = 'running', executionLog: any[] = [], result: any = null) => ({
    status, checkpoint: 'document_upload', payload: { documents: [0, 1, 2].map(index => ({ id: 'doc-' + index, filename: `File-${index}.pdf` })) },
    executionLog, result,
} as FilingJobView);
const log = (documentId: string, event: string, message = '') => ({ details: { documentId, event }, message });

test('MiFILE progress counts distinct verified PDF IDs, not repeated log entries', () => {
    const progress = filingPreparationProgress(job('running', [log('doc-0', 'document_ready'), log('doc-0', 'document_ready'), log('doc-1', 'document_started')]));
    assert.equal(progress.uploaded, 1); assert.equal(progress.total, 3);
    assert.equal(progress.currentFilename, 'File-1.pdf');
    assert.deepEqual(progress.documents.map(item => item.status), ['uploaded', 'uploading', 'pending']);
});

test('a failed/uncertain MiFILE upload remains distinguishable from files not attempted', () => {
    const failed = filingPreparationProgress(job('reconciliation_required', [log('doc-0', 'document_ready'), log('doc-1', 'document_failed', 'Server refused the PDF')]));
    assert.equal(failed.uploaded, 1);
    assert.equal(failed.documents[1].error, 'Server refused the PDF');
    assert.equal(failed.documents[2].status, 'pending');
    const interrupted = filingPreparationProgress(job('reconciliation_required', [log('doc-1', 'document_started')]));
    assert.equal(interrupted.documents[1].status, 'uncertain');
});

test('saving uncertainty never becomes Prepared just because all PDF uploads completed', () => {
    const progress = filingPreparationProgress(job('reconciliation_required', [0, 1, 2].map(index => log('doc-' + index, 'document_ready'))));
    assert.equal(progress.uploaded, 3);
    assert.match(progress.stage, /Check the partial bundle/);
});

test('historical jobs do not fabricate per-file verification from a saved count or a manual confirmation', () => {
    const old = filingPreparationProgress(job('prepared', [], { uploadedDocuments: 3 }));
    assert.equal(old.uploaded, 3); assert.equal(old.evidence, 'reported');
    const reconciled = filingPreparationProgress(job('prepared', [], { reconciliationResolution: 'found' }));
    assert.equal(reconciled.uploaded, null); assert.equal(reconciled.evidence, 'unavailable');
    const prepared = filingPreparationProgress(job('prepared', [], { documentManifest: [{ documentId: 'doc-1' }] }));
    assert.equal(prepared.uploaded, 1); assert.equal(prepared.evidence, 'verified');
    const confirmed = filingPreparationProgress(job('prepared', [], { reconciliationVerifiedDocumentIds: ['doc-0','doc-1','doc-2'] }));
    assert.equal(confirmed.uploaded,3); assert.equal(confirmed.evidence,'confirmed');
});
