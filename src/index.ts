import {
    CourtEmailAttachment,
    downloadCourtEmailAttachment,
    fetchCourtEmailById,
    fetchCourtEmailPdfAttachments,
    fetchRecentCourtEmailHeaders,
    findCourtEmailByMetadata,
    isUsableTrueCertifyUrl,
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
import { DueDocumentRetry, getWorkflowDatabase, WorkflowDatabase } from './database';
import { loadLegacyProcessed } from './legacyState';
import {
    addEmailAttachmentSources,
    createEmailAttachmentSource,
    emailAttachmentSourceName,
    isEmailAttachmentSource,
} from './emailAttachmentSource';
import { extractComplaintPdf, isComplaintDocument } from './complaintExtractor';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 10_000);
const MAX_EMAILS_PER_POLL = Number(process.env.WORKER_EMAIL_LIMIT || 50);
const MAX_PENDING_EMAILS_PER_POLL = Math.min(
    Math.max(Number(
        process.env.EMAIL_PROCESSING_BATCH_SIZE ||
        process.env.EMAIL_RETRY_BATCH_SIZE ||
        10,
    ), 1),
    50,
);
const MAX_DOCUMENT_RETRIES_PER_POLL = Math.min(
    Math.max(Number(process.env.DOCUMENT_RETRY_BATCH_SIZE || 2), 1),
    10,
);
const RUN_ONCE = process.argv.includes('--once') || process.env.WORKER_RUN_ONCE === '1';
const WORKER_BUILD_ID = '2026-08-14-standard-nonpayment-drafts-v17';

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
    return failure.notDownloadable === true ||
        (!failure.downloadUrl &&
        (
            failure.reason === 'Missing MiFILE download URL' ||
            failure.reason === 'Missing TrueCertify download URL' ||
            failure.reason === 'No downloadable file in source email' ||
            failure.reason === 'Expected document has no downloadable source URL'
        ));
}

