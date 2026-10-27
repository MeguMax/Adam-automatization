import type { FilingJobView } from './database';
import type { CheckoutAccount, MiFileReceiptObservation, ReceiptStatus } from './mifileCheckout';
import { usdCents } from './mifilePreparationEvidence';
import type { Page } from 'playwright';
import type { CheckoutInspectionResult } from './mifileCheckout';
import { dismissMifilePreparationNotice } from './mifileSession';
import { inspectFilingPdf } from './pdfValidation';

export function parseReceiptStatus(value: string): ReceiptStatus | null {
    const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
    const statuses: ReceiptStatus[] = ['Unsubmitted', 'Submitted', 'In Progress', 'Accepted', 'Paid',
        'Payment Rejected', 'Filed', 'Rejected', 'Refunded', 'Not Filed'];
    return statuses.find(status => status.toLowerCase() === normalized) || null;
}

export function parseMiFileReceiptFields(fields: string[][], job: FilingJobView, account: CheckoutAccount,
    kind: 'payment' | 'refund', receiptUrl: string | null, now = Date.now()): MiFileReceiptObservation {
    const values = new Map<string, string>();
    for (const field of fields) {
        if (field.length !== 2) throw new Error('Unrecognized receipt field structure.');
        const key = field[0].trim().replace(/:$/, '').toLowerCase();
        if (values.has(key)) throw new Error('The receipt contains ambiguous repeated fields.');
        values.set(key, field[1].trim());
    }
    const bundle = values.get('bundle id') || values.get('bundle number');
    const reference = values.get('transaction id') || values.get('receipt number');
    const amount = values.get(kind === 'refund' ? 'total refunded' : 'total paid');
    const cents = amount ? usdCents(amount) : null;
    if (bundle !== job.externalBundleId || !reference || !/^[a-zA-Z0-9-]{6,100}$/.test(reference) ||
        cents === null || (values.has('currency') && values.get('currency') !== 'USD')) {
        throw new Error('The receipt bundle, transaction reference or exact USD total is missing or does not match.');
    }
    return { bundleId: bundle, accountEmail: account.username.trim().toLowerCase(), kind, externalReference:reference,
        documentId:null, status:kind === 'refund' ? 'Refunded' : 'Paid', totalCents:cents, currency:'USD',
        occurredAt:null, observedAt:new Date(now).toISOString(), receiptUrl, source:'mifile_history' };
}

export async function parseMiFileReceiptPdf(buffer: Buffer, job: FilingJobView, account: CheckoutAccount,
    kind: 'payment' | 'refund', receiptUrl: string | null): Promise<MiFileReceiptObservation> {
    const text = (await inspectFilingPdf(buffer)).join('\n');
    const labels = 'Bundle ID|Bundle Number|Transaction ID|Receipt Number|Total Paid|Total Refunded|Currency';
    const pattern = new RegExp('(?:^|\\s)(' + labels + ')\\s*:\\s*(.*?)' +
        '(?=\\s+(?:' + labels + ')\\s*:|$)', 'gis');
    const fields = [...text.matchAll(pattern)].map(match => [match[1],match[2].trim()]);
    return parseMiFileReceiptFields(fields, job, account, kind, receiptUrl);
}

