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
