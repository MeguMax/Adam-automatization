import {receiptSummary, type MiFileReceiptObservation} from './mifileCheckout';

/** Submission, settlement and court acceptance are separate MiFILE events. */
export function submissionOutcome(observations: MiFileReceiptObservation[], expectedCents: number) {
    const summary = receiptSummary(observations);
    const submitted = observations.some(item => item.kind === 'bundle_status' &&
        ['Submitted','In Progress','Accepted','Filed'].includes(item.status));
    const payments = observations.filter(item => item.kind === 'payment' && item.status === 'Paid');
    const paymentMismatch = payments.some(item => item.currency !== 'USD' || item.totalCents !== expectedCents);
    const transactions = new Set(payments.map(item => item.externalReference));
    const duplicatePayment = transactions.size > 1;
    const paid = payments.some(item => item.currency === 'USD' && item.totalCents === expectedCents);
    const reviewRequired = paymentMismatch || duplicatePayment || summary.refundReported ||
        summary.paymentRejected || observations.some(item => item.status === 'Rejected');
    const paymentState = paymentMismatch || duplicatePayment ? 'review_required' : summary.refundReported ? 'refunded' :
        summary.paymentRejected ? 'rejected' : paid ? 'verified' : expectedCents === 0 ? 'not_required' :
            summary.paymentReported ? 'receipt_pending' : 'pending';
    return {submissionConfirmed: submitted, paymentState, reviewRequired,
        expectedTotalCents: expectedCents, currency:'USD' as const,
        filedDocumentIds: summary.courtFiledDocumentIds, rejectedDocumentIds: summary.courtRejectedDocumentIds,
        retryAllowed:false as const};
}
