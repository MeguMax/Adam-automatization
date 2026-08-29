import { getWorkflowDatabase } from './database';
import { MiFileFilingError, MiFileFilingRunner } from './mifileFilingRunner';

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
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
    const recovered = db.recoverInterruptedFilingJobs();
    if (recovered > 0) {
        console.warn(`Marked ${recovered} interrupted MiFILE job(s) as failed for safe retry.`);
    }
    console.log(`MiFILE filing worker enabled (poll ${pollIntervalMs} ms).`);

    while (!options.signal?.aborted) {
        const job = db.claimNextFilingJob();
        if (!job) {
            await wait(pollIntervalMs, options.signal);
            continue;
        }

        console.log(
            `MiFILE job ${job.id} started for Draft ${job.caseDraftId} (attempt ${job.attemptNumber}).`,
        );
        const runner = new MiFileFilingRunner(entry => {
            db.appendFilingJobLog(job.id, entry);
            console.log(`[MiFILE ${job.id}] ${entry.checkpoint}: ${entry.message}`);
        });
        try {
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
                },
                debugArtifactPath: result.screenshotPath,
            });
            console.log(`MiFILE job ${job.id} prepared and saved as an unsubmitted bundle.`);
        } catch (error) {
            const filingError = error instanceof MiFileFilingError
                ? error
                : new MiFileFilingError(
                    error instanceof Error ? error.message : String(error),
                    'MIFILE_AUTOMATION_FAILED',
                    'unknown',
                );
            db.appendFilingJobLog(job.id, {
                level: 'error',
                checkpoint: filingError.checkpoint,
                message: filingError.message,
                details: { code: filingError.code },
            });
            db.completeFilingJob({
                filingJobId: job.id,
                status: 'failed',
                checkpoint: filingError.checkpoint,
                errorCode: filingError.code,
                errorMessage: filingError.message,
                debugArtifactPath: filingError.debugArtifactPath,
            });
            console.error(`MiFILE job ${job.id} failed at ${filingError.checkpoint}:`, filingError.message);
        }
    }
    console.log('MiFILE filing worker stopped.');
}
