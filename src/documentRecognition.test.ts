import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
    DOCUMENT_RECOGNITION_VERSION,
    applySuppliedSupportingPolicy,
    recognizeDocumentPages,
    recognizeDocumentPdf,
    recognizeDocumentText,
    type DocumentRecognition,
    type SupportingDocumentKind,
} from './documentRecognition';
import { testPdfFixture } from './testPdfFixture';
import type { OcrPage } from './pdfOcr';

const pdfOcr = require('./pdfOcr') as typeof import('./pdfOcr');

test('verified supplied supporting PDFs need no semantic title, while core guesses, conflicts and motions remain protected',async()=>{
    const pdf=testPdfFixture('Additional supporting evidence supplied by the attorney. '.repeat(3));
    for(const name of ['Example T Other 01.pdf','exhibit-12.pdf','Lease.pdf']) {
        const raw=await recognizeDocumentPdf(pdf,name),result=applySuppliedSupportingPolicy(raw,name);
        assert.equal(raw.pdfVerified,true);assert.equal(result.role,'ancillary');assert.equal(result.source,'supplied');
        assert.equal(result.contentHash,raw.contentHash);
    }
    for(const name of ['Complaint.pdf','Summons.pdf','Request.pdf','Advice.pdf','Local.pdf','Motion.pdf']) {
        const raw=await recognizeDocumentPdf(pdf,name);
        assert.deepEqual(applySuppliedSupportingPolicy(raw,name),raw);
    }
    const motion=await recognizeDocumentPdf(testPdfFixture('MOTION FOR SUMMARY DISPOSITION'),'Other.pdf');
    assert.equal(motion.outOfScope,true);assert.deepEqual(applySuppliedSupportingPolicy(motion,'Other.pdf'),motion);
    const conflict={...recognizeDocumentText(['COMPLAINT\nSUMMONS'],'Other.pdf'),pdfVerified:true,contentHash:'a'.repeat(64)};
    assert.equal(applySuppliedSupportingPolicy(conflict,'Other.pdf').source,'conflict');
    const broken=await recognizeDocumentPdf(Buffer.from('Not a PDF'),'Other.pdf');
    assert.equal(broken.pdfVerified,false);assert.equal(applySuppliedSupportingPolicy(broken,'Other.pdf').role,'unknown');
    const legacy={...recognizeDocumentText(['Additional evidence '.repeat(12)],'exhibit.pdf'),textSource:'pdf' as const,contentHash:'a'.repeat(64)};
    assert.equal(applySuppliedSupportingPolicy(legacy,'exhibit.pdf').source,'unknown');
    assert.equal(applySuppliedSupportingPolicy({...legacy,pdfVerified:true},'exhibit.pdf').source,'supplied');
});

function assertMetadata(result: DocumentRecognition, content: Buffer) {
    assert.equal(result.contentHash, createHash('sha256').update(content).digest('hex'));
    assert.equal(result.recognitionVersion, 2);
    assert.equal(DOCUMENT_RECOGNITION_VERSION, 2);
}

function scannedPage(text: string, confidence = 95): OcrPage {
    return { text, confidence, lines: [], words: [] };
}

test('anchored supporting titles identify content kinds independently of generic filenames', () => {
    const titles: Array<[SupportingDocumentKind, string]> = [
        ['demand', 'DEMAND FOR POSSESSION'],
        ['demand', 'STATE OF MICHIGAN DEMAND FOR POSSESSION\nNONPAYMENT OF RENT'],
        ['demand', 'DEMAND FOR POSSESSION (NONPAYMENT OF RENT)'],
        ['notice_to_quit', 'NOTICE TO QUIT'],
        ['notice_to_quit', 'NOTICE TO QUIT\nTO RECOVER POSSESSION OF PROPERTY'],
        ['notice_to_quit', 'NOTICE TO QUIT (TERMINATION OF TENANCY)'],
        ['lease', 'LEASE'],
        ['lease', 'LEASE AGREEMENT'],
        ['lease', 'RESIDENTIAL LEASE AGREEMENT'],
        ['deed', "SHERIFF'S DEED"],
        ['deed', 'SHERIFF\u2019S DEED ON MORTGAGE SALE'],
        ['deed', 'SHERIFFS DEED'],
        ['deed', 'WARRANTY DEED'],
        ['deed', 'QUITCLAIM DEED'],
        ['deed', 'QUIT CLAIM DEED'],
        ['deed', 'QUIT-CLAIM DEED'],
        ['affidavit', 'AFFIDAVIT'],
        ['affidavit', 'AFFIDAVIT OF SERVICE'],
        ['affidavit', 'AFFIDAVIT OF NON-MILITARY SERVICE'],
    ];
    for (const [kind, title] of titles) {
        const result = recognizeDocumentText([title], 'scan001.pdf');
        assert.equal(result.role, 'ancillary', title);
        assert.equal(result.source, 'content', title);
        assert.equal(result.supportingKind, kind, title);
        assert.equal(result.recognitionVersion, 2);
        assert.equal(result.contentHash, undefined, 'Text-only recognition cannot attest to PDF bytes');
    }
});

