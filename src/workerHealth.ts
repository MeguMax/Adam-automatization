export type WorkerId = 'inbox' | 'extraction' | 'mifile';
export type WorkerPhase = 'starting' | 'checking' | 'fetching_email' | 'processing_email' |
    'retrying_document' | 'downloading_pdf' | 'recognizing_pdf' | 'extracting_complaint' |
    'adding_forms' | 'preparing_bundle' | 'checking_bundle';
const labels: Record<WorkerPhase, string> = {
    starting: 'Starting', checking: 'Checking for work', fetching_email: 'Reading an email',
    processing_email: 'Processing an email', retrying_document: 'Retrying a document',
    downloading_pdf: 'Downloading a PDF', recognizing_pdf: 'Recognizing a PDF',
    extracting_complaint: 'Reading Complaint fields', adding_forms: 'Adding library forms',
    preparing_bundle: 'Preparing Unsubmitted', checking_bundle: 'Checking a saved bundle',
};
const names: Record<WorkerId, string> = { inbox: 'Email processing', extraction: 'PDF recognition', mifile: 'MiFILE preparation' };
interface Entry {
    state: 'working' | 'idle' | 'error' | 'stopped' | 'disabled';
    phase: WorkerPhase; progressAt: number; successfulAt: number | null; deadline: number; pollMs: number;
}

/** Process-local progress only; liveness must not restart a server during an uncertain MiFILE write. */
export class WorkerHealth {
    private entries = new Map<WorkerId, Entry>();
    constructor(private now = Date.now) {}
    start(id: WorkerId, pollMs: number): void {
        this.entries.set(id, { state: 'working', phase: 'starting', progressAt: this.now(), successfulAt: null,
            deadline: this.now() + 180_000, pollMs: Math.max(1000, Number.isFinite(pollMs) ? pollMs : 10_000) });
    }
    work(id: WorkerId, phase: WorkerPhase, budgetMs = 180_000): void {
        const entry = this.entries.get(id);
        if (!entry || ['disabled', 'stopped'].includes(entry.state)) return;
        entry.state = 'working'; entry.phase = Object.prototype.hasOwnProperty.call(labels, phase) ? phase : 'checking';
        entry.progressAt = this.now(); entry.deadline = this.now() + Math.min(900_000, Math.max(10_000, budgetMs));
    }
    finish(id: WorkerId, ok = true): void {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.state = ok ? 'idle' : 'error'; entry.progressAt = this.now();
        entry.deadline = this.now() + Math.max(60_000, entry.pollMs * 3);
        if (ok) entry.successfulAt = this.now();
    }
    stop(id: WorkerId): void { const entry = this.entries.get(id); if (entry) entry.state = 'stopped'; }
    disable(id: WorkerId): void {
        this.start(id, 10_000); this.entries.get(id)!.state = 'disabled';
    }
    snapshot() {
        const now = this.now();
        const workers = (Object.keys(names) as WorkerId[]).map(id => {
            const entry = this.entries.get(id);
            const hasProgress = entry && entry.state !== 'disabled';
            const state = !entry ? 'not_started' : ['working','idle'].includes(entry.state) && now > entry.deadline ? 'stalled' : entry.state;
            return { id, name: names[id], state, phase: entry?.state === 'working' ? labels[entry.phase] : null,
                lastProgressAt: hasProgress ? new Date(entry.progressAt).toISOString() : null,
                lastSuccessfulCycleAt: entry?.successfulAt == null ? null : new Date(entry.successfulAt).toISOString(),
                elapsedSeconds: hasProgress ? Math.max(0, Math.floor((now - entry.progressAt) / 1000)) : null,
                attention: ['stalled', 'error', 'stopped'].includes(state) };
        });
        return { checkedAt: new Date(now).toISOString(), attention: workers.some(worker => worker.attention), workers };
    }
}
export const workerHealth = new WorkerHealth();

export function watchWorkerHealth(health = workerHealth, warn: (message: string) => void = console.warn): () => void {
    const reported = new Map<string, string>();
    const timer = setInterval(() => {
        for (const worker of health.snapshot().workers) {
            if (worker.attention && reported.get(worker.id) !== worker.state) {
                warn(`Background worker needs attention: ${worker.name} (${worker.state}). Check admin worker status and job activity.`);
            }
            reported.set(worker.id, worker.state);
        }
    }, 15_000).unref();
    return () => clearInterval(timer);
}
