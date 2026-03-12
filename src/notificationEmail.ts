// notificationEmail.ts
import { Client } from '@microsoft/microsoft-graph-client';
import { NotificationFile } from './downloadFiledDocuments';

const NOTIFY_TO = process.env.NOTIFY_TO_EMAIL!;
const SENDER_USER_ID = process.env.SENDER_USER_ID!;

if (!NOTIFY_TO) {
    throw new Error('Missing NOTIFY_TO_EMAIL in .env');
}
if (!SENDER_USER_ID) {
    throw new Error('Missing SENDER_USER_ID in .env');
}

export async function sendProcessingReport(params: {
    client: Client;
    subject: string;
    bodyText: string;
    files?: NotificationFile[];
}) {
    const { client, subject, bodyText, files = [] } = params;

    const attachments = files.map(f => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: f.fileName,
        contentType: 'application/pdf',
        contentBytes: f.buffer.toString('base64'),
    }));

    const message: any = {
        subject,
        body: {
            contentType: 'Text',
            content: bodyText,
        },
        toRecipients: [
            {
                emailAddress: {
                    address: NOTIFY_TO,
                },
            },
        ],
        attachments,
    };

    await client
        .api(`/users/${encodeURIComponent(SENDER_USER_ID)}/sendMail`)
        .post({
            message,
            saveToSentItems: false,
        });
}