test('a seven-page Sheriff deed called Other or Demand is a deed, never a demand', () => {
    const pages = ["SHERIFF'S DEED", ...Array<string>(6).fill('Recorded conveyance continuation')];
    for (const filename of ['Other.pdf', 'Demand.pdf', 'Connected Filing.pdf']) {
        const result = recognizeDocumentText(pages, filename);
        assert.equal(result.role, 'ancillary');
        assert.equal(result.source, 'content');
        assert.equal(result.supportingKind, 'deed');
    }
    assert.equal(recognizeDocumentText(['WARRANTY DEED'], 'Demand.pdf').supportingKind, 'deed');
});

test('filenames and Other/Connected labels retain broad roles without proving a supporting kind', () => {
    for (const filename of ['Demand.pdf', 'Notice.pdf', 'Lease.pdf', 'Deed.pdf', 'Affidavit.pdf', 'Other.pdf', 'Connected Filing.pdf']) {
        const result = recognizeDocumentText(['Unidentified attachment'], filename);
        assert.equal(result.role, 'ancillary', filename);
        assert.equal(result.source, 'filename', filename);
        assert.equal(result.supportingKind, 'unknown', filename);
        assert.match(result.supportingMessage!, /manual review/i);
    }
    for (const title of ['OTHER', 'CONNECTED FILING']) {
        assert.equal(recognizeDocumentText([title], 'Other.pdf').supportingKind, 'unknown');
    }
});

test('incidental prose and foreclosure or general notices are not positive supporting evidence', () => {
    for (const text of [
        'Attached to this complaint is a copy of the demand for possession',
        'Please review the Notice to Quit before filing.',
        "A copy of the Sheriff's Deed is attached.",
        'The lease agreement is attached as an exhibit.',
        'Affidavit of service is attached',
        'FORECLOSURE ADVERTISEMENT',
        'NOTICE OF MORTGAGE FORECLOSURE SALE',
        'NOTICE OF FORECLOSURE',
        'GENERAL NOTICE',
        'NOTICE',
    ]) {
        assert.equal(recognizeDocumentText([text], 'Demand.pdf').supportingKind, 'unknown', text);
    }
});

test('supporting evidence is bounded to the first 24 nonempty lines on each page', () => {
    const firstLines = Array.from({ length: 24 }, (_, index) => `Recorded body line ${index + 1}`);
    assert.equal(recognizeDocumentText([[...firstLines, 'DEMAND FOR POSSESSION'].join('\n')], 'Demand.pdf').supportingKind, 'unknown');
    assert.equal(recognizeDocumentText([[...firstLines.slice(0, 23), 'DEMAND FOR POSSESSION'].join('\n')], '').supportingKind, 'demand');
    assert.equal(recognizeDocumentText(['Cover sheet', 'NOTICE TO QUIT'], '').supportingKind, 'notice_to_quit');
});

