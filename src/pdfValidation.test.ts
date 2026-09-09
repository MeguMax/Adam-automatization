import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectFilingPdf, validatePdfBuffer } from './pdfValidation';
import { testPdfFixture } from './testPdfFixture';

const validPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'ascii',
);

test('accepts a structurally complete PDF regardless of its size', () => {
    assert.deepEqual(validatePdfBuffer(validPdf), { valid: true });
});

test('rejects HTML and truncated PDF data', () => {
    assert.match(
        validatePdfBuffer(Buffer.from('<html>Sign in</html>', 'utf8')).reason ?? '',
        /HTML/,
    );
    assert.match(
        validatePdfBuffer(Buffer.from('%PDF-1.7\npartial', 'ascii')).reason ?? '',
        /end marker/,
    );
});

test('filing inspection reads real PDF pages and rejects a header/trailer-only fake', async () => {
    await inspectFilingPdf(testPdfFixture());
    await assert.rejects(inspectFilingPdf(validPdf), /cannot be read/);
});
