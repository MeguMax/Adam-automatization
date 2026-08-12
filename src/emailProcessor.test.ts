import assert from 'node:assert/strict';
import test from 'node:test';
import {
    addEmailAttachmentSources,
    createEmailAttachmentSource,
    emailAttachmentSourceName,
    isEmailAttachmentSource,
} from './emailAttachmentSource';

process.env.TENANT_ID ||= 'test-tenant';
process.env.CLIENT_ID ||= 'test-client';
process.env.CLIENT_SECRET ||= 'test-secret';
process.env.USER_EMAIL ||= 'test@example.com';

test('TrueCertify URLs require both locator and key values', async () => {
    const { isUsableTrueCertifyUrl } = await import('./emailProcessor');

    assert.equal(isUsableTrueCertifyUrl('https://eservices.truecertify.com/'), false);
    assert.equal(
        isUsableTrueCertifyUrl('https://eservices.truecertify.com/?loc=abc&key=def'),
        true,
    );
    assert.equal(
        isUsableTrueCertifyUrl('https://eservices.truecertify.com/?loc=abc'),
        false,
    );
});

test('Document Sent notices remain parseable when the PDF is supplied as an email attachment', async () => {
    const { parseEmailBody } = await import('./emailProcessor');
    const parsed = parseEmailBody(`
        <p>The following document was electronically sent on behalf of the 48TH DISTRICT COURT by MiFILE.</p>
        <p>Document Name: ORDER</p>
        <p>Document Type: OTHER</p>
        <p><a href="https://eservices.truecertify.com/">Open TrueCertify</a></p>
    `);

    assert.equal(parsed.isMiFile, true);
    assert.equal(parsed.filedDocuments.length, 1);
    assert.equal(parsed.filedDocuments[0].documentName, 'ORDER');
    assert.equal(parsed.filedDocuments[0].downloadUrl, null);
    const withAttachmentSource = addEmailAttachmentSources(parsed);
    assert.equal(
        emailAttachmentSourceName(withAttachmentSource.filedDocuments[0].downloadUrl),
        'ORDER',
    );
});

test('email attachment source identifiers round-trip filenames safely', () => {
    const source = createEmailAttachmentSource('Court Order #1.pdf');
    assert.equal(isEmailAttachmentSource(source), true);
    assert.equal(emailAttachmentSourceName(source), 'Court Order #1.pdf');
});
