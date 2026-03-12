// index.ts
import { fetchRecentCourtEmails, parseEmailBody, ParsedEmailInfo } from './emailProcessor';
import { downloadFiledDocuments } from './downloadFiledDocuments';
import { closeMifileBrowser } from './mifileSession';
import fs from 'fs/promises';

import { getGraphClient } from './graphClient';         // ← ВАЖНО: именно getGraphClient
import { buildSuccessBody, buildErrorBody } from './buildSuccessBody';
import { sendProcessingReport } from './notificationEmail';

const POLL_INTERVAL_MS = 10_000;
const MAX_EMAILS_PER_POLL = 50;
const STATE_PATH = 'processedEmails.json';

interface ProcessedState {
    messageIds: string[];
}

async function loadProcessed(): Promise<ProcessedState> {
    try {
        const raw = await fs.readFile(STATE_PATH, 'utf8');
        return JSON.parse(raw);
    } catch {
        return { messageIds: [] };
    }
}

async function saveProcessed(state: ProcessedState): Promise<void> {
    await fs.writeFile(STATE_PATH, JSON.stringify(state), 'utf8');
}

async function processOnce(processedIds: Set<string>) {
    console.log('🔁 Checking inbox for new court emails...');

    const emails = await fetchRecentCourtEmails(MAX_EMAILS_PER_POLL);
    if (!emails.length) {
        console.log('No emails returned.');
        return false;
    }

    emails.sort(
        (a: any, b: any) =>
            new Date(a.receivedDateTime).getTime() -
            new Date(b.receivedDateTime).getTime(),
    );

    let changed = false;

    // получаем singleton‑клиент Graph
    const graphClient = getGraphClient();

    for (const msg of emails) {
        const id = msg.id as string;
        if (processedIds.has(id)) continue;

        let parsed: ParsedEmailInfo | undefined;

        try {
            console.log('------------------------------');
            console.log('Subject:', msg.subject);
            console.log('From:', msg.from?.emailAddress?.address);
            console.log('Received:', msg.receivedDateTime);

            const bodyContent = (msg as any).body?.content ?? '';
            parsed = parseEmailBody(bodyContent);
            console.log('Parsed info:', parsed);

            if (!parsed.isMiFile) {
                processedIds.add(id);
                changed = true;
                continue;
            }

            const receivedAtIso = msg.receivedDateTime as string | undefined;

            const { downloaded, notificationFiles } = await downloadFiledDocuments(
                parsed,
                'downloads',
                receivedAtIso,
            );

            if (downloaded.length) {
                console.log('Downloaded files:', downloaded);
            }

            if (notificationFiles.length > 0) {
                console.log(
                    'Notification files:',
                    notificationFiles.map(f => ({ name: f.fileName, url: f.webUrl })),
                );

                const subject =
                    `MiFILE/TrueFiling processed: ` +
                    `${parsed.caseNumber ?? 'NO CASE'} – ${notificationFiles.length} doc(s)`;

                const bodyText = buildSuccessBody({
                    msg,
                    parsed,
                    files: notificationFiles,
                });

                try {
                    await sendProcessingReport({
                        client: graphClient,
                        subject,
                        bodyText,
                        files: notificationFiles,
                    });
                    console.log('Success report email sent');
                } catch (e) {
                    console.error('Error sending success report email:', e);
                }
            }

            processedIds.add(id);
            changed = true;
        } catch (err) {
            console.error(`Error while processing message ${id}:`, err);

            try {
                const subject =
                    `ERROR processing MiFILE/TrueFiling email: ` +
                    `${parsed?.caseNumber ?? msg.subject ?? 'UNKNOWN'}`;

                const bodyText = buildErrorBody({
                    msg,
                    parsed,
                    error: err,
                });

                await sendProcessingReport({
                    client: graphClient,
                    subject,
                    bodyText,
                    files: [],
                });
            } catch (e) {
                console.error('Error sending error report email:', e);
            }

            processedIds.add(id);
            changed = true;
        }
    }

    return changed;
}

async function main() {
    const state = await loadProcessed();
    const processedIds = new Set<string>(state.messageIds);

    console.log('🚀 Court-email worker started');

    try {
        while (true) {
            try {
                const changed = await processOnce(processedIds);
                if (changed) {
                    await saveProcessed({
                        messageIds: Array.from(processedIds).slice(-2000),
                    });
                }
            } catch (err) {
                console.error('Error in main loop (Graph or processing):', err);
                await new Promise(res => setTimeout(res, 5000));
            }

            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    } finally {
        await closeMifileBrowser();
    }
}

main();