export async function collectReceiptObservations(page: Page, job: FilingJobView, account: CheckoutAccount): Promise<CheckoutInspectionResult> {
    const checkedAt = new Date().toISOString();
    if (!job.externalBundleId || typeof job.result?.url !== 'string') throw new Error('The saved bundle reference is missing.');
    const url = new URL(job.result.url);
    if (url.origin !== 'https://mifile.courts.michigan.gov' ||
        url.pathname !== '/filing/create/' + job.externalBundleId) throw new Error('The saved MiFILE reference is not trusted.');
    await page.goto(url.href, {waitUntil:'domcontentloaded'});
    await page.locator('#documentTable').waitFor({state:'visible',timeout:15_000}).catch(() => {});
    await dismissMifilePreparationNotice(page);
    if (await page.locator('#documentTable').isVisible() &&
        (await page.getByRole('banner').innerText()).toLowerCase().includes(account.username) &&
        (await page.locator('main').innerText()).includes(job.temporaryCaseNumber || '\u0000')) {
        return {kind:'receipts', state:'unsubmitted', checkedAt, issue:null, observations:[{
            bundleId:job.externalBundleId, accountEmail:account.username, kind:'bundle_status',
            externalReference:job.externalBundleId, documentId:null, status:'Unsubmitted',
            occurredAt:null, observedAt:checkedAt, totalCents:null, currency:null, receiptUrl:null, source:'mifile_history',
        }]};
    }
    // A missing editable bundle is not proof of payment or submission. Only exact bundle-linked history is usable.
    await page.goto('https://mifile.courts.michigan.gov/filings/myHistory', {waitUntil:'domcontentloaded'});
    const history = page.getByRole('tabpanel', {name:'My History', exact:true});
    await history.waitFor({state:'visible'});
    const date = new Date(job.createdAt);
    if (!Number.isFinite(date.getTime())) throw new Error('The preparation date is invalid. Check MiFILE History manually.');
    date.setDate(date.getDate()-1);
    const formatted = (value:Date) => String(value.getMonth()+1).padStart(2,'0')+'/'+String(value.getDate()).padStart(2,'0')+'/'+value.getFullYear();
    await history.getByRole('textbox',{name:'Start Date:',exact:true}).fill(formatted(date));
    await history.getByRole('textbox',{name:'End Date:',exact:true}).fill(formatted(new Date()));
    await history.getByRole('button',{name:'Search',exact:true}).click();
    await history.getByText('Please wait...', {exact:true}).waitFor({state:'hidden'});
    if (!(await page.getByRole('banner').innerText()).toLowerCase().includes(account.username)) throw new Error('MiFILE history account could not be verified.');
    const linkedRows = history.locator('tr').filter({has:history.locator('a[href*="' + job.externalBundleId + '"]')});
    const count = await linkedRows.count();
    const observations: MiFileReceiptObservation[] = [];
    for (let index = 0; index < count; index++) {
        const row = linkedRows.nth(index);
        const cells = await row.locator('td').allTextContents();
        const statuses = cells.map(parseReceiptStatus).filter((status): status is ReceiptStatus => status !== null);
        if (statuses.length !== 1) continue;
        observations.push({bundleId:job.externalBundleId,accountEmail:account.username,kind:'bundle_status',
            externalReference:job.externalBundleId,status:statuses[0],documentId:null,occurredAt:null,observedAt:checkedAt,
            totalCents:null,currency:null,receiptUrl:null,source:'mifile_history'});
        const links = await row.getByRole('link').evaluateAll(elements => elements.filter(element =>
            /receipt/i.test((element as HTMLElement).innerText)).map(element => (element as HTMLAnchorElement).href));
        for (const link of links.slice(0,10)) {
            const receiptUrl = new URL(link);
            if (receiptUrl.origin !== url.origin || receiptUrl.username || receiptUrl.password) continue;
            const response = await page.request.get(receiptUrl.href,{maxRedirects:0,timeout:30_000});
            if (!response.ok() || !response.headers()['content-type']?.includes('application/pdf') ||
                Number(response.headers()['content-length'] || 0) > 5*1024*1024) continue;
            const content = await response.body();
            if (content.length > 5*1024*1024) continue;
            try {
                observations.push(await parseMiFileReceiptPdf(content,job,account,
                    statuses[0] === 'Refunded' ? 'refund' : 'payment',receiptUrl.href));
            } catch { /* Unknown receipt layouts remain unverified, never inferred from a Paid label. */ }
        }
    }
    return {kind:'receipts',observations,state:observations.length ? 'found' : 'inconclusive',checkedAt,
        issue:observations.length ? 'Status observed. An exact transaction receipt has not been verified; check MiFILE Status Updates.' :
            'The bundle could not be matched to a receipt with an exact reference. Check MiFILE History before any payment retry.'};
}
