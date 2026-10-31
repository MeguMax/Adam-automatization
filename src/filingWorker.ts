import { getWorkflowDatabase } from './database';
import { MiFileFilingError, MiFileFilingRunner } from './mifileFilingRunner';
import { getMiFileRuntimeConfig } from './mifileRuntimeConfig';
import { MiFileCheckoutRunner, getCheckoutAccount } from './mifileCheckoutRunner';
import { workerHealth } from './workerHealth';

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, delayMs);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

export async function runFilingWorker(options: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
} = {}): Promise<void> {
    const db = getWorkflowDatabase();
    const pollIntervalMs = Math.min(
        Math.max(options.pollIntervalMs ?? Number(process.env.MIFILE_FILING_POLL_MS || 5_000), 1_000),
        60_000,
    );
    workerHealth.start('mifile', pollIntervalMs);
    const recovered = db.recoverInterruptedFilingJobs();
    db.checkout().recover();
    if (recovered > 0) {
        console.warn(`Marked ${recovered} interrupted MiFILE job(s) as failed for safe retry.`);
    }
    console.log(`MiFILE filing worker enabled (poll ${pollIntervalMs} ms).`);

    try {
    while (!options.signal?.aborted) {
        workerHealth.work('mifile', 'checking');
        if (process.env.MIFILE_AUTO_PREPARE_ENABLED !== 'false' && getMiFileRuntimeConfig().ready) {
            try { db.queueValidatedIntakes(); }
            catch (error) { console.error('Automatic Unsubmitted preparation could not be queued:', error); }
        }
        const autoStatus = !['false','0','no','off'].includes((process.env.MIFILE_AUTO_STATUS_REFRESH_ENABLED || 'true').toLowerCase());
        const autoCheckout = !['false','0','no','off'].includes((process.env.MIFILE_AUTO_CHECKOUT_ENABLED || 'true').toLowerCase());
        if (autoStatus && autoCheckout && getMiFileRuntimeConfig().ready) {
            try { db.checkout().advanceAutomaticReadiness(getCheckoutAccount()); }
            catch (error) { console.error('Automatic read-only checkout checks could not be queued:',error); }
        }
        const inspection = db.checkout().claim();
        if (inspection) {
            workerHealth.work('mifile', 'checking_bundle', 300_000);
            try {
                const job = db.getFilingJob(inspection.filingJobId);
                if (!job) throw new Error('The prepared MiFILE job no longer exists.');
                if (inspection.kind === 'quote' && !db.checkout().state(job.id,getCheckoutAccount()).canInspect) {
                    throw new Error('The bundle needs reconciliation before checkout. Do not retry payment.');
                }
                const runner = new MiFileCheckoutRunner(stage => {
                    workerHealth.work('mifile', 'checking_bundle', 300_000);
                    db.checkout().progress(inspection.id, stage);
                });
                const choice = db.checkout().paymentMethodChoice(job.id,getCheckoutAccount());
                const {result,account} = await runner.inspect(inspection,job,choice);
                db.checkout().complete(inspection.id,result,account);
                workerHealth.finish('mifile');
            } catch (error) {
                workerHealth.finish('mifile', false);
                const message = error instanceof Error ? error.message : 'MiFILE inspection failed.';
                const diagnostic = /\b(?:locator|page|browser|frame)\.|strict mode violation|Timeout \d+ms/i.test(message);
                if (diagnostic) console.error(`[MiFILE checkout ${inspection.id}] Browser inspection could not complete:`,
                    message.split('Call log:')[0].slice(0,500));
                const stage = db.checkout().get(inspection.id)?.stage;
                const safeStage = {opening_saved_bundle:'opening the saved bundle', opening_history:'opening MiFILE History',
                    waiting_for_history:'waiting for MiFILE History results', reading_history_rows:'matching the exact bundle in History',
                    reading_receipt_documents:'reading receipt documents',login:'signing in',reading_receipts:'verifying the account',
                }[stage || ''];
                db.checkout().fail(inspection.id, diagnostic ?
                    'MiFILE could not be read reliably' + (safeStage ? ' while ' + safeStage : '') +
                    '. No payment or court submission was attempted. Refresh the check; contact support if it repeats.' : message);
            }
            continue;
        }
        const job = db.claimNextFilingJob();
        if (!job) {
            workerHealth.finish('mifile');
            await wait(pollIntervalMs, options.signal);
            continue;
        }

        console.log(
            `MiFILE job ${job.id} started for Draft ${job.caseDraftId} (attempt ${job.attemptNumber}).`,
        );
        const runner = new MiFileFilingRunner(entry => {
            workerHealth.work('mifile', 'preparing_bundle', 300_000);
            db.appendFilingJobLog(job.id, entry);
            console.log(`[MiFILE ${job.id}] ${entry.checkpoint}: ${entry.message}`);
        });
        try {
            workerHealth.work('mifile', 'preparing_bundle', 300_000);
            const result = await runner.prepare(job);
            db.completeFilingJob({
                filingJobId: job.id,
                status: 'prepared',
                checkpoint: result.checkpoint,
                externalBundleId: result.externalBundleId,
                temporaryCaseNumber: result.temporaryCaseNumber,
                result: {
                    url: result.url,
                    uploadedDocuments: result.uploadedDocuments,
                    mifileVersion: result.mifileVersion,
                    documentManifest: result.documentManifest || null,
                    savedBundleEvidence: result.savedBundleEvidence || null,
                },
                debugArtifactPath: result.screenshotPath,
                readinessAccount: autoStatus && autoCheckout ? getCheckoutAccount() : undefined,
            });
            console.log(`MiFILE job ${job.id} prepared and saved as an unsubmitted bundle.`);
            workerHealth.finish('mifile');
            try {
                if (autoStatus) {
                    if (!autoCheckout) db.checkout().refreshReceiptsIfDue(job.id,getCheckoutAccount());
                }
            } catch {
                console.warn('The initial read-only MiFILE status check could not be queued. The prepared bundle is unchanged.');
            }
        } catch (error) {
            workerHealth.finish('mifile', false);
            const filingError = error instanceof MiFileFilingError
                ? error
                : new MiFileFilingError(
                    error instanceof Error ? error.message : String(error),
                    'MIFILE_AUTOMATION_FAILED',
                    'unknown',
                );
            // Saving the initiation form already creates an Unsubmitted bundle.
            const outcomeUnknown = ['case_form', 'document_upload', 'save_progress', 'verify_saved_bundle', 'saved_unsubmitted'].includes(
                filingError.checkpoint,
            );
            const errorCode = outcomeUnknown
                ? 'UNSUBMITTED_OUTCOME_UNKNOWN'
                : filingError.code;
            const errorMessage = outcomeUnknown
                ? `${filingError.message} Check MiFILE History > Unsubmitted before retrying.`
                : filingError.message;
            db.appendFilingJobLog(job.id, {
                level: outcomeUnknown ? 'warning' : 'error',
                checkpoint: outcomeUnknown ? 'reconciliation_required' : filingError.checkpoint,
                message: errorMessage,
                details: { code: errorCode, originalCode: filingError.code, failedCheckpoint: filingError.checkpoint },
            });
            db.completeFilingJob({
                filingJobId: job.id,
                status: outcomeUnknown ? 'reconciliation_required' : 'failed',
                checkpoint: outcomeUnknown ? 'reconciliation_required' : filingError.checkpoint,
                errorCode,
                errorMessage,
                debugArtifactPath: filingError.debugArtifactPath,
            });
            console.error(
                `MiFILE job ${job.id} ${outcomeUnknown ? 'needs reconciliation' : 'failed'} at ${filingError.checkpoint}:`,
                errorMessage,
            );
        }
    }
    } finally { workerHealth.stop('mifile'); }
    console.log('MiFILE filing worker stopped.');
}
