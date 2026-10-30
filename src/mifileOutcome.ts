import { receiptSummary, type MiFileReceiptObservation } from './mifileCheckout';

export interface ReceiptCheckView {
    status: string;
    state: 'unsubmitted' | 'found' | 'inconclusive' | null;
    checkedAt: string | null;
}

export function mifileOutcome(observations: MiFileReceiptObservation[], documentIds: string[],
    check: ReceiptCheckView | null, evidenceInvalid = false, now = Date.now()) {
    const summary = receiptSummary(observations);
    const statuses = new Set(observations.map(item => item.status));
    const checked = check?.status === 'completed' && check.state !== 'inconclusive' && Boolean(check.checkedAt);
    const fresh = Boolean(checked && Number.isFinite(Date.parse(check!.checkedAt!)) &&
        Date.parse(check!.checkedAt!) <= now && now - Date.parse(check!.checkedAt!) < 15 * 60_000);
    const expected = new Set(documentIds);
    const filedCount = summary.courtFiledDocumentIds.filter(id => expected.has(id)).length;
    const rejectedCount = summary.courtRejectedDocumentIds.filter(id => expected.has(id)).length;
    const latestBundleStatus = [...observations].filter(item => !item.documentId && ['bundle_status','filing_status'].includes(item.kind))
        .sort((a,b) => Date.parse(b.occurredAt || b.observedAt)-Date.parse(a.occurredAt || a.observedAt))[0]?.status;
    let code = 'unknown', title = 'MiFILE status not checked', tone = 'neutral';
    let message = 'Preparation is complete. Payment and court filing have not been verified.';
    if (evidenceInvalid) {
        code = 'review_required'; title = 'Receipt evidence needs review'; tone = 'warning';
        message = 'Some receipt evidence cannot be verified. Check MiFILE; do not repeat payment or filing.';
    } else if (check && ['queued','running'].includes(check.status)) {
        code = 'checking'; title = 'Checking MiFILE status';
        message = 'Reading the existing bundle and receipts only. No payment or court submission is being attempted.';
    } else if (check && !checked) {
        code = 'review_required'; title = 'MiFILE status needs checking'; tone = 'warning';
        message = summary.submissionObserved
            ? 'The latest check was inconclusive. Earlier submission or payment evidence is retained; do not repeat the operation.'
            : 'The latest status check did not verify the result. Open MiFILE before retrying preparation or payment.';
    } else if (rejectedCount || latestBundleStatus === 'Rejected') {
        code = 'rejected'; title = 'Court rejection reported'; tone = 'warning';
        message = 'Review the rejection in MiFILE. A rejection does not prove a refund; do not pay or file again automatically.';
        const reason = [...observations].reverse().find(item => item.status === 'Rejected' && item.message)?.message;
        if (reason) message = 'MiFILE: ' + reason + ' Check the filing and refund in MiFILE before any retry.';
    } else if (expected.size && filedCount === expected.size) {
        code = 'filed'; title = 'All documents reported filed'; tone = 'success';
        message = 'MiFILE reported Filed for every expected document. Review the official court record in MiFILE.';
    } else if (filedCount) {
        code = 'partially_filed'; title = 'Some documents reported filed'; tone = 'warning';
        message = 'The remaining documents have no verified Filed result. Do not submit the entire package again.';
    } else if (latestBundleStatus === 'Filed') {
        code = 'bundle_filed'; title = 'MiFILE reports the bundle filed'; tone = 'success';
        message = 'The bundle status is Filed. Individual document results have not all been verified.';
    } else if (summary.refundReported) {
        code = 'refunded'; title = 'Refund reported'; tone = 'warning';
        message = 'A refund is reported, not a new authorization to pay or file again. Check the filing result in MiFILE.';
    } else if (summary.paymentRejected) {
        code = 'payment_rejected'; title = 'Payment rejection reported'; tone = 'warning';
        message = 'Check the payment result and saved bundle in MiFILE. No automatic payment retry is permitted.';
    } else if (summary.paymentReported) {
        code = 'payment_reported'; title = summary.verifiedPaymentReceipt ? 'Payment receipt verified' : 'Payment reported; receipt unverified';
        message = 'Payment is not court acceptance. Wait for a separate court filing result; do not pay again.';
    } else if (summary.submissionObserved) {
        code = 'submitted'; title = 'Submission activity reported';
        message = 'MiFILE reported submission activity. Payment and court acceptance must be verified separately.';
    } else if (check?.state === 'unsubmitted' && checked && statuses.has('Unsubmitted')) {
        code = 'unsubmitted'; title = 'Saved in MiFILE Unsubmitted';
        message = 'The latest check found the editable Unsubmitted bundle. This app has not paid or submitted it.';
    }
    return {code,title,tone,message,checkedAt:checked ? check!.checkedAt : null,fresh,
        filedDocuments:filedCount,rejectedDocuments:rejectedCount,expectedDocuments:expected.size,
        paymentReceiptVerified:summary.verifiedPaymentReceipt,submissionObserved:summary.submissionObserved};
}