async function recordDownloadResults(params: {
    db: WorkflowDatabase;
    emailId: string;
    caseDraftId: string;
    downloaded: DownloadedFile[];
    notificationFiles: NotificationFile[];
    failures: DocumentFailure[];
}): Promise<void> {
    const { db, emailId, caseDraftId, downloaded, notificationFiles, failures } = params;

    db.clearPendingDocuments(caseDraftId);

    for (let i = 0; i < notificationFiles.length; i++) {
        const file = notificationFiles[i];
        const downloadedFile = downloaded[i];

        const documentId = db.addDocument({
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
        if (isComplaintDocument(
            downloadedFile?.documentType,
            file.fileName || file.displayName,
        )) {
            try {
                const extraction = await extractComplaintPdf(
                    file.buffer,
                    downloadedFile?.documentType,
                );
                db.applyComplaintExtraction(caseDraftId, documentId, extraction);
                console.log('Complaint fields extracted:', {
                    documentId,
                    appliedFields: Object.keys(extraction.data),
                    warnings: extraction.warnings.map(warning => warning.code),
                });
            } catch (error) {
                console.warn(
                    `Complaint extraction skipped for ${file.fileName}:`,
                    error instanceof Error ? error.message : String(error),
                );
            }
        }
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
            uploadSource: isEmailAttachmentSource(failure.downloadUrl)
                ? 'email_attachment'
                : failure.downloadUrl?.includes('truecertify.com')
                    ? 'truecertify'
                    : 'mifile',
            status: notDownloadable ? 'not_downloadable' : 'failed',
            errorMessage: failure.reason,
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

function normalizedAttachmentName(value: string | null | undefined): string {
    return (value ?? '')
        .toLowerCase()
        .replace(/\.pdf$/i, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function selectPdfAttachment(
    documentName: string | null | undefined,
    attachments: CourtEmailAttachment[],
): CourtEmailAttachment {
    if (!attachments.length) {
        throw new Error('The source email does not contain a PDF attachment');
    }

    const target = normalizedAttachmentName(documentName);
    const exact = target
        ? attachments.find(attachment => normalizedAttachmentName(attachment.name) === target)
        : undefined;
    if (exact) return exact;

    const partial = target
        ? attachments.find(attachment => {
            const candidate = normalizedAttachmentName(attachment.name);
            return candidate.includes(target) || target.includes(candidate);
        })
        : undefined;
    if (partial) return partial;
    if (attachments.length === 1) return attachments[0];

    throw new Error(
        `Unable to match the document to a PDF attachment. Available files: ${
            attachments.map(attachment => attachment.name).join(', ')
        }`,
    );
}

function createEmailAttachmentResolver(
    messageProvider: () => Promise<any>,
): (document: ParsedEmailInfo['filedDocuments'][number]) => Promise<Buffer> {
    let messagePromise: Promise<any> | null = null;
    let attachmentsPromise: Promise<CourtEmailAttachment[]> | null = null;

    return async document => {
        messagePromise ??= messageProvider();
        const message = await messagePromise;
        attachmentsPromise ??= fetchCourtEmailPdfAttachments(String(message.id));
        const attachments = await attachmentsPromise;
        const sourceName = emailAttachmentSourceName(document.downloadUrl);
        const attachment = selectPdfAttachment(
            sourceName || document.documentName || document.documentType,
            attachments,
        );
        console.log('Email attachment selected:', {
            source: document.downloadUrl,
            attachmentName: attachment.name,
            attachmentSize: attachment.size,
        });
        return downloadCourtEmailAttachment(String(message.id), attachment.id);
    };
}

async function recoverOutlookMessage(
    db: WorkflowDatabase,
    email: {
        emailId: string;
        externalMessageId: string;
        subject: string | null;
        sender: string | null;
        receivedAt: string | null;
    },
): Promise<any> {
    try {
        return await fetchCourtEmailById(email.externalMessageId);
    } catch (directError) {
        console.warn(
            `Stored Outlook message ID is no longer available for ${email.subject || email.emailId}; ` +
            'searching the mailbox by subject, sender, and received time.',
        );
        const recovered = await findCourtEmailByMetadata(email);
        if (!recovered) throw directError;
        if (String(recovered.id) !== email.externalMessageId) {
            db.updateEmailExternalMessageId(email.emailId, String(recovered.id));
        }
        return recovered;
    }
}

function retryParsedEmail(retry: DueDocumentRetry): ParsedEmailInfo {
    if (retry.parsedEmail) return retry.parsedEmail;
    return {
        isMiFile: true,
        courtName: null,
        caseNumber: null,
        caseTitle: null,
        plaintiff: null,
        defendant: null,
        bundleNumber: null,
        filerName: null,
        submitterName: null,
        temporaryCaseNumber: null,
        newCaseNumber: null,
        filedAt: null,
        filedDocuments: [],
        fileTypeByAttachmentId: {},
    };
}

function retrySourceMessage(retry: DueDocumentRetry): any {
    return {
        id: retry.externalMessageId,
        subject: retry.subject,
        from: { emailAddress: { address: retry.sender } },
        receivedDateTime: retry.receivedAt,
    };
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
        const recoveredFiles: NotificationFile[] = [];
        const reportParsed = retryParsedEmail(retries[0]);
        let sourceMessage = retrySourceMessage(retries[0]);
        let recoveredMessagePromise: Promise<any> | null = null;
        const attachmentResolver = createEmailAttachmentResolver(async () => {
            recoveredMessagePromise ??= recoverOutlookMessage(db, retries[0]);
            sourceMessage = await recoveredMessagePromise;
            return sourceMessage;
        });

        db.markEmailRetrying(emailId);

        for (const retry of retries) {
            try {
                const parsed = retryParsedEmail(retry);
                const storedDocument = parsed.filedDocuments.find(document =>
                    normalizedDocumentUrl(document.downloadUrl) === normalizedDocumentUrl(retry.sourceUrl),
                );
                const usesInvalidTrueCertifyLink =
                    retry.sourceUrl.includes('truecertify.com') &&
                    !isUsableTrueCertifyUrl(retry.sourceUrl);
                const sourceUrl = usesInvalidTrueCertifyLink
                    ? createEmailAttachmentSource(
                        retry.documentName || retry.documentType || 'attachment.pdf',
                    )
                    : retry.sourceUrl;
                const retryDocument = {
                    documentName: retry.documentName ?? storedDocument?.documentName ?? null,
                    documentType: retry.documentType ?? storedDocument?.documentType ?? null,
                    status: storedDocument?.status ?? 'Filed',
                    comments: storedDocument?.comments ?? null,
                    downloadUrl: sourceUrl,
                };
                const oneDocumentParsed: ParsedEmailInfo = {
                    ...parsed,
                    isMiFile: true,
                    filedDocuments: [retryDocument],
                };
                const plaintiffNaming = lookupPlaintiffNaming(db, oneDocumentParsed);
                const result = await downloadFiledDocuments(
                    oneDocumentParsed,
                    'downloads',
                    retry.receivedAt ?? undefined,
                    {
                        plaintiffShortName: plaintiffNaming.shortName,
                        resolvePlaintiffNaming: () => lookupPlaintiffNaming(db, oneDocumentParsed),
                        resolveDocumentBuffer: isEmailAttachmentSource(sourceUrl)
                            ? attachmentResolver
                            : undefined,
                    },
                );
                const downloadedFile = result.downloaded[0];
                const notificationFile = result.notificationFiles[0];

                if (downloadedFile && notificationFile) {
                    db.completeDocumentRetrySuccess({
                        documentId: retry.documentId,
                        originalFilename: notificationFile.displayName || downloadedFile.documentName || null,
                        currentFilename: notificationFile.fileName,
                        sourceUrl: downloadedFile.downloadUrl ?? sourceUrl,
                        oneDriveUrl: notificationFile.webUrl ?? null,
                        storagePath: downloadedFile.localPath,
                        fileSize: notificationFile.buffer.length,
                        documentType: downloadedFile.documentType ?? retry.documentType,
                        uploadSource: isEmailAttachmentSource(sourceUrl)
                            ? 'email_attachment'
                            : sourceUrl.includes('truecertify.com')
                                ? 'truecertify'
                                : 'mifile',
                        downloadAttempts: downloadedFile.downloadAttempts ?? 0,
                        metadata: {
                            driveId: notificationFile.driveId,
                            itemId: notificationFile.itemId,
                            retrySource: retry.retrySource,
                        },
                    });
                    if (
                        caseDraftId &&
                        isComplaintDocument(
                            downloadedFile.documentType ?? retry.documentType,
                            notificationFile.fileName || notificationFile.displayName,
                        )
                    ) {
                        try {
                            const extraction = await extractComplaintPdf(
                                notificationFile.buffer,
                                downloadedFile.documentType ?? retry.documentType,
                            );
                            db.applyComplaintExtraction(
                                caseDraftId,
                                retry.documentId,
                                extraction,
                            );
                        } catch (error) {
                            console.warn(
                                `Complaint extraction skipped after retry ${retry.documentId}:`,
                                error instanceof Error ? error.message : String(error),
                            );
                        }
                    }
                    recoveredFiles.push(notificationFile);
                } else {
                    const failure = result.failures[0];
                    const failureInput = {
                        documentId: retry.documentId,
                        reason: failure?.reason ?? 'Retry finished without a downloaded PDF',
                        downloadAttempts: failure?.downloadAttempts ?? 0,
                        metadata: failure ?? { retrySource: retry.retrySource, sourceUrl },
                    };
                    if (failure && isNonDownloadableDocument(failure)) {
                        db.completeDocumentRetryNotDownloadable(failureInput);
                    } else {
                        db.completeDocumentRetryFailure(failureInput);
                    }
                }
            } catch (error) {
                console.error(`Document retry ${retry.documentId} failed:`, error);
                db.completeDocumentRetryFailure({
                    documentId: retry.documentId,
                    reason: error instanceof Error ? error.message : String(error),
                    downloadAttempts: 0,
                    metadata: { retrySource: retry.retrySource, sourceUrl: retry.sourceUrl },
                });
            }
        }

        db.refreshEmailAfterDocumentRetries(emailId, caseDraftId);
        const validatedDraft = caseDraftId
            ? db.refreshCaseDraftValidation(caseDraftId)
            : null;

        if (recoveredFiles.length) {
            try {
                const reportPlaintiffNaming = lookupPlaintiffNaming(db, reportParsed);
                await sendProcessingReport({
                    client: getGraphClient(),
                    subject: `MiFILE/TrueFiling retry completed: ${reportParsed.caseNumber ?? 'NO CASE'} - ${recoveredFiles.length} doc(s)`,
                    bodyText: buildSuccessBody({
                        msg: sourceMessage,
                        parsed: reportParsed,
                        files: recoveredFiles,
                        plaintiffFullName: reportPlaintiffNaming.fullName,
                        plaintiffShortName: reportPlaintiffNaming.shortName,
                        draftValidation: validatedDraft?.caseDraft
                            ? {
                                status: validatedDraft.caseDraft.status,
                                issues: validatedDraft.caseDraft.validationIssues,
                            }
                            : null,
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
    const pendingEmails = db.listPendingEmails(MAX_PENDING_EMAILS_PER_POLL);

    for (const pending of pendingEmails) {
        if (emailsById.has(pending.externalMessageId)) continue;
        try {
            const email = await recoverOutlookMessage(db, pending);
            emailsById.set(String(email.id), email);
        } catch (error) {
            db.markEmailFailed(
                pending.emailId,
                `Unable to fetch the source email for queued processing: ${
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
            parsed = addEmailAttachmentSources(parseEmailBody(bodyContent));
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
                    resolveDocumentBuffer: createEmailAttachmentResolver(async () => msg),
                },
            );

            await recordDownloadResults({
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
                if (failures.length && failures.every(isNonDownloadableDocument)) {
                    db.setCaseDraftStatus(
                        caseDraftId,
                        'needs_review',
                        'warnings',
                        'not_started',
                    );
                    db.markEmailProcessed(emailRecord.id);
                    console.warn(
                        'Email processed without file uploads because MiFILE exposes no downloadable PDF.',
                    );
                    continue;
                }
                throw new Error('No documents were downloaded or uploaded');
            }

            console.log(
                'Notification files:',
                notificationFiles.map(f => ({ name: f.fileName, url: f.webUrl })),
            );

            const validatedDraft = db.refreshCaseDraftValidation(caseDraftId);
            const draftValidation = validatedDraft.caseDraft
                ? {
                    status: validatedDraft.caseDraft.status,
                    issues: validatedDraft.caseDraft.validationIssues,
                }
                : null;
            console.log('Filing package validation:', {
                draftStatus: draftValidation?.status ?? 'missing',
                issues: draftValidation?.issues.map(issue => ({
                    severity: issue.severity,
                    message: issue.message,
                })) ?? [],
            });

            const subjectLine =
                `MiFILE/TrueFiling processed: ` +
                `${parsed.caseNumber ?? 'NO CASE'} - ${notificationFiles.length} doc(s)`;

            const bodyText = buildSuccessBody({
                msg,
                parsed,
                files: notificationFiles,
                plaintiffFullName: plaintiffNaming.fullName,
                plaintiffShortName: plaintiffNaming.shortName,
                draftValidation,
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

    const interruptedRetries = db.recoverInterruptedDocumentRetries();
    if (interruptedRetries > 0) {
        console.warn(
            `Rescheduled ${interruptedRetries} document retry job(s) interrupted by the previous worker shutdown.`,
        );
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
