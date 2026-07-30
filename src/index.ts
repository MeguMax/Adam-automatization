import {
    fetchCourtEmailById,
    fetchRecentCourtEmailHeaders,
    parseEmailBody,
    ParsedEmailInfo,
} from './emailProcessor';
import {
    DocumentFailure,
    DownloadedFile,
    downloadFiledDocuments,
    NotificationFile,
} from './downloadFiledDocuments';
import { closeMifileBrowser } from './mifileSession';
import { getGraphClient } from './graphClient';
import { buildSuccessBody, buildErrorBody } from './buildSuccessBody';
import { sendProcessingReport } from './notificationEmail';
import { getWorkflowDatabase, WorkflowDatabase } from './database';
import { loadLegacyProcessed } from './legacyState';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 10_000);
const MAX_EMAILS_PER_POLL = Number(process.env.WORKER_EMAIL_LIMIT || 50);
const MAX_MANUAL_EMAIL_RETRIES_PER_POLL = Math.min(
    Math.max(Number(process.env.EMAIL_RETRY_BATCH_SIZE || 10), 1),
    50,
);
const MAX_DOCUMENT_RETRIES_PER_POLL = Math.min(
    Math.max(Number(process.env.DOCUMENT_RETRY_BATCH_SIZE || 2), 1),
    10,
);
const RUN_ONCE = process.argv.includes('--once') || process.env.WORKER_RUN_ONCE === '1';
const WORKER_BUILD_ID = '2026-07-30-draft-workspace-v7';

export interface WorkerRunOptions {
    runOnce?: boolean;
    signal?: AbortSignal;
    closeDatabaseOnExit?: boolean;
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    const abortSignal = signal;

