import { createHash, randomUUID } from 'node:crypto';
import type { FilingJobView } from './database';
import { filingReleaseChecks, preparationDigest, usdCents, type MiFileSavedBundleEvidence } from './mifilePreparationEvidence';

export const CHECKOUT_REVIEW_LIFETIME_MS = 15 * 60_000;
export const FINAL_MIFILE_ACTIONS_ENABLED = false;

export interface CheckoutAccount {
    username: string;
    identity: string;
    accountEnvironment: string;
    productionConfirmed: boolean;
}

export interface CheckoutPaymentMethod {
    fingerprint: string;
    label: string;
}

export function validPaymentMethods(value: unknown): value is CheckoutPaymentMethod[] {
    return Array.isArray(value) && value.length <= 20 && value.every(item => item &&
        typeof item === 'object' && /^[a-f0-9]{64}$/.test(item.fingerprint) &&
        /^(?:Card|Bank account|Payment account)(?: ending \d{4}| [a-f0-9]{8})$/.test(item.label)) &&
        new Set(value.map(item => item.fingerprint)).size === value.length;
}

export interface CheckoutQuote {
    version: 1;
    id: string;
    filingJobId: string;
    bundleId: string;
    accountEmail: string;
    accountIdentity: string;
    packageDigest: string;
    quotedAt: string;
    expiresAt: string;
    currency: 'USD';
    lines: Array<{ label: string; cents: number }>;
    totalCents: number;
    processingFeeCents: number;
    paymentMethodState: 'missing' | 'not_selected' | 'selected' | 'not_required';
    paymentMethodFingerprint: string | null;
    availablePaymentMethods?: CheckoutPaymentMethod[];
    sourceContentVerified: true;
    quoteDigest: string;
    paymentAuthorized: false;
    courtSubmissionAuthorized: false;
}

export type ReceiptStatus = 'Unsubmitted' | 'Submitted' | 'In Progress' | 'Accepted' | 'Paid' |
    'Payment Rejected' | 'Filed' | 'Rejected' | 'Refunded' | 'Not Filed';

export interface MiFileReceiptObservation {
    bundleId: string;
    accountEmail: string;
    kind: 'bundle_status' | 'filing_status' | 'payment' | 'refund';
    externalReference: string;
    documentId: string | null;
    status: ReceiptStatus;
    occurredAt: string | null;
    observedAt: string;
    totalCents: number | null;
    currency: 'USD' | null;
    receiptUrl: string | null;
    source: 'mifile_history';
}

export interface CheckoutInspection {
    id: string;
    filingJobId: string;
    kind: 'quote' | 'receipts';
    status: 'queued' | 'running' | 'completed' | 'failed';
    stage: string;
    accountIdentity: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    result: CheckoutInspectionResult | null;
}

export type CheckoutInspectionResult = { kind: 'quote'; quote: CheckoutQuote } | {
    kind: 'receipts'; observations: MiFileReceiptObservation[];
    state: 'unsubmitted' | 'found' | 'inconclusive'; checkedAt: string; issue: string | null;
};

export function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function quoteDigest(quote: Omit<CheckoutQuote, 'quoteDigest'> | CheckoutQuote): string {
    const { quoteDigest: ignored, accountIdentity: privateIdentity, ...snapshot } = quote as CheckoutQuote;
    return digest(snapshot);
}

const feeLabels = new Set(['Filing Fee', 'eFiling System Fee', 'Processing Service Fee', 'Additional Payment', 'Tax']);

