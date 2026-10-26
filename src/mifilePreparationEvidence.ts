import { createHash } from 'node:crypto';
import type { FilingJobView, FilingPayload } from './database';

export const REQUIRED_MIFILE_FILER = 'Devlin, Adam (P72877)';

export function isRequiredMiFileFiler(value: string): boolean {
    return value.trim().replace(/\s+/g, ' ').toLowerCase() === REQUIRED_MIFILE_FILER.toLowerCase();
}

export function isRequiredMiFileFilerOption(value: string): boolean {
    const normalized = value.trim().replace(/\s+/g, ' ');
    return isRequiredMiFileFiler(normalized) ||
        /^Name: Devlin, Adam, Role: Attorney, State: MI, Number: P72877, Organization: .+$/i.test(normalized);
}

export function miFileBundleId(url: string): string | null {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== 'https://mifile.courts.michigan.gov' || parsed.search || parsed.hash) return null;
        return parsed.pathname.match(/^\/filing\/create\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i)?.[1].toLowerCase() || null;
    } catch { return null; }
}

export function usdCents(value: string): number | null {
    const match = value.trim().match(/^\$?((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+))(?:\.(\d{2}))?$/);
    if (!match) return null;
    const result = Number(match[1].replace(/,/g, '')) * 100 + Number(match[2] || '0');
    return Number.isSafeInteger(result) ? result : null;
}

export interface FilingSourceFingerprint {
    documentId: string;
    sha256: string;
    bytes: number;
}

export function preparationDigest(payload: FilingPayload, sources: FilingSourceFingerprint[]): string {
    const ids = payload.documents.map(document => document.id);
    if (!ids.length || new Set(ids).size !== ids.length || sources.length !== ids.length ||
        new Set(sources.map(source => source.documentId)).size !== ids.length ||
        sources.some(source => !ids.includes(source.documentId) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
            !Number.isSafeInteger(source.bytes) || source.bytes <= 0)) {
        throw new Error('Each filing PDF needs one distinct source fingerprint.');
    }
    return createHash('sha256').update(JSON.stringify({ payload,
        sources: [...sources].sort((a, b) => a.documentId.localeCompare(b.documentId)) })).digest('hex');
}

export interface MiFileFeeObservation {
    source: 'unsubmitted_upload';
    currency: 'USD';
    observedAt: string;
    lines: Array<{ label: string; quantity: number | null; cents: number | null }>;
    displayedSubtotalCents: number | null;
    checkoutTotalCents: null;
    processingFeeCents: null;
}

export interface MiFileSavedBundleEvidence {
    version: 1;
    verifiedAt: string;
    externalBundleId: string;
    temporaryCaseNumber: string;
    accountEmail: string;
    filer: string;
    courtName: string;
    sourcePdfCount: number;
    connectedPdfCount: number;
    generatedPdfCount: number;
    packageDigest: string;
    sources: FilingSourceFingerprint[];
    fees: MiFileFeeObservation;
    paymentAuthorized: false;
    courtSubmissionAuthorized: false;
}

export function filingReleaseChecks(job: FilingJobView, currentAccount: {
    username: string; accountEnvironment: string; productionConfirmed: boolean;
} | null) {
    const evidence = job.result?.savedBundleEvidence as MiFileSavedBundleEvidence | undefined;
    let savedBundleVerified = false;
    let sourceSnapshotPinned = false;
    try {
        sourceSnapshotPinned = Boolean(job.payload && evidence?.version === 1 &&
            preparationDigest(job.payload, evidence.sources) === evidence.packageDigest);
        const manifest = job.result?.documentManifest;
        const primaryId = job.payload?.documents.find(document => document.isPrimary)?.id || null;
        savedBundleVerified = sourceSnapshotPinned && job.status === 'prepared' && evidence!.sourcePdfCount === job.payload!.documents.length &&
            Number.isFinite(Date.parse(evidence!.verifiedAt)) && evidence!.generatedPdfCount === 1 &&
            evidence!.courtName === job.payload!.courtName && evidence!.connectedPdfCount ===
                job.payload!.documents.filter(document => document.filingRelation === 'connected_to_complaint').length &&
            miFileBundleId(String(job.result?.url)) === evidence!.externalBundleId &&
            evidence!.externalBundleId === job.externalBundleId && evidence!.temporaryCaseNumber === job.temporaryCaseNumber &&
            isRequiredMiFileFiler(evidence!.filer) && Array.isArray(manifest) && manifest.length === job.payload!.documents.length &&
            new Set(manifest.map(receipt => receipt.documentId)).size === manifest.length &&
            job.payload!.documents.every(document => manifest.some(receipt => receipt.documentId === document.id &&
                receipt.filingName === document.filingName && receipt.filingRelation === document.filingRelation &&
                receipt.filingType === (document.filingRelation === 'connected_to_complaint' ? 'CONNECTED FILING' : document.filingType) &&
                receipt.parentDocumentId === (document.filingRelation === 'connected_to_complaint' ? primaryId : null)));
    } catch { /* Older or partial receipts cannot attest to a saved package. */ }
    const sameAccount = Boolean(savedBundleVerified && currentAccount?.username &&
        evidence?.accountEmail === currentAccount.username.trim().toLowerCase());
    const primaryAccountConfirmed = sameAccount && currentAccount?.accountEnvironment === 'production' &&
        currentAccount.productionConfirmed;
    const fees = savedBundleVerified ? evidence?.fees : undefined;
    const observedFees = fees?.source === 'unsubmitted_upload' && fees.currency === 'USD' &&
        fees.displayedSubtotalCents !== null && Number.isSafeInteger(fees.displayedSubtotalCents) && fees.displayedSubtotalCents >= 0
        ? fees.displayedSubtotalCents : null;
    return { savedBundleVerified, sourceSnapshotPinned, sameAccount, primaryAccountConfirmed,
        displayedSubtotalCents: observedFees, checkoutVerified: false as const,
        currentSourceContentVerified: false as const, finalActionsEnabled: false as const };
}