test('different supporting kinds retain their source PDF without implying a split or a legal requirement', () => {
    for (const pages of [
        ['DEMAND FOR POSSESSION\nLEASE AGREEMENT'],
        ['DEMAND FOR POSSESSION', "SHERIFF'S DEED"],
        ['NOTICE TO QUIT', 'DEMAND FOR POSSESSION'],
        ['AFFIDAVIT OF SERVICE', 'LEASE AGREEMENT'],
    ]) {
        const result = recognizeDocumentText(pages, 'Other.pdf');
        assert.equal(result.role, 'ancillary');
        assert.equal(result.source, 'content');
        assert.equal(result.supportingKind, 'unknown');
        assert.match(result.supportingMessage!, /several supporting-document kinds.*retained as supplied/i);
    }
    assert.equal(recognizeDocumentText(['DEMAND FOR POSSESSION', 'DEMAND FOR POSSESSION'], '').supportingKind, 'demand');
});

test('Advice prose and Complaint references do not introduce incidental title conflicts', () => {
    const advice = recognizeDocumentText([
        'Advice of Rights and Information (Landlord-Tenant)\nYou can file a motion before the date listed on the\nsummons, or ask the court in person at the first court hearing.\nAttach form DC 102a Complaint if applicable',
    ], 'Advice.pdf');
    assert.equal(advice.role, 'advice');
    assert.equal(advice.source, 'content');
    assert.equal(advice.supportingKind, 'unknown');
    const complaint = recognizeDocumentText([
        'COMPLAINT\nNONPAYMENT OF RENT\nAttached to this complaint is a copy of the demand for possession',
    ], 'Complaint.pdf');
    assert.equal(complaint.role, 'complaint');
    assert.equal(complaint.source, 'content');
    assert.equal(complaint.supportingKind, 'unknown');
    assert.equal(recognizeDocumentText(['Please refer to the complaint and summons.'], 'scan.pdf').source, 'unknown');
});

test('core title conflicts and the existing DC102 Complaint footer anchor remain protected', () => {
    for (const [pages, filename] of [
        [['SUMMONS'], 'Complaint.pdf'],
        [['COMPLAINT', 'SUMMONS'], 'bundle.pdf'],
        [['COMPLAINT', 'DEMAND FOR POSSESSION'], 'bundle.pdf'],
        [['DEMAND FOR POSSESSION'], 'Complaint.pdf'],
    ] as Array<[string[], string]>) {
        const result = recognizeDocumentText(pages, filename);
        assert.equal(result.source, 'conflict');
        assert.equal(result.supportingKind, 'unknown');
    }
    const footer = recognizeDocumentText([
        [...Array<string>(24).fill('Caption body'), 'DC 102c (6/23) COMPLAINT TO RECOVER POSSESSION OF PROPERTY'].join('\n'),
    ], 'scan.pdf');
    assert.equal(footer.role, 'complaint');
    assert.equal(footer.source, 'content');
});

test('PDF and pre-inspected PDF paths return the exact byte hash and recognition version', async () => {
    const pdf = testPdfFixture("SHERIFF'S DEED");
    const parsed = await recognizeDocumentPdf(pdf, 'Demand.pdf');
    assertMetadata(parsed, pdf);
    assert.equal(parsed.supportingKind, 'deed');
    assert.equal(parsed.textSource, 'pdf');
    const pages = await recognizeDocumentPages(pdf, ["SHERIFF'S DEED"], 'Other.pdf');
    assertMetadata(pages, pdf);
    const changed = Buffer.concat([pdf, Buffer.from('\n')]);
    const changedResult = await recognizeDocumentPages(changed, ["SHERIFF'S DEED"], 'Other.pdf');
    assertMetadata(changedResult, changed);
    assert.notEqual(changedResult.contentHash, pages.contentHash);
});

test('unrecognized text without OCR and empty page lists still return metadata', async () => {
    const pdf = testPdfFixture();
    for (const pages of [[], ['Unidentified text '.repeat(10)]]) {
        const result = await recognizeDocumentPages(pdf, pages, 'Demand.pdf');
        assertMetadata(result, pdf);
        assert.equal(result.source, 'filename');
        assert.equal(result.supportingKind, 'unknown');
        assert.equal(result.textSource, 'pdf');
    }
});