export function buildCheckoutQuote(job: FilingJobView, account: CheckoutAccount,
    rows: string[][], method: { state: CheckoutQuote['paymentMethodState']; fingerprint: string | null; available?: CheckoutPaymentMethod[] },
    currentPackageDigest: string, sourceFeeSubtotalCents: number, now = Date.now()): CheckoutQuote {
    const checks = filingReleaseChecks(job, account);
    const prepared = job.result?.savedBundleEvidence as MiFileSavedBundleEvidence | undefined;
    if (!checks.savedBundleVerified || !checks.sameAccount || currentPackageDigest !== prepared?.packageDigest ||
        !Number.isSafeInteger(sourceFeeSubtotalCents) || sourceFeeSubtotalCents < 0) {
        throw new Error('The saved bundle, account or source PDFs changed. Recheck the package before checkout.');
    }
    const lines: CheckoutQuote['lines'] = [];
    let totalCents: number | null = null;
    const seen = new Set<string>();
    for (const row of rows) {
        if (row.length !== 2) throw new Error('The checkout fee table has an unfamiliar structure.');
        const label = row[0].replace(/\s*\*\s*$/, '').trim().replace(/\s+/g, ' ');
        const cents = usdCents(row[1]);
        if (seen.has(label) || cents === null || (!feeLabels.has(label) && label !== 'Total')) {
            throw new Error('Checkout contains duplicate, unknown or unreadable fees. No amount was confirmed.');
        }
        seen.add(label);
        if (label === 'Total') totalCents = cents;
        else lines.push({ label, cents });
    }
    // MiFILE omits zero-valued fee rows. Every visible component must still reconcile exactly.
    if (totalCents === null || !Number.isSafeInteger(lines.reduce((sum, line) => sum + line.cents, 0)) ||
        lines.reduce((sum, line) => sum + line.cents, 0) !== totalCents ||
        lines.filter(line => ['Filing Fee', 'Additional Payment'].includes(line.label))
            .reduce((sum, line) => sum + line.cents, 0) !== sourceFeeSubtotalCents) {
        const componentTotal = lines.reduce((sum,line) => sum + line.cents,0);
        const filingSubtotal = lines.filter(line => ['Filing Fee','Additional Payment'].includes(line.label)).reduce((sum,line) => sum + line.cents,0);
        throw new Error('Checkout does not reconcile: displayed total ' + String(totalCents) +
            ' cents, fee components ' + componentTotal + ' cents, filing/additional fees ' + filingSubtotal +
            ' cents, verified bundle fees ' + sourceFeeSubtotalCents + ' cents. No amount was confirmed.');
    }
    if (method.state === 'selected' && !/^[a-f0-9]{64}$/.test(method.fingerprint || '')) {
        throw new Error('The selected payment method could not be identified safely.');
    }
    if (!['missing','not_selected','selected'].includes(method.state) ||
        method.state !== 'selected' && method.fingerprint !== null) {
        throw new Error('The payment account state is inconsistent. Refresh checkout.');
    }
    if (method.available !== undefined && (!validPaymentMethods(method.available) ||
        method.state === 'selected' && !method.available.some(item => item.fingerprint === method.fingerprint))) {
        throw new Error('The available payment accounts could not be verified safely.');
    }
    const snapshot: Omit<CheckoutQuote, 'quoteDigest'> = {
        version: 1, id: randomUUID(), filingJobId: job.id, bundleId: job.externalBundleId!,
        accountEmail: account.username.trim().toLowerCase(), accountIdentity: account.identity,
        packageDigest: currentPackageDigest, quotedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + CHECKOUT_REVIEW_LIFETIME_MS).toISOString(), currency: 'USD', lines, totalCents,
        processingFeeCents: lines.find(line => line.label === 'Processing Service Fee')?.cents || 0,
        paymentMethodState: totalCents === 0 ? 'not_required' : method.state,
        paymentMethodFingerprint: totalCents === 0 ? null : method.fingerprint,
        ...(method.available !== undefined ? {availablePaymentMethods:method.available} : {}),
        sourceContentVerified: true, paymentAuthorized: false, courtSubmissionAuthorized: false,
    };
    return { ...snapshot, quoteDigest: quoteDigest(snapshot) };
}

export function checkoutReviewIssues(quote: CheckoutQuote, job: FilingJobView, account: CheckoutAccount, now = Date.now()): string[] {
    const issues: string[] = [];
    if (!quote || typeof quote !== 'object' || !Array.isArray(quote.lines) ||
        quote.lines.some(line => !line || typeof line !== 'object')) return ['The stored checkout snapshot is invalid.'];
    const prepared = job.result?.savedBundleEvidence as MiFileSavedBundleEvidence | undefined;
    if (quote.version !== 1 || quote.quoteDigest !== quoteDigest(quote) || quote.currency !== 'USD' ||
        !Number.isSafeInteger(quote.totalCents) || quote.totalCents < 0 ||
        !Array.isArray(quote.lines) || quote.lines.some(line => !Number.isSafeInteger(line.cents) || line.cents < 0 || !feeLabels.has(line.label)) ||
        quote.lines.reduce((sum, line) => sum + line.cents, 0) !== quote.totalCents ||
        new Set(quote.lines.map(line => line.label)).size !== quote.lines.length ||
        quote.processingFeeCents !== (quote.lines.find(line => line.label === 'Processing Service Fee')?.cents || 0) ||
        quote.paymentAuthorized !== false || quote.courtSubmissionAuthorized !== false) issues.push('The stored checkout snapshot is invalid.');
    if (!['missing','not_selected','selected','not_required'].includes(quote.paymentMethodState) ||
        quote.totalCents === 0 && (quote.paymentMethodState !== 'not_required' || quote.paymentMethodFingerprint !== null) ||
        quote.totalCents > 0 && quote.paymentMethodState === 'not_required' ||
        quote.paymentMethodState !== 'selected' && quote.paymentMethodFingerprint !== null ||
        quote.availablePaymentMethods !== undefined && (!validPaymentMethods(quote.availablePaymentMethods) ||
            quote.paymentMethodState === 'selected' && !quote.availablePaymentMethods.some(item => item.fingerprint === quote.paymentMethodFingerprint))) {
        issues.push('The stored checkout snapshot is invalid.');
    }
    try {
        if (!filingReleaseChecks(job, account).sameAccount || quote.filingJobId !== job.id || quote.bundleId !== job.externalBundleId ||
            !prepared || !job.payload || quote.packageDigest !== prepared.packageDigest ||
            preparationDigest(job.payload, prepared.sources) !== quote.packageDigest) issues.push('The prepared package changed. Refresh checkout.');
    } catch { issues.push('The prepared package snapshot is invalid.'); }
    if (quote.accountIdentity !== account.identity || quote.accountEmail !== account.username.trim().toLowerCase()) {
        issues.push('The MiFILE account changed. Refresh checkout with the current account.');
    }
    const quotedAt = Date.parse(quote.quotedAt), expiresAt = Date.parse(quote.expiresAt);
    if (!Number.isFinite(quotedAt) || !Number.isFinite(expiresAt) || quotedAt > now + 5_000 ||
        expiresAt <= now || expiresAt - quotedAt !== CHECKOUT_REVIEW_LIFETIME_MS) issues.push('This checkout quote expired. Refresh checkout.');
    if (quote.sourceContentVerified !== true) issues.push('Source PDFs have not been checked against the preparation snapshot.');
    if (quote.totalCents > 0 && (quote.paymentMethodState !== 'selected' || !/^[a-f0-9]{64}$/.test(quote.paymentMethodFingerprint || ''))) {
        issues.push(quote.paymentMethodState === 'missing' ? 'Add a payment method in MiFILE, then refresh checkout. Nothing has been charged.' :
            (quote.availablePaymentMethods?.length ? 'Select the intended payment method below for a new fee check. Nothing has been charged.' :
                'Select the intended payment method in MiFILE, then refresh checkout. Nothing has been charged.'));
    }
    return issues;
}

