// Runs real PDF recognition and extraction with local adapters; forbids external writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    forms: { type: 'string' }, output: { type: 'string' },
} });
if (!positionals.length || !values.output) throw new Error('Use --output report.json [--forms directory] file.pdf ...');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-intake-qa-'));
Object.assign(process.env, { TENANT_ID: '11111111-1111-1111-1111-111111111111', CLIENT_ID: 'offline', CLIENT_SECRET: 'offline',
    USER_EMAIL: 'qa@example.com', ONEDRIVE_ROOT_SHARE_URL: 'https://onedrive.example/root', WORKFLOW_DB_PATH: path.join(temporary, 'workflow.sqlite'),
    DRAFT_READY_NOTIFICATIONS_ENABLED: 'false' });
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network access is prohibited during local batch verification'); };
const { WorkflowDatabase } = require('../dist/database');
const { buildFilingIntake } = require('../dist/filingIntake');
const { downloadIntakeDocuments } = require('../dist/filingIntakeDownload');
const { processFilingIntake } = require('../dist/filingIntakeWorker');
const { emailAttachmentSourceName } = require('../dist/emailAttachmentSource');
const { extractComplaintPdf } = require('../dist/complaintExtractor');
const { saveFormPdf } = require('../dist/formLibrary');
const { planFormImports } = require('../dist/courtForms');

(async () => {
    const db = new WorkflowDatabase(process.env.WORKFLOW_DB_PATH);
    try {
        if (values.forms) for (const name of fs.readdirSync(values.forms).filter(name => /\.pdf$/i.test(name))) {
            for (const plan of planFormImports(name, [])) await saveFormPdf(db, {
                ...plan, filename: name, content: fs.readFileSync(path.join(values.forms, name)),
            });
        }
        const files = new Map(positionals.map(filename => [path.basename(filename), fs.readFileSync(filename)]));
        assert.equal(files.size, positionals.length, 'Source filenames must be unique');
        const sourceHashes = new Map([...files].map(([name, buffer]) => [name, createHash('sha256').update(buffer).digest('hex')]));
        const message = { id: 'batch-offline-20261104', subject: 'NEW LT FILING - QA supplied batch verification',
            from: { emailAddress: { address: 'qa@example.com' } } };
        const parsed = buildFilingIntake(message, [...files].map(([name, buffer], index) => ({
            id: String(index), name, size: buffer.length, contentType: 'application/pdf', isInline: false,
        })));
        const email = db.registerEmail(message), packages = db.createCaseDrafts(email.id, parsed);
        const uploads = [];
        const upload = async (key, name, buffer) => {
            uploads.push({ key, name, sha256: createHash('sha256').update(buffer).digest('hex') });
            return { fileName: name, driveId: 'offline', itemId: key + '/' + name,
                webUrl: 'https://onedrive.example/' + key + '/' + encodeURIComponent(name) };
        };
        const dependencies = { extract: extractComplaintPdf, forms: { upload }, deferEmailRefresh: true, download: input => downloadIntakeDocuments(input, {
            download: async document => files.get(emailAttachmentSourceName(document.downloadUrl)), upload, wait: async () => {},
        }) };
        db.markEmailProcessing(email.id);
        const reports = [];
        for (const item of packages) {
            const started = Date.now();
            const detail = await processFilingIntake(db, email.id, item.draftId, item.parsed, dependencies);
            const source = detail.documents.filter(document => document.uploadSource !== 'form_library');
            for (const document of source) {
                assert.equal(document.status, 'uploaded', document.originalFilename);
                assert.equal(document.recognition?.contentHash, sourceHashes.get(document.originalFilename), 'Original source hash must be retained');
            }
            reports.push({ draftId: item.draftId, label: item.parsed.intake.packageLabel || 'Single case',
                storageKey: item.parsed.intake.storageKey, sourceCount: source.length, documentCount: detail.documents.length,
                elapsedMs: Date.now() - started, status: detail.caseDraft.status, fields: detail.caseDraft.filingData,
                courtName: detail.caseDraft.editableData.courtName, extraction: detail.caseDraft.complaintExtraction,
                issues: detail.caseDraft.validationIssues, documents: detail.documents.map(document => ({
                    filename: document.originalFilename, role: document.packageRole, status: document.status,
                    hash: document.recognition?.contentHash, library: Boolean(document.formTemplate), relation: document.filingRelation,
                })) });
            console.log(JSON.stringify({ label: reports[reports.length - 1].label, documents: detail.documents.length,
                issues: detail.caseDraft.validationIssues.map(issue => issue.field), elapsedMs: Date.now() - started }));
        }
        const matchedByPdfFields = db.reconcileBatchSupportingDocuments(email.id);
        for (const report of reports) {
            const detail = db.getDraftDetail(report.draftId);
            report.status = detail.caseDraft.status;
            report.issues = detail.caseDraft.validationIssues;
            report.documentCount = detail.documents.length;
            report.sourceCount = detail.documents.filter(document => !document.formTemplate).length;
            report.documents = detail.documents.map(document => ({ filename: document.originalFilename, role: document.packageRole,
                status: document.status, hash: document.recognition?.contentHash, library: Boolean(document.formTemplate), relation: document.filingRelation }));
        }
        db.refreshEmailAfterDocumentRetries(email.id);
        const sourceDocuments = reports.flatMap(report => report.documents.filter(document => !document.library));
        assert.equal(sourceDocuments.length, files.size);
        assert.equal(new Set(sourceDocuments.map(document => document.filename)).size, files.size);
        assert.equal(new Set(reports.map(report => report.storageKey)).size, reports.length);
        const uploadCount = uploads.length;
        for (const item of db.createCaseDrafts(email.id, parsed)) {
            if (db.getDraftDetail(item.draftId).caseDraft.status !== 'archived') await processFilingIntake(db, email.id, item.draftId, item.parsed, dependencies);
        }
        assert.equal(uploads.length, uploadCount, 'Reprocessing must not upload another copy');
        assert.equal(db.listDrafts().totalItems, packages.length);
        assert.equal(db.listQueue({ scope: 'all' }).items.length, 1);
        assert.equal(db.listFilingJobs().length, 0); assert.equal(networkAttempts, 0);
        const output = { checkedAt: new Date().toISOString(), sourcePdfs: files.size, packages: packages.length,
            activePackages: reports.filter(report => report.status !== 'archived').length,
            resolvedReviewGroups: reports.filter(report => report.status === 'archived').length,
            completePackages: reports.filter(report => !report.issues.length && report.status !== 'archived').length, matchedByPdfFields,
            networkAttempts, filingJobs: 0, notificationsSent: 0, reprocessingIdempotent: true, reports };
        fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
        fs.writeFileSync(values.output, JSON.stringify(output, null, 2));
        console.log(JSON.stringify({ ...output, reports: undefined }));
    } finally {
        db.close();
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('batch-intake-qa-'));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
