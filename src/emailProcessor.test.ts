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

test('Graph subject searches remove URL and query syntax characters', async () => {
    const { sanitizeGraphSearchSubject } = await import('./emailProcessor');
    assert.equal(
        sanitizeGraphSearchSubject('YOUR R&D TEST #1?'),
        'YOUR R D TEST 1',
    );
});

const DOCUMENT_SENT_BODY = `<p>The following document was electronically sent on behalf of the 52-2 DISTRICT COURT by MiFILE.</p>
<p>Document Name:<br>52-2 DC105 CLARKSTON APTS, LLC V ASHLEY COOLEY (2)</p>
<p>Document Type:<br>PROPOSED JUDGMENT/ORDER</p>
<a href="https://eservices.truecertify.com/?loc=MID52.2-SB2K89-A73AD90C&amp;key=YWX">Download</a>`;

test('Document Sent reads case number and parties from the actual Subject header', async () => {
    const { parseWorkflowEmail } = await import('./workflowEmail');
    const parsed = await parseWorkflowEmail({
        subject: 'MiFILE - Document Sent 26-04033-LT, CLARKSTON APTS, LLC V COOLEY',
        from: { emailAddress: { address: 'truefilingadmin@truefiling.com' } },
        body: { content: DOCUMENT_SENT_BODY },
    });
    assert.equal(parsed?.caseNumber, '26-04033-LT');
    assert.equal(parsed?.caseTitle, 'CLARKSTON APTS, LLC V COOLEY');
    assert.equal(parsed?.courtName, '52-2 DISTRICT COURT');
    assert.equal(parsed?.filedDocuments[0].documentName,
        '52-2 DC105 CLARKSTON APTS, LLC V ASHLEY COOLEY (2)');
});

test('client replies and lookalike domains cannot reprocess quoted court documents', async () => {
    const { parseWorkflowEmail } = await import('./workflowEmail');
    for (const [sender, subject] of [
        ['client@example.com', 'RE: MiFILE - Document Sent 26-04033-LT, OWNER V TENANT'],
        ['truefilingadmin@truefiling.com.attacker.example', 'MiFILE - Document Sent 26-04033-LT, OWNER V TENANT'],
        ['truefilingadmin@truefiling.com', 'RE: MiFILE - Document Sent 26-04033-LT, OWNER V TENANT'],
    ]) {
        assert.equal(await parseWorkflowEmail({ subject,
            from: { emailAddress: { address: sender } }, body: { content: DOCUMENT_SENT_BODY } }), null);
    }
});

test('court download reports never announce automatic filing readiness', async () => {
    const { parseEmailBody } = await import('./emailProcessor');
    const { buildSuccessBody } = await import('./buildSuccessBody');
    const body = buildSuccessBody({ msg: {}, parsed: parseEmailBody(DOCUMENT_SENT_BODY), files: [],
        draftValidation: { status: 'parsed', issues: [] } });
    assert.ok(!body.includes('READY'));
    assert.ok(!body.includes('Filing Draft'));
});
