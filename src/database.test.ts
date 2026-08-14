import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkflowDatabase } from './database';
import type { ParsedEmailInfo } from './emailProcessor';

test('processing reports keep the active Plaintiff mapping available on repeat syncs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-db-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const receivedAt = '2026-07-12T11:02:22.000Z';
        const email = db.registerEmail({
            id: 'source-message-id',
            subject: 'YOUR R&D TEST',
            receivedDateTime: receivedAt,
            from: { emailAddress: { address: 'ajd.attorney@yourrnd.com' } },
            body: { content: '<p>Test MiFILE email</p>' },
        });
        const parsed: ParsedEmailInfo = {
            isMiFile: true,
            courtName: '25th District Court',
            caseNumber: '26-01659-LT',
            caseTitle: '3 TOWER MANAGEMENT V ELUMLE REED',
            plaintiff: null,
            defendant: null,
            bundleNumber: '12266387',
            filerName: 'Adam Devlin',
            filedAt: '5/20/2026',
            filedDocuments: [{
                documentType: 'Summons',
                status: 'Filed',
                comments: null,
                downloadUrl: 'https://mifile.example/document/1',
            }],
            fileTypeByAttachmentId: {},
        };
        db.createCaseDraft(email.id, parsed);
        const mapping = db.savePlaintiffMapping({
            fullName: '3 TOWER MANAGEMENT',
            shortName: '3TM',
            isActive: true,
        });
        const report = {
            originalSubject: 'YOUR R&D TEST',
            originalSender: 'ajd.attorney@yourrnd.com',
            originalReceivedAt: receivedAt,
            caseNumber: parsed.caseNumber,
            caseTitle: parsed.caseTitle,
            documents: [{
                fileName: '25th 26-01659-LT 3_TOWER_MANAGEMENT_V_ELUMLE_REED Summons-ABCDE.pdf',
                oneDriveUrl: 'https://onedrive.example/shared/1',
            }],
            reportMessageId: 'processing-report-id',
        };

        const firstResult = db.applyProcessingReport(report);
        assert.equal(firstResult.applied, true);
        assert.equal(firstResult.targetEmailId, email.id);
        assert.equal(firstResult.plaintiffMappingId, mapping.id);
        assert.equal(
            db.getDraftDetail(firstResult.caseDraftId!)?.caseDraft?.status,
            'validation_failed',
        );

        const repeatedResult = db.applyProcessingReport(report);
        assert.equal(repeatedResult.applied, false);
        assert.equal(repeatedResult.targetEmailId, email.id);
        assert.equal(repeatedResult.plaintiffMappingId, mapping.id);
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Plaintiff mapping seed imports active short names idempotently', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mapping-seed-'));
    const source = new WorkflowDatabase(path.join(tempDir, 'source.sqlite'));
    const target = new WorkflowDatabase(path.join(tempDir, 'target.sqlite'));

    try {
        source.savePlaintiffMapping({
            fullName: '3 TOWER MANAGEMENT',
            shortName: '3TM',
            isActive: true,
        });
        const seed = source.exportPlaintiffMappingSeed();
        assert.equal(seed.mappings.length, 1);

        assert.equal(target.importPlaintiffMappingSeed(seed), 1);
        assert.equal(target.importPlaintiffMappingSeed(seed), 0);
        assert.deepEqual(target.exportPlaintiffMappingSeed().mappings, seed.mappings);
    } finally {
        source.close();
        target.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('clearing a short Plaintiff name preserves the Plaintiff record as a candidate', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mapping-clear-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const mapping = db.savePlaintiffMapping({
            fullName: '3 TOWER MANAGEMENT',
            shortName: '3TM',
            isActive: true,
        });

        const cleared = db.clearPlaintiffShortName(mapping.id);
        assert.equal(cleared.fullName, '3 TOWER MANAGEMENT');
        assert.equal(cleared.shortName, '');
        assert.equal(cleared.isActive, false);
        assert.equal(cleared.status, 'needs_short_name');
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('saving a blank short Plaintiff name keeps the full name without an active mapping', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mapping-blank-short-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const mapping = db.savePlaintiffMapping({
            fullName: '3 TOWER MANAGEMENT',
            shortName: '3TM',
            isActive: true,
        });

        const updated = db.savePlaintiffMapping({
            id: mapping.id,
            fullName: '3 TOWER MANAGEMENT LLC',
            shortName: '',
            isActive: true,
        });
        assert.equal(updated.fullName, '3 TOWER MANAGEMENT LLC');
        assert.equal(updated.shortName, '');
        assert.equal(updated.isActive, false);
        assert.equal(updated.status, 'needs_short_name');
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('queue history supports server-side pagination, search, status, and date filters', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-queue-history-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        for (let index = 1; index <= 12; index += 1) {
            const email = db.registerEmail({
                id: `history-message-${index}`,
                subject: index === 6 ? 'Needle filing' : `History filing ${index}`,
                receivedDateTime: `2026-07-${String(index).padStart(2, '0')}T12:00:00.000Z`,
                from: { emailAddress: { address: 'court@example.com' } },
                body: { content: '<p>History</p>' },
            });
            if (index === 6) {
                db.markEmailFailed(email.id, 'Test failure');
            } else {
                db.markEmailProcessed(email.id);
            }
        }

        const firstPage = db.listQueue({ scope: 'all', page: 1, pageSize: 10 });
        assert.equal(firstPage.totalItems, 12);
        assert.equal(firstPage.totalPages, 2);
        assert.equal(firstPage.items.length, 10);
        assert.equal(firstPage.items[0].subject, 'History filing 12');

        const secondPage = db.listQueue({ scope: 'all', page: 2, pageSize: 10 });
        assert.equal(secondPage.items.length, 2);

        const searched = db.listQueue({ scope: 'all', search: 'needle' });
        assert.equal(searched.totalItems, 1);
        assert.equal(searched.items[0].processingStatus, 'failed');

        const failed = db.listQueue({ scope: 'all', status: 'failed' });
        assert.equal(failed.totalItems, 1);

        const dated = db.listQueue({
            scope: 'all',
            dateFrom: '2026-07-05T00:00:00.000Z',
            dateTo: '2026-07-08T00:00:00.000Z',
        });
        assert.equal(dated.totalItems, 3);
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('deleting an email removes database records and keeps a tombstone without touching OneDrive', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-delete-email-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'delete-message-id',
            subject: 'Delete me',
            receivedDateTime: '2026-01-10T12:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Delete test</p>' },
        });
        const parsed: ParsedEmailInfo = {
            isMiFile: true,
            courtName: '25th District Court',
            caseNumber: '26-00001-LT',
            caseTitle: 'PLAINTIFF V DEFENDANT',
            plaintiff: 'PLAINTIFF',
            defendant: 'DEFENDANT',
            bundleNumber: null,
            filerName: null,
            filedAt: null,
            filedDocuments: [],
            fileTypeByAttachmentId: {},
        };
        const caseDraftId = db.createCaseDraft(email.id, parsed);
        db.addDocument({
            emailId: email.id,
            caseDraftId,
            currentFilename: 'document.pdf',
            oneDriveUrl: 'https://onedrive.example/document',
            uploadSource: 'test',
            status: 'uploaded',
        });
        db.markEmailProcessed(email.id);

        const result = db.deleteEmailRecord(email.id);
        assert.equal(result.emailRecords, 1);
        assert.equal(result.caseDrafts, 1);
        assert.equal(result.documentRecords, 1);
        assert.equal(result.oneDriveFilesDeleted, 0);
        assert.equal(db.getEmailDetail(email.id), null);
        assert.equal(db.isEmailDeleted('delete-message-id'), true);
        assert.equal(db.listQueue({ scope: 'all' }).totalItems, 0);
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('period cleanup removes only terminal records and protects active retries', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-period-cleanup-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    const register = (id: string) => db.registerEmail({
        id,
        subject: id,
        receivedDateTime: '2026-01-10T12:00:00.000Z',
        from: { emailAddress: { address: 'court@example.com' } },
        body: { content: '<p>Cleanup test</p>' },
    });

    try {
        const processed = register('old-processed');
        db.markEmailProcessed(processed.id);

        const ignored = register('old-ignored');
        db.markEmailIgnored(ignored.id, 'Not relevant');

        const failedWithRetry = register('old-failed-retrying');
        db.markEmailFailed(failedWithRetry.id, 'Download failed');
        db.addDocument({
            emailId: failedWithRetry.id,
            sourceUrl: 'https://mifile.example/document',
            uploadSource: 'test',
            status: 'retrying',
        });

        const stillNew = register('old-still-new');
        const cutoff = '2026-06-01T00:00:00.000Z';

        assert.equal(db.countDeletableEmailsBefore(cutoff), 2);
        const result = db.purgeEmailRecordsBefore(cutoff);
        assert.equal(result.emailRecords, 2);
        assert.equal(result.oneDriveFilesDeleted, 0);
        assert.equal(db.getEmailDetail(processed.id), null);
        assert.equal(db.getEmailDetail(ignored.id), null);
        assert.notEqual(db.getEmailDetail(failedWithRetry.id), null);
        assert.notEqual(db.getEmailDetail(stillNew.id), null);
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('document failure logs are preserved across automatic retry cycles', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-failure-log-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'failure-log-message',
            subject: 'Failure log test',
            receivedDateTime: '2026-07-23T12:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Failure log</p>' },
        });
        const documentId = db.addDocument({
            emailId: email.id,
            sourceUrl: 'https://mifile.example/document',
            uploadSource: 'mifile',
            status: 'failed',
            errorMessage: 'HTTP 503',
            metadata: {
                attemptLog: [{
                    attempt: 1,
                    at: '2026-07-23T12:01:00.000Z',
                    stage: 'download',
                    message: 'HTTP 503',
                }],
            },
        });

        db.completeDocumentRetryFailure({
            documentId,
            reason: 'Downloaded content failed PDF validation',
            downloadAttempts: 1,
            metadata: {
                attemptLog: [{
                    attempt: 1,
                    at: '2026-07-23T12:16:00.000Z',
                    stage: 'validation',
                    message: 'Downloaded content failed PDF validation',
                }],
            },
        });

        const detail = db.getEmailDetail(email.id);
        assert.equal(detail?.documents[0].failureLog.length, 2);
        assert.deepEqual(
            detail?.documents[0].failureLog.map(entry => entry.stage),
            ['download', 'validation'],
        );
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('manual email retries are discoverable even when the source message is outside the recent inbox window', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-email-retry-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'old-message-for-retry',
            subject: 'Old filing notification',
            receivedDateTime: '2025-01-10T12:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Old filing</p>' },
        });
        db.markEmailProcessed(email.id);
        db.queueEmailRetry(email.id, 'Manual admin retry');

        const expectedRetry = [{
            emailId: email.id,
            externalMessageId: 'old-message-for-retry',
            subject: 'Old filing notification',
            sender: 'court@example.com',
            receivedAt: '2025-01-10T12:00:00.000Z',
        }];
        assert.deepEqual(db.listQueuedEmailRetries(), expectedRetry);
        assert.deepEqual(db.listPendingEmails(), expectedRetry);

        db.markEmailProcessing(email.id);
        assert.throws(
            () => db.queueEmailRetry(email.id),
            /processing email cannot be queued again/,
        );
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('admin-synced new emails remain discoverable outside the recent Outlook window', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-persistent-email-queue-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'old-admin-synced-message',
            subject: 'MiFILE - Document Filed 26-01340-LT',
            receivedDateTime: '2026-07-30T12:46:18.000Z',
            from: { emailAddress: { address: 'info@truefiling.com' } },
            body: { content: '<p>Filing</p>' },
        });
        db.createCaseDraft(email.id, {
            isMiFile: true,
            courtName: 'District Court',
            caseNumber: '26-01340-LT',
            caseTitle: '3 TOWER MANAGEMENT V BARNES',
            plaintiff: '3 TOWER MANAGEMENT',
            defendant: 'BARNES',
            bundleNumber: null,
            filerName: null,
            filedAt: '2026-07-30',
            filedDocuments: [{
                documentName: 'Summons',
                documentType: 'Summons',
                status: 'Filed',
                comments: null,
                downloadUrl: 'https://mifile.example/document/old',
            }],
            fileTypeByAttachmentId: {},
        });
        db.registerEmail({
            id: 'old-non-court-message',
            subject: 'Are you beach-bound? Follow these tips.',
            receivedDateTime: '2026-07-31T14:47:25.000Z',
            from: { emailAddress: { address: 'redcross@example.com' } },
        });

        assert.deepEqual(db.listQueuedEmailRetries(), []);
        assert.deepEqual(db.listPendingEmails(), [{
            emailId: email.id,
            externalMessageId: 'old-admin-synced-message',
            subject: 'MiFILE - Document Filed 26-01340-LT',
            sender: 'info@truefiling.com',
            receivedAt: '2026-07-30T12:46:18.000Z',
        }]);

        db.markEmailProcessed(email.id);
        assert.deepEqual(db.listPendingEmails(), []);
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('failed emails expose pending documents to the retry worker with stored draft data', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-pending-retry-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'pending-retry-message',
            subject: 'MiFILE - Document Filed 26-02763-LT',
            receivedDateTime: '2026-07-14T18:29:57.000Z',
            from: { emailAddress: { address: 'info@truefiling.com' } },
            body: { content: '<p>Filing</p>' },
        });
        const parsed: ParsedEmailInfo = {
            isMiFile: true,
            courtName: 'District Court',
            caseNumber: '26-02763-LT',
            caseTitle: 'DELTA SQUARE APARTMENTS V JOHNSON',
            plaintiff: 'DELTA SQUARE APARTMENTS',
            defendant: 'JOHNSON',
            bundleNumber: null,
            filerName: null,
            filedAt: '2026-07-14',
            filedDocuments: [{
                documentName: 'Complaint',
                documentType: 'Complaint',
                status: 'Filed',
                comments: null,
                downloadUrl: 'https://mifile.example/document/pending',
            }],
            fileTypeByAttachmentId: {},
        };
        const caseDraftId = db.createCaseDraft(email.id, parsed);
        db.markEmailFailed(email.id, 'One document is still pending', 'failed');

        const retries = db.claimDueDocumentRetries(5);
        assert.equal(retries.length, 1);
        assert.equal(retries[0].caseDraftId, caseDraftId);
        assert.equal(retries[0].sourceUrl, 'https://mifile.example/document/pending');
        assert.equal(retries[0].receivedAt, '2026-07-14T18:29:57.000Z');
        assert.equal(retries[0].parsedEmail?.caseNumber, '26-02763-LT');
        assert.equal(retries[0].retrySource, 'automatic');
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('worker startup immediately recovers document retries interrupted by a restart', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-interrupted-retry-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'interrupted-retry-message',
            subject: 'Interrupted retry',
            receivedDateTime: '2026-08-12T10:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
        });
        const documentId = db.addDocument({
            emailId: email.id,
            sourceUrl: 'https://mifile.example/interrupted',
            uploadSource: 'mifile',
            status: 'retry_queued',
        });
        assert.equal(db.claimDueDocumentRetries(1)[0].documentId, documentId);

        assert.equal(db.recoverInterruptedDocumentRetries(), 1);
        const recovered = db.claimDueDocumentRetries(1);
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].documentId, documentId);
        assert.equal(recovered[0].retrySource, 'automatic');
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('electronic MiFILE forms stop retrying and no longer leave the email failed', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-electronic-form-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'electronic-form-message',
            subject: 'MiFILE - Document Filed 2026-224248-CH',
            receivedDateTime: '2026-07-14T15:53:40.000Z',
            from: { emailAddress: { address: 'info@truefiling.com' } },
        });
        const parsed: ParsedEmailInfo = {
            isMiFile: true,
            courtName: 'MI Oakland County 6th Circuit Court',
            caseNumber: '2026-224248-CH',
            caseTitle: 'MADISON V HP FORECLOSURE SOLUTION',
            plaintiff: 'MADISON',
            defendant: 'HP FORECLOSURE SOLUTION',
            bundleNumber: '12805264',
            filerName: 'Adam Devlin',
            filedAt: '2026-07-14',
            filedDocuments: [],
            fileTypeByAttachmentId: {},
        };
        const caseDraftId = db.createCaseDraft(email.id, parsed);
        const documentId = db.addDocument({
            emailId: email.id,
            caseDraftId,
            sourceUrl: 'https://mifile.courts.michigan.gov/filing/electronic-form',
            documentType: 'ISI_ADD_COUNSEL_FORM_DT',
            uploadSource: 'mifile',
            status: 'failed',
        });
        db.markEmailFailed(email.id, 'HTTP 400', 'failed');
        db.queueDocumentRetry(documentId);
        assert.equal(db.claimDueDocumentRetries(1)[0].documentId, documentId);
        db.markEmailRetrying(email.id);

        db.completeDocumentRetryNotDownloadable({
            documentId,
            reason: 'MiFILE returned structured form data instead of a PDF',
            downloadAttempts: 1,
            metadata: {
                notDownloadable: true,
                attemptLog: [{
                    attempt: 1,
                    at: '2026-08-12T12:00:00.000Z',
                    stage: 'download',
                    message: 'MiFILE returned structured form data instead of a PDF',
                }],
            },
        });
        db.refreshEmailAfterDocumentRetries(email.id, caseDraftId);

        const detail = db.getEmailDetail(email.id);
        assert.equal(detail?.email.processingStatus, 'processed');
        assert.equal(detail?.caseDraft?.status, 'needs_review');
        assert.equal(detail?.caseDraft?.validationStatus, 'warnings');
        assert.equal(detail?.documents[0].status, 'not_downloadable');
        assert.equal(detail?.documents[0].nextRetryAt, null);
        assert.match(detail?.documents[0].errorMessage ?? '', /structured form data/);
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('global activity history supports related-email search, record filters, and pagination', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-activity-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'activity-message-id',
            subject: 'Activity Needle Filing',
            receivedDateTime: '2026-07-24T10:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Activity</p>' },
        });
        db.addDocument({
            emailId: email.id,
            sourceUrl: 'https://mifile.example/activity-document',
            uploadSource: 'test',
            status: 'failed',
            errorMessage: 'Activity failure',
        });
        db.markEmailFailed(email.id, 'Activity failure');

        const searched = db.listActivity({ search: 'needle' });
        assert.ok(searched.totalItems >= 2);
        assert.ok(searched.items.every(item => item.emailId === email.id));

        const documents = db.listActivity({ entityType: 'document_record' });
        assert.equal(documents.totalItems, 1);
        assert.equal(documents.items[0].subject, 'Activity Needle Filing');

        const firstPage = db.listActivity({ page: 1, pageSize: 10 });
        assert.equal(firstPage.page, 1);
        assert.ok(firstPage.totalItems >= 3);
        assert.ok(firstPage.items.some(item => item.action === 'email_processing_failed'));
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('draft workspace supports listing, editable fields, validation, and reparse preservation', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-draft-workspace-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'draft-workspace-message',
            subject: 'Draft workspace filing',
            receivedDateTime: '2026-07-24T12:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Draft workspace</p>' },
        });
        const parsed: ParsedEmailInfo = {
            isMiFile: true,
            courtName: '25th District Court',
            caseNumber: '26-01000-LT',
            caseTitle: 'ORIGINAL PLAINTIFF V ORIGINAL DEFENDANT',
            plaintiff: null,
            defendant: null,
            bundleNumber: '1000',
            filerName: 'Adam Devlin',
            submitterName: 'Adam Devlin',
            filedAt: '7/24/2026',
            filedDocuments: [],
            fileTypeByAttachmentId: {},
        };
        const draftId = db.createCaseDraft(email.id, parsed);
        const documentId = db.addDocument({
            emailId: email.id,
            caseDraftId: draftId,
            currentFilename: 'Complaint.pdf',
            oneDriveUrl: 'https://onedrive.example/draft-workspace',
            mimeType: 'application/pdf',
            documentType: 'Complaint for Possession Only',
            uploadSource: 'test',
            status: 'uploaded',
        });
        db.applyComplaintExtraction(draftId, documentId, {
            extractorVersion: 1,
            formType: 'NONPAYMENT OF RENT',
            pageCount: 1,
            textHash: 'test-complaint-hash',
            data: {},
            fieldConfidence: {},
            warnings: [],
        });

        const page = db.listDrafts({ search: '26-01000', pageSize: 10 });
        assert.equal(page.totalItems, 1);
        assert.equal(page.items[0].draftId, draftId);
        assert.equal(page.items[0].viewableDocumentCount, 1);
        assert.equal(page.items[0].plaintiff, 'ORIGINAL PLAINTIFF');

        const initial = db.getDraftDetail(draftId);
        assert.equal(initial?.caseDraft?.editableData.defendant, 'ORIGINAL DEFENDANT');
        assert.equal(initial?.caseDraft?.fieldSources.defendant, 'derived');
        assert.equal(
            initial?.caseDraft?.filingData.caseType,
            'LT - Landlord-Tenant Summary Proceedings',
        );
        assert.equal(initial?.caseDraft?.filingData.action, 'Initiate a new case');
        assert.equal(initial?.caseDraft?.filingData.defendants.length, 1);
        assert.equal(initial?.caseDraft?.primaryDocumentId, documentId);
        assert.equal(initial?.documents[0].isPrimary, true);

        const updated = db.updateCaseDraft(
            draftId,
            {
                courtName: 'Updated District Court',
                plaintiff: 'MANUAL PLAINTIFF',
                defendant: 'MANUAL DEFENDANT',
            },
            'Ready for legal review',
            {
                ...initial?.caseDraft?.filingData,
                relatedCivilAction: 'none',
                plaintiff: {
                    ...initial?.caseDraft?.filingData.plaintiff,
                    partyType: 'entity',
                    entityName: 'MANUAL PLAINTIFF',
                },
                defendants: [
                    {
                        ...initial?.caseDraft?.filingData.defendants[0],
                        partyType: 'person',
                        displayName: null,
                        firstName: 'MANUAL',
                        lastName: 'DEFENDANT',
                        address1: '100 Main Street',
                        city: 'Wayne',
                        state: 'MI',
                        postalCode: '48184',
                    },
                    {
                        id: 'defendant-2',
                        partyType: 'person',
                        firstName: 'SECOND',
                        lastName: 'DEFENDANT',
                        address1: '100 Main Street',
                        city: 'Wayne',
                        state: 'MI',
                        postalCode: '48184',
                    },
                ],
            },
            [{
                id: documentId,
                filingName: 'Story Summons',
                filingType: 'Summons, Landlord-Tenant/Land Contract',
                filingSequence: 1,
                requiredForFiling: true,
            }],
        );
        assert.equal(updated.caseDraft?.editableData.courtName, 'Updated District Court');
        assert.equal(updated.caseDraft?.fieldSources.courtName, 'manual');
        assert.equal(updated.caseDraft?.reviewerNotes, 'Ready for legal review');
        assert.equal(updated.caseDraft?.status, 'needs_review');
        assert.equal(updated.caseDraft?.validationStatus, 'failed');
        assert.ok(updated.caseDraft?.validationIssues.some(issue =>
            issue.message.includes('missing Advice')));
        assert.equal(updated.caseDraft?.filingData.defendants.length, 2);
        assert.equal(updated.caseDraft?.editableData.defendant, 'MANUAL DEFENDANT, SECOND DEFENDANT');
        assert.equal(updated.documents[0].filingName, 'Story Summons');
        assert.equal(
            updated.documents[0].filingType,
            'Summons, Landlord-Tenant/Land Contract',
        );
        assert.equal(updated.documents[0].filingTypeSource, 'manual');
        assert.equal(updated.documents[0].requiredForFiling, true);

        db.createCaseDraft(email.id, {
            ...parsed,
            courtName: 'Court name from reparsed email',
            bundleNumber: '2000',
        });
        const reparsed = db.getDraftDetail(draftId);
        assert.equal(reparsed?.caseDraft?.editableData.courtName, 'Updated District Court');
        assert.equal(reparsed?.caseDraft?.editableData.bundleNumber, '2000');
        assert.equal(reparsed?.caseDraft?.fieldSources.courtName, 'manual');
        assert.equal(reparsed?.caseDraft?.filingData.defendants.length, 2);
        assert.equal(reparsed?.caseDraft?.filingData.relatedCivilAction, 'none');

        assert.deepEqual(db.getDocumentAccess(documentId), {
            id: documentId,
            oneDriveUrl: 'https://onedrive.example/draft-workspace',
            currentFilename: 'Complaint.pdf',
            mimeType: 'application/pdf',
        });
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('Complaint extraction becomes authoritative while preserving later manual filing edits', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-complaint-source-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'complaint-source-message',
            subject: 'Complaint source filing',
            receivedDateTime: '2026-08-12T10:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Complaint source</p>' },
        });
        const draftId = db.createCaseDraft(email.id, {
            isMiFile: true,
            courtName: '25th District Court',
            caseNumber: 'EMAIL-CASE-LT',
            caseTitle: 'EMAIL PLAINTIFF V EMAIL DEFENDANT',
            plaintiff: null,
            defendant: null,
            bundleNumber: null,
            filerName: 'Email Filer',
            filedAt: null,
            filedDocuments: [],
            fileTypeByAttachmentId: {},
        });
        const complaintId = db.addDocument({
            emailId: email.id,
            caseDraftId: draftId,
            currentFilename: 'Complaint.pdf',
            oneDriveUrl: 'https://onedrive.example/complaint',
            documentType: 'Complaint for Possession Only',
            mimeType: 'application/pdf',
            uploadSource: 'test',
            status: 'uploaded',
        });
        const adviceId = db.addDocument({
            emailId: email.id,
            caseDraftId: draftId,
            currentFilename: 'Advice.pdf',
            oneDriveUrl: 'https://onedrive.example/advice',
            documentType: 'Advice of Rights and Information (Landlord-Tenant)',
            mimeType: 'application/pdf',
            uploadSource: 'test',
            status: 'uploaded',
        });

        assert.throws(
            () => db.updateCaseDraft(draftId, {}, undefined, undefined, [], adviceId),
            /Only a Complaint can be selected/,
        );

        const first = db.applyComplaintExtraction(draftId, complaintId, {
            extractorVersion: 1,
            formType: 'NONPAYMENT OF RENT',
            pageCount: 1,
            textHash: 'first-hash',
            data: {
                courtDistrict: '25',
                caseNumber: '26-02000-LT',
                plaintiff: {
                    displayName: 'Complaint Property LLC',
                    entityName: 'Complaint Property LLC',
                },
                defendants: [{
                    displayName: 'Taylor Tenant',
                    firstName: 'Taylor',
                    lastName: 'Tenant',
                    address1: '10 Main Street',
                    city: 'Lincoln Park',
                    state: 'MI',
                    postalCode: '48146',
                }],
                attorney: {
                    displayName: 'Adam Devlin',
                    firstName: 'Adam',
                    lastName: 'Devlin',
                    barNumber: 'P72877',
                },
                includeAllOtherOccupants: true,
            },
            fieldConfidence: { plaintiff: 'high', defendants: 'high' },
            warnings: [{
                code: 'related_action_review',
                message: 'Confirm the related civil action answer.',
            }],
        });

        assert.equal(first.caseDraft?.primaryDocumentId, complaintId);
        assert.equal(first.caseDraft?.editableData.caseNumber, '26-02000-LT');
        assert.equal(first.caseDraft?.filingData.plaintiff.entityName, 'Complaint Property LLC');
        assert.equal(first.caseDraft?.filingData.defendants[0].address1, '10 Main Street');
        assert.equal(first.caseDraft?.filingFieldSources.plaintiff, 'complaint');
        assert.equal(first.caseDraft?.fieldSources.caseNumber, 'complaint');
        assert.equal(
            first.documents.find(document => document.id === complaintId)?.requiredForFiling,
            true,
        );
        assert.equal(
            first.documents.find(document => document.id === adviceId)?.requiredForFiling,
            true,
        );

        const manualFiling = {
            ...first.caseDraft?.filingData,
            relatedCivilAction: 'none' as const,
            plaintiff: {
                ...first.caseDraft?.filingData.plaintiff,
                entityName: 'Reviewed Plaintiff LLC',
                displayName: 'Reviewed Plaintiff LLC',
            },
        };
        db.updateCaseDraft(draftId, {}, undefined, manualFiling);

        const second = db.applyComplaintExtraction(draftId, complaintId, {
            extractorVersion: 1,
            formType: 'NONPAYMENT OF RENT',
            pageCount: 1,
            textHash: 'second-hash',
            data: {
                caseNumber: '26-02001-LT',
                plaintiff: {
                    displayName: 'Changed PDF Plaintiff LLC',
                    entityName: 'Changed PDF Plaintiff LLC',
                },
                defendants: [{
                    displayName: 'Updated Tenant',
                    firstName: 'Updated',
                    lastName: 'Tenant',
                }],
            },
            fieldConfidence: { plaintiff: 'high', defendants: 'high' },
            warnings: [],
        });

        assert.equal(second.caseDraft?.filingData.plaintiff.entityName, 'Reviewed Plaintiff LLC');
        assert.equal(second.caseDraft?.filingData.defendants[0].firstName, 'Updated');
        assert.equal(second.caseDraft?.editableData.caseNumber, '26-02001-LT');
        assert.equal(second.caseDraft?.filingFieldSources.plaintiff, 'manual');
        assert.equal(second.caseDraft?.filingFieldSources.defendants, 'complaint');
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('complete first-hearing nonpayment packages become ready with Complaint-driven filing rules', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-standard-package-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'standard-package-message',
            subject: 'Standard nonpayment package',
            receivedDateTime: '2026-08-14T10:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Standard package</p>' },
        });
        const draftId = db.createCaseDraft(email.id, {
            isMiFile: true,
            courtName: '25th District Court',
            caseNumber: '26-03000-LT',
            caseTitle: 'EXAMPLE PROPERTY LLC V TAYLOR TENANT',
            plaintiff: 'EXAMPLE PROPERTY LLC',
            defendant: 'TAYLOR TENANT',
            bundleNumber: null,
            filerName: 'Adam Devlin',
            filedAt: null,
            filedDocuments: [],
            fileTypeByAttachmentId: {},
        });

        const addUploadedDocument = (documentType: string, filename: string) => db.addDocument({
            emailId: email.id,
            caseDraftId: draftId,
            currentFilename: filename,
            oneDriveUrl: `https://onedrive.example/${encodeURIComponent(filename)}`,
            documentType,
            mimeType: 'application/pdf',
            uploadSource: 'test',
            status: 'uploaded',
        });
        const complaintId = addUploadedDocument(
            'Complaint for Possession Only',
            'Complaint.pdf',
        );
        addUploadedDocument(
            'Advice of Rights and Information (Landlord-Tenant)',
            'Advice.pdf',
        );
        addUploadedDocument('Local Rental and Housing Information', 'Local.pdf');
        addUploadedDocument(
            'Request for Court Mailing and Record (Landlord-Tenant)',
            'Request.pdf',
        );
        addUploadedDocument(
            'Summons, Landlord-Tenant/Land Contract',
            'Summons.pdf',
        );
        const connectedId = addUploadedDocument('CONNECTED FILING', 'Demand.pdf');

        db.applyComplaintExtraction(draftId, complaintId, {
            extractorVersion: 2,
            formType: 'NONPAYMENT OF RENT',
            pageCount: 1,
            textHash: 'standard-package-hash',
            data: {
                courtDistrict: '25',
                caseNumber: '26-03000-LT',
                plaintiff: {
                    displayName: 'Example Property LLC',
                    entityName: 'Example Property LLC',
                },
                defendants: [{
                    displayName: 'Taylor Tenant',
                    firstName: 'Taylor',
                    lastName: 'Tenant',
                    address1: '100 Main Street',
                    city: 'Lincoln Park',
                    state: 'MI',
                    postalCode: '48146',
                }],
                attorney: {
                    displayName: 'Adam Devlin',
                    firstName: 'Adam',
                    lastName: 'Devlin',
                    barNumber: 'P72877',
                },
                includeAllOtherOccupants: true,
                relatedCivilAction: 'none',
                moneyJudgmentRequested: true,
                claimAmount: '1471.01',
                mailingRequested: true,
            },
            fieldConfidence: {
                plaintiff: 'high',
                defendants: 'high',
                relatedCivilAction: 'high',
                moneyJudgmentRequested: 'high',
                claimAmount: 'high',
            },
            warnings: [],
        });

        const ready = db.refreshCaseDraftValidation(draftId);
        assert.equal(ready.caseDraft?.status, 'ready_to_file');
        assert.equal(ready.caseDraft?.validationStatus, 'passed');
        assert.deepEqual(ready.caseDraft?.validationIssues, []);
        assert.equal(ready.caseDraft?.filingData.moneyJudgmentRequested, true);
        assert.equal(ready.caseDraft?.filingData.claimAmount, '1471.01');

        const complaint = ready.documents.find(document => document.id === complaintId);
        assert.equal(
            complaint?.filingType,
            'Complaint for Possession and Supplemental Money Judgment (Fee Varies)',
        );
        assert.equal(complaint?.filingTypeSource, 'complaint');
        assert.equal(complaint?.filingRelation, 'separate');

        const connected = ready.documents.find(document => document.id === connectedId);
        assert.equal(connected?.filingType, 'Other');
        assert.equal(connected?.filingRelation, 'connected_to_complaint');
        assert.equal(connected?.filingSequence, null);
        assert.ok(ready.documents.every(document => document.requiredForFiling));
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('paragraph 10 selects possession-only filing and keeps Other as a separate filing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-possession-only-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'possession-only-message',
            subject: 'Possession-only nonpayment package',
            receivedDateTime: '2026-08-14T11:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Possession only</p>' },
        });
        const draftId = db.createCaseDraft(email.id, {
            isMiFile: true,
            courtName: '25th District Court',
            caseNumber: '26-03001-LT',
            caseTitle: 'EXAMPLE PROPERTY LLC V MORGAN TENANT',
            plaintiff: 'EXAMPLE PROPERTY LLC',
            defendant: 'MORGAN TENANT',
            bundleNumber: null,
            filerName: 'Adam Devlin',
            filedAt: null,
            filedDocuments: [],
            fileTypeByAttachmentId: {},
        });
        const addDocument = (documentType: string, filename: string) => db.addDocument({
            emailId: email.id,
            caseDraftId: draftId,
            currentFilename: filename,
            oneDriveUrl: `https://onedrive.example/${encodeURIComponent(filename)}`,
            documentType,
            mimeType: 'application/pdf',
            uploadSource: 'test',
            status: 'uploaded',
        });
        const complaintId = addDocument(
            'Complaint for Possession and Supplemental Money Judgment (Fee Varies)',
            'Complaint.pdf',
        );
        addDocument('Advice of Rights and Information (Landlord-Tenant)', 'Advice.pdf');
        addDocument('Local Rental and Housing Information', 'Local.pdf');
        addDocument('Request for Court Mailing and Record (Landlord-Tenant)', 'Request.pdf');
        addDocument('Summons, Landlord-Tenant/Land Contract', 'Summons.pdf');
        const otherId = addDocument('Other', 'Seven-Day Notice.pdf');

        db.applyComplaintExtraction(draftId, complaintId, {
            extractorVersion: 2,
            formType: 'NONPAYMENT OF RENT',
            pageCount: 1,
            textHash: 'possession-only-hash',
            data: {
                courtDistrict: '25',
                caseNumber: '26-03001-LT',
                plaintiff: {
                    displayName: 'Example Property LLC',
                    entityName: 'Example Property LLC',
                },
                defendants: [{
                    displayName: 'Morgan Tenant',
                    firstName: 'Morgan',
                    lastName: 'Tenant',
                    address1: '101 Main Street',
                    city: 'Lincoln Park',
                    state: 'MI',
                    postalCode: '48146',
                }],
                relatedCivilAction: 'none',
                moneyJudgmentRequested: false,
                claimAmount: '0.00',
                mailingRequested: true,
            },
            fieldConfidence: {},
            warnings: [],
        });

        const ready = db.refreshCaseDraftValidation(draftId);
        assert.equal(ready.caseDraft?.status, 'ready_to_file');
        assert.equal(ready.caseDraft?.filingData.claimAmount, '0.00');
        assert.equal(
            ready.documents.find(document => document.id === complaintId)?.filingType,
            'Complaint for Possession Only',
        );
        assert.equal(
            ready.documents.find(document => document.id === otherId)?.filingRelation,
            'separate',
        );
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('duplicate, missing, and unknown documents block automatic nonpayment filing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-unsafe-package-'));
    const db = new WorkflowDatabase(path.join(tempDir, 'workflow.sqlite'));

    try {
        const email = db.registerEmail({
            id: 'unsafe-package-message',
            subject: 'Unsafe nonpayment package',
            receivedDateTime: '2026-08-14T12:00:00.000Z',
            from: { emailAddress: { address: 'court@example.com' } },
            body: { content: '<p>Unsafe package</p>' },
        });
        const draftId = db.createCaseDraft(email.id, {
            isMiFile: true,
            courtName: '25th District Court',
            caseNumber: '26-03002-LT',
            caseTitle: 'EXAMPLE PROPERTY LLC V CASEY TENANT',
            plaintiff: 'EXAMPLE PROPERTY LLC',
            defendant: 'CASEY TENANT',
            bundleNumber: null,
            filerName: 'Adam Devlin',
            filedAt: null,
            filedDocuments: [],
            fileTypeByAttachmentId: {},
        });
        const addDocument = (documentType: string, filename: string) => db.addDocument({
            emailId: email.id,
            caseDraftId: draftId,
            currentFilename: filename,
            oneDriveUrl: `https://onedrive.example/${encodeURIComponent(filename)}`,
            documentType,
            mimeType: 'application/pdf',
            uploadSource: 'test',
            status: 'uploaded',
        });
        const complaintId = addDocument('Complaint for Possession Only', 'Complaint.pdf');
        addDocument('Advice of Rights and Information (Landlord-Tenant)', 'Advice.pdf');
        addDocument('Local Rental and Housing Information', 'Local.pdf');
        addDocument('Request for Court Mailing and Record (Landlord-Tenant)', 'Request.pdf');
        addDocument('Summons, Landlord-Tenant/Land Contract', 'Summons.pdf');
        addDocument('Summons, Landlord-Tenant/Land Contract', 'Duplicate Summons.pdf');
        addDocument('Supporting Exhibit', 'Unexpected Exhibit.pdf');

        db.applyComplaintExtraction(draftId, complaintId, {
            extractorVersion: 2,
            formType: 'NONPAYMENT OF RENT',
            pageCount: 1,
            textHash: 'unsafe-package-hash',
            data: {
                courtDistrict: '25',
                caseNumber: '26-03002-LT',
                plaintiff: {
                    displayName: 'Example Property LLC',
                    entityName: 'Example Property LLC',
                },
                defendants: [{
                    displayName: 'Casey Tenant',
                    firstName: 'Casey',
                    lastName: 'Tenant',
                    address1: '102 Main Street',
                    city: 'Lincoln Park',
                    state: 'MI',
                    postalCode: '48146',
                }],
                relatedCivilAction: 'none',
                moneyJudgmentRequested: false,
                claimAmount: '0.00',
                mailingRequested: true,
            },
            fieldConfidence: {},
            warnings: [],
        });

        const blocked = db.refreshCaseDraftValidation(draftId);
        const messages = blocked.caseDraft?.validationIssues.map(issue => issue.message) ?? [];
        assert.equal(blocked.caseDraft?.status, 'validation_failed');
        assert.ok(messages.some(message => message.includes('2 Summons documents')));
        assert.ok(messages.some(message => message.includes('at least one demand')));
        assert.ok(messages.some(message => message.includes('is not recognized')));
        assert.throws(
            () => db.reviewCaseDraft(draftId, 'approve'),
            /Cannot approve draft/,
        );
    } finally {
        db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
