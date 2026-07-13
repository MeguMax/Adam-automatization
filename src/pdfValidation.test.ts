import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePdfBuffer } from './pdfValidation';

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