test('unreadable PDF failures still return hash, version and unknown supporting kind', async () => {
    for (const pdf of [Buffer.alloc(0), Buffer.from('Not a PDF'), Buffer.from('%PDF-1.4\n%%EOF')]) {
        const result = await recognizeDocumentPdf(pdf, 'Demand.pdf');
        assertMetadata(result, pdf);
        assert.equal(result.source, 'unknown');
        assert.equal(result.supportingKind, 'unknown');
        assert.match(result.supportingMessage!, /manual review/i);
    }
});

test('high-confidence OCR can establish an anchored supporting title without filename inference', async context => {
    const pdf = testPdfFixture();
    const mock = context.mock.method(pdfOcr, 'recognizeScannedPdf', async (_buffer: Buffer, numbers?: number[]) => {
        assert.deepEqual(numbers, [1]);
        return [scannedPage('DEMAND FOR POSSESSION\nNONPAYMENT OF RENT')];
    });
    const result = await recognizeDocumentPages(pdf, [''], 'Other.pdf');
    assert.equal(mock.mock.callCount(), 1);
    assertMetadata(result, pdf);
    assert.equal(result.source, 'content');
    assert.equal(result.textSource, 'ocr');
    assert.equal(result.supportingKind, 'demand');
});

test('low-confidence OCR cannot provide a positive supporting kind or clear a broad conflict', async context => {
    const pdf = testPdfFixture();
    const mock = context.mock.method(pdfOcr, 'recognizeScannedPdf', async () => [scannedPage('DEMAND FOR POSSESSION', 69)]);
    for (const filename of ['Demand.pdf', 'Complaint.pdf']) {
        const result = await recognizeDocumentPages(pdf, [''], filename);
        assertMetadata(result, pdf);
        assert.equal(result.supportingKind, 'unknown');
        assert.equal(result.textSource, 'ocr');
        assert.equal(result.source, filename === 'Complaint.pdf' ? 'conflict' : 'filename');
        assert.match(result.supportingMessage!, /low-confidence.*manual review/i);
    }
    mock.mock.mockImplementation(async () => [scannedPage('DEMAND FOR POSSESSION', Number.NaN)]);
    assert.equal((await recognizeDocumentPages(pdf, [''], 'Other.pdf')).supportingKind, 'unknown');
});

test('mixed OCR kinds and low-confidence continuation pages cannot silently satisfy demand', async context => {
    const pdf = testPdfFixture();
    const mock = context.mock.method(pdfOcr, 'recognizeScannedPdf', async () => [
        scannedPage('DEMAND FOR POSSESSION'), scannedPage("SHERIFF'S DEED"),
    ]);
    const mixed = await recognizeDocumentPages(pdf, ['', ''], 'Demand.pdf');
    assertMetadata(mixed, pdf);
    assert.equal(mixed.supportingKind, 'unknown');
    assert.match(mixed.supportingMessage!, /several supporting-document kinds/i);
    mock.mock.mockImplementation(async () => [scannedPage('DEMAND FOR POSSESSION'), scannedPage('Unclear continuation', 30)]);
    const uncertain = await recognizeDocumentPages(pdf, ['DEMAND FOR POSSESSION', ''], 'Demand.pdf');
    assertMetadata(uncertain, pdf);
    assert.equal(uncertain.supportingKind, 'unknown');
    assert.equal(uncertain.source, 'filename');
});

test('OCR failure or missing results clears tentative positive kinds but retains byte metadata', async context => {
    const pdf = testPdfFixture();
    const mock = context.mock.method(pdfOcr, 'recognizeScannedPdf', async (): Promise<OcrPage[]> => {
        throw new Error('Synthetic OCR failure');
    });
    const failed = await recognizeDocumentPages(pdf, ['DEMAND FOR POSSESSION', ''], 'Demand.pdf');
    assertMetadata(failed, pdf);
    assert.equal(failed.supportingKind, 'unknown');
    assert.equal(failed.source, 'unknown');
    assert.match(failed.message, /Synthetic OCR failure/);
    mock.mock.mockImplementation(async () => []);
    const incomplete = await recognizeDocumentPages(pdf, [''], 'Demand.pdf');
    assertMetadata(incomplete, pdf);
    assert.equal(incomplete.source, 'unknown');
    assert.equal(incomplete.supportingKind, 'unknown');
    assert.match(incomplete.message, /every requested page/);
});
