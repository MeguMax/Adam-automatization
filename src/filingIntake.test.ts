import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowDatabase } from './database';
import { buildFilingIntake, intakeFileName, intakeSenderAllowed, isFilingIntakeSubject } from './filingIntake';
import { emailAttachmentSourceId, emailAttachmentSourceName } from './emailAttachmentSource';
import { downloadIntakeDocuments } from './filingIntakeDownload';
import { processFilingIntake } from './filingIntakeWorker';
import type { ComplaintExtractionResult } from './complaintExtractor';
import { testPdfFixture } from './testPdfFixture';

const message = {
    id: 'new-intake-message', internetMessageId: '<new-intake@example.com>',
    subject: 'NEW LT FILING - Example Property v Morgan Tenant',
    from: { emailAddress: { address: 'ajd@devlinlawpllc.com' } },
    receivedDateTime: '2026-09-08T10:00:00Z',
};
const attachment = (name: string, id = name) => ({
    id, name, contentType: 'application/pdf', size: 100, isInline: false,
});
const pdf = testPdfFixture();
const extraction: ComplaintExtractionResult = {
    extractorVersion: 2, formType: 'NONPAYMENT OF RENT', pageCount: 1, textHash: 'fixture',
    data: {
        courtDistrict: '25',
        plaintiff: { displayName: 'Example Property LLC', entityName: 'Example Property LLC',
            address1: '201 Main Street', city: 'Lincoln Park', state: 'MI', postalCode: '48146' },
        defendants: [{ displayName: 'Morgan Tenant', firstName: 'Morgan', lastName: 'Tenant',
            address1: '101 Main Street', city: 'Lincoln Park', state: 'MI', postalCode: '48146' }],
        relatedCivilAction: 'none', moneyJudgmentRequested: false, claimAmount: '0.00', mailingRequested: true,
    }, fieldConfidence: {}, warnings: [],
};

function fixture(names: string[]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filing-intake-'));
    const db = new WorkflowDatabase(path.join(directory, 'test.sqlite'));
    const email = db.registerEmail(message);
    const parsed = buildFilingIntake(message, names.map(name => attachment(name)));
    const draftId = db.createCaseDraft(email.id, parsed);
    const uploaded: string[] = [];
    const dependencies = {
        download: (input: typeof parsed) => downloadIntakeDocuments(input, {
            download: async () => pdf,
            upload: async (_key: string, name: string) => {
                uploaded.push(name);
                return { driveId: 'drive', itemId: name, fileName: name, webUrl: `https://onedrive.example/${encodeURIComponent(name)}` };
            },
            wait: async () => {},
        }),
        extract: async () => extraction,
    };
    return { db, email, parsed, draftId, uploaded, dependencies, close: () => {
        db.close(); fs.rmSync(directory, { recursive: true, force: true });
    } };
}

test('intake uses an explicit subject and authorized sender; replies and court notifications are excluded', () => {
    assert.equal(isFilingIntakeSubject(message.subject), true);
    assert.equal(isFilingIntakeSubject('new lt filing'), true);
    for (const subject of ['Re: NEW LT FILING - Test', 'FW: NEW LT FILING', 'NEW LT FILINGS', 'MiFILE - Document Filed']) {
        assert.equal(isFilingIntakeSubject(subject), false);
    }
    assert.equal(intakeSenderAllowed(message, {}), true);
    assert.equal(intakeSenderAllowed({ from: { emailAddress: { address: 'unknown@example.com' } } }, {}), false);
    assert.equal(intakeSenderAllowed(message, { FILING_INTAKE_ALLOWED_SENDERS: 'somebody@example.com' }), false);
});