    return new Promise(resolve => {
        const timer = setTimeout(finish, ms);
        const onAbort = () => finish();
        function finish() {
            clearTimeout(timer);
            abortSignal.removeEventListener('abort', onAbort);
            resolve();
        }

        if (abortSignal.aborted) {
            finish();
            return;
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
    });
}

function lookupPlaintiffNaming(db: WorkflowDatabase, parsed: ParsedEmailInfo) {
    const lookup = db.lookupPlaintiffNaming(parsed);
    console.log('Plaintiff naming database lookup:', lookup);
    return lookup;
}

function isSelfProcessingReport(msg: any): boolean {
    const fromAddr = msg.from?.emailAddress?.address?.toLowerCase() ?? '';
    const subject = (msg.subject ?? '') as string;
    const notifyTo = process.env.NOTIFY_TO_EMAIL?.toLowerCase();

    return !!notifyTo &&
        fromAddr === notifyTo &&
        subject.startsWith('MiFILE/TrueFiling processed:');
}

function summarizeFailures(failures: DocumentFailure[]): string {
    return failures
        .map((failure, index) => {
            const label =
                failure.documentName ||
                failure.documentType ||
                failure.downloadUrl ||
                `document ${index + 1}`;
            return `${label}: ${failure.reason}`;
        })
        .join('\n');
}

function isNonDownloadableDocument(failure: DocumentFailure): boolean {
    return !failure.downloadUrl &&
        (
            failure.reason === 'Missing MiFILE download URL' ||
            failure.reason === 'Missing TrueCertify download URL' ||
            failure.reason === 'No downloadable file in source email' ||
            failure.reason === 'Expected document has no downloadable source URL'
        );
}

function recordDownloadResults(params: {
    db: WorkflowDatabase;
    emailId: string;
    caseDraftId: string;
    downloaded: DownloadedFile[];
    notificationFiles: NotificationFile[];
    failures: DocumentFailure[];
}): void {
    const { db, emailId, caseDraftId, downloaded, notificationFiles, failures } = params;

    db.clearPendingDocuments(caseDraftId);

    for (let i = 0; i < notificationFiles.length; i++) {
        const file = notificationFiles[i];
        const downloadedFile = downloaded[i];

        db.addDocument({
            emailId,
            caseDraftId,
            originalFilename: file.displayName || downloadedFile?.documentName || null,
            currentFilename: file.fileName,
            fileUrl: file.webUrl ?? null,
            sourceUrl: downloadedFile?.downloadUrl ?? null,
            oneDriveUrl: file.webUrl ?? null,
            storagePath: downloadedFile?.localPath ?? null,
            mimeType: 'application/pdf',
            fileSize: file.buffer.length,
            documentType: downloadedFile?.documentType ?? null,
            uploadSource: 'worker_download',
            status: 'uploaded',
            downloadAttempts: downloadedFile?.downloadAttempts ?? 0,
            metadata: {
                driveId: file.driveId,
                itemId: file.itemId,
            },
        });
    }

    for (const failure of failures) {
        const notDownloadable = isNonDownloadableDocument(failure);

        db.addDocument({
            emailId,
            caseDraftId,
            originalFilename: failure.documentName ?? null,
            currentFilename: null,
            fileUrl: null,
            sourceUrl: failure.downloadUrl ?? null,
            oneDriveUrl: null,
            storagePath: null,
            mimeType: 'application/pdf',
            fileSize: null,
            documentType: failure.documentType ?? null,
            uploadSource: failure.downloadUrl?.includes('truecertify.com')
                ? 'truecertify'
                : 'mifile',
            status: notDownloadable ? 'not_downloadable' : 'failed',
            errorMessage: notDownloadable ? 'No downloadable file in source email' : failure.reason,
            downloadAttempts: failure.downloadAttempts ?? 0,
            metadata: failure,
        });
    }
}

async function sendFailureReport(params: {
    msg: any;
    parsed?: ParsedEmailInfo;
    error: unknown;
    files?: NotificationFile[];
}) {
    const graphClient = getGraphClient();
    const { msg, parsed, error, files = [] } = params;
    const subjectLine =
        `ERROR processing MiFILE/TrueFiling email: ` +
        `${parsed?.caseNumber ?? msg.subject ?? 'UNKNOWN'}`;

    const bodyText = buildErrorBody({
        msg,
        parsed,
        error,
    });

    await sendProcessingReport({
        client: graphClient,
        subject: subjectLine,
        bodyText,
        files,
    });
}

function normalizedDocumentUrl(value: string | null | undefined): string {
    return (value ?? '').replace(/&amp;/g, '&').trim();
}

async function processDueDocumentRetries(db: WorkflowDatabase): Promise<void> {
    const recovered = db.recoverStaleDocumentRetries();
    if (recovered > 0) {
        console.warn(`Rescheduled ${recovered} document retry job(s) left by a stopped worker.`);
    }

    const dueRetries = db.claimDueDocumentRetries(MAX_DOCUMENT_RETRIES_PER_POLL);
    if (!dueRetries.length) return;

    console.log(`Processing ${dueRetries.length} due document retry job(s)...`);
    const byEmail = new Map<string, Array<(typeof dueRetries)[number]>>();
    for (const retry of dueRetries) {
        const grouped = byEmail.get(retry.emailId) ?? [];
        grouped.push(retry);
        byEmail.set(retry.emailId, grouped);
    }

    for (const [emailId, retries] of byEmail) {
        const caseDraftId = retries[0].caseDraftId;
        const completed = new Set<string>();
        const recoveredFiles: NotificationFile[] = [];
        let sourceMessage: any;
        let parsed: ParsedEmailInfo | undefined;

        db.markEmailRetrying(emailId);

        try {
            sourceMessage = await fetchCourtEmailById(retries[0].externalMessageId);
            parsed = parseEmailBody(sourceMessage.body?.content ?? '');
            if (!parsed.isMiFile) {
                throw new Error('The original email can no longer be parsed as a MiFILE/TrueFiling message');
            }

            const plaintiffNaming = lookupPlaintiffNaming(db, parsed);
            for (const retry of retries) {
                const retryDocument = parsed.filedDocuments.find(document =>
                    normalizedDocumentUrl(document.downloadUrl) === normalizedDocumentUrl(retry.sourceUrl),
                );
                if (!retryDocument) {
                    db.completeDocumentRetryFailure({
                        documentId: retry.documentId,
                        reason: 'The source document link was not found in the original email',
                        downloadAttempts: 0,
                        metadata: { retrySource: retry.retrySource, sourceUrl: retry.sourceUrl },
                    });
                    completed.add(retry.documentId);
                    continue;
                }

                const oneDocumentParsed: ParsedEmailInfo = {
                    ...parsed,
                    filedDocuments: [retryDocument],
                };
                const result = await downloadFiledDocuments(
                    oneDocumentParsed,
                    'downloads',
                    sourceMessage.receivedDateTime as string | undefined,
                    {
                        plaintiffShortName: plaintiffNaming.shortName,
                        resolvePlaintiffNaming: () => lookupPlaintiffNaming(db, parsed!),
                    },
                );
                const downloadedFile = result.downloaded[0];
                const notificationFile = result.notificationFiles[0];

                if (downloadedFile && notificationFile) {
                    db.completeDocumentRetrySuccess({
                        documentId: retry.documentId,
                        originalFilename: notificationFile.displayName || downloadedFile.documentName || null,
                        currentFilename: notificationFile.fileName,
                        sourceUrl: downloadedFile.downloadUrl ?? retry.sourceUrl,
                        oneDriveUrl: notificationFile.webUrl ?? null,
                        storagePath: downloadedFile.localPath,
                        fileSize: notificationFile.buffer.length,
                        documentType: downloadedFile.documentType ?? retry.documentType,
                        uploadSource: retry.sourceUrl.includes('truecertify.com')
                            ? 'truecertify'
                            : 'mifile',
                        downloadAttempts: downloadedFile.downloadAttempts ?? 0,
                        metadata: {
                            driveId: notificationFile.driveId,
                            itemId: notificationFile.itemId,
                            retrySource: retry.retrySource,
                        },
                    });
                    recoveredFiles.push(notificationFile);
                } else {
                    const failure = result.failures[0];
                    db.completeDocumentRetryFailure({
                        documentId: retry.documentId,
                        reason: failure?.reason ?? 'Retry finished without a downloaded PDF',
                        downloadAttempts: failure?.downloadAttempts ?? 0,
                        metadata: failure ?? { retrySource: retry.retrySource },
                    });
                }
                completed.add(retry.documentId);
            }
        } catch (error) {
            console.error(`Document retry processing failed for email ${emailId}:`, error);
            for (const retry of retries) {
                if (completed.has(retry.documentId)) continue;
                db.completeDocumentRetryFailure({
                    documentId: retry.documentId,
                    reason: error instanceof Error ? error.message : String(error),
                    downloadAttempts: 0,
                    metadata: { retrySource: retry.retrySource, sourceUrl: retry.sourceUrl },
                });
            }
        } finally {
            db.refreshEmailAfterDocumentRetries(emailId, caseDraftId);
        }

        if (sourceMessage && parsed && recoveredFiles.length) {
            try {
                const reportPlaintiffNaming = lookupPlaintiffNaming(db, parsed);
                await sendProcessingReport({
                    client: getGraphClient(),
                    subject: `MiFILE/TrueFiling retry completed: ${parsed.caseNumber ?? 'NO CASE'} - ${recoveredFiles.length} doc(s)`,
                    bodyText: buildSuccessBody({
                        msg: sourceMessage,
                        parsed,
                        files: recoveredFiles,
                        plaintiffFullName: reportPlaintiffNaming.fullName,
                        plaintiffShortName: reportPlaintiffNaming.shortName,
                    }),
                    files: recoveredFiles,
                });
            } catch (error) {
                console.error('Error sending document retry report email:', error);
            }
        }
    }
}

async function processOnce(db: WorkflowDatabase): Promise<void> {
    console.log('Checking inbox for new court emails...');

    const recentEmails = await fetchRecentCourtEmailHeaders(MAX_EMAILS_PER_POLL);
    const emailsById = new Map<string, any>(
        recentEmails.map((email: any) => [String(email.id), email]),
    );
    const queuedRetries = db.listQueuedEmailRetries(MAX_MANUAL_EMAIL_RETRIES_PER_POLL);

    for (const retry of queuedRetries) {
        if (emailsById.has(retry.externalMessageId)) continue;
        try {
            const email = await fetchCourtEmailById(retry.externalMessageId);
            emailsById.set(retry.externalMessageId, email);
        } catch (error) {
            db.markEmailFailed(
                retry.emailId,
                `Unable to fetch the source email for manual retry: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    const emails = Array.from(emailsById.values());
    if (!emails.length) {
        console.log('No emails returned.');
        await processDueDocumentRetries(db);
        return;
    }

    emails.sort(
        (a: any, b: any) =>
            new Date(a.receivedDateTime).getTime() -
            new Date(b.receivedDateTime).getTime(),
    );

    const graphClient = getGraphClient();

    for (const candidate of emails) {
        const externalMessageId = String(candidate.id);
        if (db.shouldSkipEmail(externalMessageId)) continue;

        let msg = candidate;
        if (!(msg as any).body?.content) {
            db.registerEmail(candidate);
            try {
                msg = await fetchCourtEmailById(externalMessageId);
            } catch (error) {
                console.error(
                    `Unable to fetch message body ${externalMessageId}; ` +
                    'the email remains new and will be retried on the next poll:',
                    error,
                );
                continue;
            }
        }

        const emailRecord = db.registerEmail(msg);
        db.markEmailProcessing(emailRecord.id);

        let parsed: ParsedEmailInfo | undefined;
        let caseDraftId: string | undefined;

        try {
            console.log('------------------------------');
            console.log('Subject:', msg.subject);
            console.log('From:', msg.from?.emailAddress?.address);
            console.log('Received:', msg.receivedDateTime);

            if (isSelfProcessingReport(msg)) {
                db.markEmailIgnored(emailRecord.id, 'Self processing report');
                continue;
            }

            const bodyContent = (msg as any).body?.content ?? '';
            parsed = parseEmailBody(bodyContent);
            console.log('Parsed info:', parsed);

            if (!parsed.isMiFile) {
                db.markEmailIgnored(emailRecord.id, 'Not a MiFILE/TrueFiling email');
                continue;
            }

            caseDraftId = db.createCaseDraft(emailRecord.id, parsed);
            const plaintiffNaming = lookupPlaintiffNaming(db, parsed);

            const { downloaded, notificationFiles, failures } = await downloadFiledDocuments(
                parsed,
                'downloads',
                msg.receivedDateTime as string | undefined,
                {
                    plaintiffShortName: plaintiffNaming.shortName,
                    resolvePlaintiffNaming: () => lookupPlaintiffNaming(db, parsed!),
                },
            );

            recordDownloadResults({
                db,
                emailId: emailRecord.id,
                caseDraftId,
                downloaded,
                notificationFiles,
                failures,
            });

            if (downloaded.length) {
                console.log('Downloaded files:', downloaded);
            }

            const actionableFailures = failures.filter(failure => !isNonDownloadableDocument(failure));

            if (actionableFailures.length > 0) {
                const failureSummary = summarizeFailures(actionableFailures);
                const emailStatus = notificationFiles.length > 0 ? 'partial_failure' : 'failed';

                db.markEmailFailed(emailRecord.id, failureSummary, emailStatus);
                db.setCaseDraftStatus(
                    caseDraftId,
                    notificationFiles.length > 0 ? 'needs_review' : 'validation_failed',
                    'failed',
                    'not_started',
                );

                try {
                    await sendFailureReport({
                        msg,
                        parsed,
                        error: `Document processing failed:\n${failureSummary}`,
                        files: notificationFiles,
                    });
                } catch (e) {
                    console.error('Error sending failure report email:', e);
                }

                continue;
            }

            if (!notificationFiles.length) {
                throw new Error('No documents were downloaded or uploaded');
            }

            console.log(
                'Notification files:',
                notificationFiles.map(f => ({ name: f.fileName, url: f.webUrl })),
            );

            const subjectLine =
                `MiFILE/TrueFiling processed: ` +
                `${parsed.caseNumber ?? 'NO CASE'} - ${notificationFiles.length} doc(s)`;

            const bodyText = buildSuccessBody({
                msg,
                parsed,
                files: notificationFiles,
                plaintiffFullName: plaintiffNaming.fullName,
                plaintiffShortName: plaintiffNaming.shortName,
            });

            try {
                await sendProcessingReport({
                    client: graphClient,
                    subject: subjectLine,
                    bodyText,
                    files: notificationFiles,
                });
                console.log('Success report email sent');
            } catch (e) {
                console.error('Error sending success report email:', e);
            }

            db.setCaseDraftStatus(caseDraftId, 'ready_to_file', 'passed', 'not_started');
            db.markEmailProcessed(emailRecord.id);
        } catch (err) {
            console.error(`Error while processing message ${externalMessageId}:`, err);
            db.markEmailFailed(emailRecord.id, err, 'failed');

            if (caseDraftId) {
                db.setCaseDraftStatus(caseDraftId, 'validation_failed', 'failed', 'not_started');
            }

            try {
                await sendFailureReport({ msg, parsed, error: err });
            } catch (e) {
                console.error('Error sending error report email:', e);
            }
        }
    }

    await processDueDocumentRetries(db);
}

export async function runWorker(options: WorkerRunOptions = {}): Promise<void> {
    const runOnce = options.runOnce ?? RUN_ONCE;
    const db = getWorkflowDatabase();
    console.log('Worker runtime:', {
        buildId: WORKER_BUILD_ID,
        entryFile: __filename,
        workingDirectory: process.cwd(),
    });
    console.log(`Workflow DB: ${db.getPath()}`);

    const legacyState = await loadLegacyProcessed();
    const imported = db.migrateLegacyProcessedIds(legacyState.messageIds ?? []);

    if (imported > 0) {
        console.log(`Imported ${imported} legacy processed email id(s) into SQLite.`);
    }

    console.log(`Court-email worker started${runOnce ? ' (single pass)' : ''}`);

    try {
        if (runOnce) {
            await processOnce(db);
            return;
        }

        while (!options.signal?.aborted) {
            try {
                await processOnce(db);
            } catch (err) {
                console.error('Error in main loop (Graph or processing):', err);
                await waitFor(5000, options.signal);
            }

            await waitFor(POLL_INTERVAL_MS, options.signal);
        }
    } finally {
        await closeMifileBrowser();
        if (options.closeDatabaseOnExit !== false) {
            db.close();
        }
    }
}

if (require.main === module) {
    runWorker().catch(error => {
        console.error('Court-email worker stopped with an unrecoverable error:', error);
        process.exitCode = 1;
    });
}