const receiptStatuses = new Set<ReceiptStatus>(['Unsubmitted', 'Submitted', 'In Progress', 'Accepted', 'Paid',
    'Payment Rejected', 'Filed', 'Rejected', 'Refunded', 'Not Filed']);

export function validateReceipt(observation: MiFileReceiptObservation, job: FilingJobView, account: CheckoutAccount): void {
    if (observation.source !== 'mifile_history' || observation.bundleId !== job.externalBundleId ||
        observation.accountEmail !== account.username.trim().toLowerCase() ||
        !receiptStatuses.has(observation.status) || !observation.externalReference || observation.externalReference.length > 200 ||
        !Number.isFinite(Date.parse(observation.observedAt)) ||
        (observation.occurredAt !== null && !Number.isFinite(Date.parse(observation.occurredAt))) ||
        !['bundle_status', 'filing_status', 'payment', 'refund'].includes(observation.kind)) throw new Error('Receipt identity or status could not be verified.');
    if (observation.documentId !== null && !job.payload?.documents.some(document => document.id === observation.documentId)) {
        throw new Error('The receipt belongs to a different document.');
    }
    if (['payment', 'refund'].includes(observation.kind) && (observation.currency !== 'USD' ||
        !Number.isSafeInteger(observation.totalCents) || observation.totalCents! < 0)) throw new Error('A payment receipt requires its exact USD amount.');
    if ((observation.kind === 'payment' && !['Paid', 'Payment Rejected'].includes(observation.status)) ||
        (observation.kind === 'refund' && observation.status !== 'Refunded')) throw new Error('Receipt type and payment status disagree.');
    if (observation.receiptUrl) {
        const url = new URL(observation.receiptUrl);
        if (url.origin !== 'https://mifile.courts.michigan.gov' || url.username || url.password) throw new Error('Receipt URL is not a trusted MiFILE address.');
    }
}

export function receiptEventKey(observation: MiFileReceiptObservation): string {
    const { observedAt: ignored, ...event } = observation;
    return digest(event);
}

export function receiptSummary(observations: MiFileReceiptObservation[]) {
    const statuses = observations.map(item => item.status);
    const latestDocuments = new Map<string, MiFileReceiptObservation>();
    for (const item of [...observations].sort((a, b) => Date.parse(a.occurredAt || a.observedAt) - Date.parse(b.occurredAt || b.observedAt))) {
        if (item.documentId && ['Filed', 'Rejected'].includes(item.status)) latestDocuments.set(item.documentId, item);
    }
    return {
        submissionObserved: statuses.some(status => !['Unsubmitted', 'Not Filed'].includes(status)),
        paymentReported: statuses.includes('Paid'),
        verifiedPaymentReceipt: observations.some(item => item.kind === 'payment' && item.status === 'Paid' && item.totalCents !== null),
        refundReported: statuses.includes('Refunded'),
        paymentRejected: statuses.includes('Payment Rejected'),
        courtFiledDocumentIds: [...latestDocuments.values()].filter(item => item.status === 'Filed').map(item => item.documentId!),
        courtRejectedDocumentIds: [...latestDocuments.values()].filter(item => item.status === 'Rejected').map(item => item.documentId!),
        unknownResult: observations.length === 0,
        retryPaymentAllowed: false as const,
    };
}