test('attachment identity distinguishes duplicate names and keeps encoded punctuation intact', () => {
    const parsed = buildFilingIntake(message, [attachment('Complaint ?1.pdf', 'a/+=1'), attachment('Complaint ?1.pdf', 'b/+=2')]);
    assert.equal(parsed.isMiFile, false);
    assert.equal(parsed.intake?.issues.length, 1);
    const [first, second] = parsed.filedDocuments;
    assert.notEqual(first.downloadUrl, second.downloadUrl);
    assert.equal(emailAttachmentSourceId(first.downloadUrl), 'a/+=1');
    assert.equal(emailAttachmentSourceName(first.downloadUrl), 'Complaint ?1.pdf');
    assert.notEqual(intakeFileName(first.documentName!, first.downloadUrl!), intakeFileName(second.documentName!, second.downloadUrl!));
});

test('unsupported attachments remain visible as review issues; inline images are ignored', () => {
    const parsed = buildFilingIntake(message, [
        { ...attachment('case.zip'), contentType: 'application/zip' },
        { ...attachment('logo.png'), contentType: 'image/png', isInline: true },
    ]);
    assert.equal(parsed.filedDocuments.length, 0);
    assert.equal(parsed.intake?.issues.length, 2);
    assert.match(parsed.intake!.issues[0], /case.zip/);
});

test('upload retry uses the same file identity after an uncertain upload and does not redownload the PDF', async () => {
    const parsed = buildFilingIntake(message, [attachment('Complaint.pdf')]);
    const names: string[] = [];
    let downloads = 0;
    const result = await downloadIntakeDocuments(parsed, {
        download: async () => { downloads++; return pdf; },
        upload: async (_key, name) => {
            names.push(name);
            if (names.length === 1) throw new Error('Connection lost after upload');
            return { driveId: 'd', itemId: 'i', fileName: name, webUrl: 'https://onedrive.example/file' };
        }, wait: async () => {},
    });
    assert.equal(downloads, 1);
    assert.equal(names[0], names[1]);
    assert.equal(result.downloaded.length, 1);
    assert.equal(result.failures.length, 0);
});

test('invalid PDFs are not uploaded and include the validation error for the admin', async () => {
    const result = await downloadIntakeDocuments(buildFilingIntake(message, [attachment('Complaint.pdf')]), {
        download: async () => Buffer.from('<html>Login required</html>'),
        upload: async () => { throw new Error('Must not upload'); }, wait: async () => {},
    });
    assert.equal(result.notificationFiles.length, 0);
    assert.match(result.failures[0].reason, /HTML/);
    assert.equal(result.failures[0].attemptLog?.[0].stage, 'validation');
});

test('intake creates one Draft, extracts the Complaint, and reprocessing does not duplicate uploaded documents', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf', 'Local.pdf', 'Summons.pdf', 'Request.pdf', 'Other.pdf']);
    try {
        const first = await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        assert.equal(first.documents.length, 6);
        assert.ok(first.documents.every(document => document.status === 'uploaded'));
        assert.equal(first.caseDraft?.filingEligible, true);
        assert.equal(first.caseDraft?.filingData.plaintiff.displayName, 'Example Property LLC');
        assert.equal(first.documents.find(document => document.packageRole === 'complaint')?.filingType, 'Complaint for Possession Only');
        assert.equal(f.db.createCaseDraft(f.email.id, f.parsed), f.draftId);
        await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        assert.equal(f.uploaded.length, 6);
        assert.equal(f.db.getDraftDetail(f.draftId)?.documents.length, 6);
    } finally { f.close(); }
});

test('a failed attachment does not block the remaining package and can be retried independently', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf', 'Summons.pdf']);
    try {
        const detail = await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, {
            ...f.dependencies,
            download: async input => {
                if (input.filedDocuments[0].documentName === 'Advice.pdf') throw new Error('Graph unavailable');
                return f.dependencies.download(input);
            },
        });
        assert.equal(detail.documents.filter(document => document.status === 'uploaded').length, 2);
        const failed = detail.documents.find(document => document.status === 'failed')!;
        assert.match(failed.errorMessage!, /Graph unavailable/);
        assert.ok(failed.nextRetryAt);
        assert.equal(detail.caseDraft?.status, 'validation_failed');
        await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        assert.equal(f.uploaded.length, 3);
        const recovered = f.db.getDraftDetail(f.draftId)!;
        assert.equal(recovered.documents.length, 3);
        assert.notEqual(recovered.caseDraft?.status, 'ready_to_file', 'missing required documents must still block filing');
    } finally { f.close(); }
});

test('Complaint extraction failure is visible and does not turn a successfully uploaded file into a download failure', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf']);
    try {
        const detail = await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, {
            ...f.dependencies, extract: async () => { throw new Error('Password-protected PDF'); },
        });
        assert.ok(detail.documents.every(document => document.status === 'uploaded'));
        assert.ok(detail.caseDraft?.validationIssues.some(issue => issue.message.includes('Password-protected')));
        const complaint = detail.documents.find(document => document.packageRole === 'complaint')!;
        f.db.applyComplaintExtraction(f.draftId, complaint.id, extraction);
        assert.ok(!f.db.getDraftDetail(f.draftId)?.caseDraft?.validationIssues.some(issue => issue.message.includes('Password-protected')));
    } finally { f.close(); }
});

test('queued intake emails are recovered even after they leave the most recent inbox page', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-backlog-'));
    const db = new WorkflowDatabase(path.join(directory, 'test.sqlite'));
    try {
        db.registerEmail(message);
        assert.equal(db.listPendingEmails()[0]?.externalMessageId, message.id);
    } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('attachment discovery failures back off and remain manually retryable before a Draft exists', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-discovery-'));
    const db = new WorkflowDatabase(path.join(directory, 'test.sqlite'));
    try {
        const email = db.registerEmail(message);
        db.markEmailProcessing(email.id);
        db.scheduleEmailDiscoveryRetry(email.id, new Error('Graph response was truncated'));
        const detail = db.getEmailDetail(email.id)!;
        assert.equal(detail.email.processingStatus, 'failed');
        assert.match(detail.email.processingError!, /Graph response/);
        assert.ok(detail.email.nextRetryAt);
        assert.equal(db.shouldSkipEmail(message.id), true);
        assert.equal(db.listPendingEmails().length, 0);
        db.queueEmailRetry(email.id);
        assert.equal(db.shouldSkipEmail(message.id), false);
        assert.equal(db.listPendingEmails().length, 1);
        assert.equal(db.getEmailDetail(email.id)!.email.nextRetryAt, null);
    } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a validated intake queues only preparation, locks account changes, and cannot be queued twice', async () => {
    const f = fixture(['Complaint.pdf', 'Advice.pdf', 'Local.pdf', 'Summons.pdf', 'Request.pdf', 'Other.pdf']);
    try {
        await processFilingIntake(f.db, f.email.id, f.draftId, f.parsed, f.dependencies);
        const detail = f.db.updateCaseDraft(f.draftId, { courtName: '25th District Court' });
        assert.equal(detail.caseDraft?.filingData.caseType, 'LT - Landlord-Tenant Summary Proceedings');
        f.db.reviewCaseDraft(f.draftId, 'approve');
        assert.throws(() => f.db.queueFilingJob(f.draftId, 'submit' as any), /Final court submission is disabled/);
        const job = f.db.queueFilingJob(f.draftId);
        assert.equal(job.mode, 'prepare');
        assert.equal(job.payload?.documents.length, 6);
        assert.equal(job.payload?.filingData.claimAmount, '0.00');
        assert.equal(job.payload?.documents[0].packageRole, 'complaint');
        assert.throws(() => f.db.queueFilingJob(f.draftId), /active MiFILE job/);
        assert.throws(() => f.db.saveMiFileAccountSetting('not-used'), /Wait for queued/);
        assert.throws(() => f.db.updateCaseDraft(f.draftId, { courtName: 'Another court' }), /locked/);
        assert.throws(() => f.db.applyComplaintExtraction(f.draftId, job.payload!.documents[0].id, extraction), /locked/);
        assert.throws(() => f.db.reviewCaseDraft(f.draftId, 'reject'), /Resolve or complete/);
        assert.equal(f.db.claimNextFilingJob()?.id, job.id);
        assert.throws(() => f.db.queueEmailRetry(f.email.id), /locked/);
    } finally { f.close(); }
});
