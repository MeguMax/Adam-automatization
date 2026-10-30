import type { FilingJobView } from './database';
import type { CheckoutAccount, MiFileReceiptObservation, ReceiptStatus } from './mifileCheckout';
import { filingReleaseChecks, isRequiredMiFileFiler, usdCents } from './mifilePreparationEvidence';
import type { Page, APIResponse } from 'playwright';
import type { CheckoutInspectionResult } from './mifileCheckout';
import { dismissMifilePreparationNotice, matchesMiFileAccountHeader } from './mifileSession';
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

function exactBundleLink(href: string, bundleId: string): boolean {
    try {
        const url = new URL(href);
        return url.origin === 'https://mifile.courts.michigan.gov' && !url.username && !url.password &&
            url.pathname.split('/').some(part => decodeURIComponent(part).toLowerCase() === bundleId.toLowerCase());
    } catch { return false; }
}

export function parseExpandedBundleHistory(bundleCells: string[], rows: Array<{cells:string[]; message:string | null}>,
    job: FilingJobView, account: CheckoutAccount, checkedAt = new Date().toISOString()): MiFileReceiptObservation[] {
    const clean = (value:string) => value.trim().replace(/\s+/g,' ');
    const bundle = bundleCells.map(clean), checks = filingReleaseChecks(job,account);
    if (!checks.savedBundleVerified || !checks.sameAccount || !job.payload || !job.externalBundleId ||
        !/^TEMP-[A-Z0-9]+$/i.test(job.temporaryCaseNumber || '') || bundle.length !== 7 ||
        !/^\d{6,16}$/.test(bundle[1]) || bundle[2] !== job.payload.courtName ||
        bundle[3] !== job.temporaryCaseNumber || !isRequiredMiFileFiler(bundle[5])) return [];
    const documents = new Map(job.payload.documents.map(document => [document.filingName,document]));
    if (documents.size !== job.payload.documents.length) return [];
    const found = new Set<string>(), systemRows = new Set<string>(), observations:MiFileReceiptObservation[] = [];
    for (const row of rows) {
        const cells = row.cells.map(clean);
        if (cells.length !== 9 || cells[1] !== bundle[2] || cells[2] !== bundle[3] ||
            !isRequiredMiFileFiler(cells[6])) return [];
        const status = parseReceiptStatus(cells[8]);
        if (!status) return [];
        const document = documents.get(cells[3]);
        const systemForm = cells[3] === 'Case Initiation Form' && cells[4] === 'ISI_CASE_INIT_FORM_DT';
        const mailingFee = cells[3] === 'Mailing Fee' && cells[4] === 'Mailing Fee';
        if (!document && !systemForm && !mailingFee) return [];
        if (!document) {
            if (systemRows.has(cells[3])) return [];
            systemRows.add(cells[3]);
        }
        if (document) {
            const expectedType = document.filingRelation === 'connected_to_complaint' ? 'CONNECTED FILING' : document.filingType;
            if (found.has(document.id) || cells[4] !== expectedType) return [];
            found.add(document.id);
        }
        const message = row.message ? clean(row.message).slice(0,1500) : null;
        observations.push({bundleId:job.externalBundleId,accountEmail:account.username.trim().toLowerCase(),
            kind:document ? 'filing_status' : 'bundle_status',documentId:document?.id || null,status,
            externalReference:'bundle-index:' + bundle[1] + ':' + (document?.id || (systemForm ? 'initiation' : 'mailing')),
            occurredAt:null,observedAt:checkedAt,totalCents:null,currency:null,receiptUrl:null,source:'mifile_history',message});
    }
    return found.size === documents.size && systemRows.has('Case Initiation Form') ? observations : [];
}

export async function collectReceiptObservations(page: Page, job: FilingJobView, account: CheckoutAccount,
    fetchReceipt: (href:string) => Promise<Pick<APIResponse,'ok'|'headers'|'body'>> = href =>
        page.request.get(href,{maxRedirects:0,timeout:30_000}), progress: (stage:string)=>void = ()=>{}): Promise<CheckoutInspectionResult> {
    const checkedAt = new Date().toISOString();
    if (!job.externalBundleId || typeof job.result?.url !== 'string') throw new Error('The saved bundle reference is missing.');
    const url = new URL(job.result.url);
    if (url.origin !== 'https://mifile.courts.michigan.gov' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/filing/create/' + job.externalBundleId) throw new Error('The saved MiFILE reference is not trusted.');
    progress('opening_saved_bundle');
    await page.goto(url.href, {waitUntil:'domcontentloaded'});
    if (page.url() === url.href) await page.locator('#documentTable').waitFor({state:'visible',timeout:15_000}).catch(() => {});
    await dismissMifilePreparationNotice(page);
    if (page.url() === url.href && await page.locator('#documentTable').isVisible() &&
        await page.getByRole('button',{name:'Save Progress',exact:true}).isVisible() &&
        await page.getByRole('button',{name:'Save Progress',exact:true}).isEnabled() &&
        await matchesMiFileAccountHeader(page,account.username) &&
        (await page.locator('main').innerText()).includes(job.temporaryCaseNumber || '\u0000')) {
        return {kind:'receipts', state:'unsubmitted', checkedAt, issue:null, observations:[{
            bundleId:job.externalBundleId, accountEmail:account.username, kind:'bundle_status',
            externalReference:job.externalBundleId, documentId:null, status:'Unsubmitted',
            occurredAt:null, observedAt:checkedAt, totalCents:null, currency:null, receiptUrl:null, source:'mifile_history',
        }]};
    }
    // A missing editable bundle is not proof of payment or submission. Only exact bundle-linked history is usable.
    progress('opening_history');
    await page.goto('https://mifile.courts.michigan.gov/filings/myHistory', {waitUntil:'domcontentloaded'});
    const historyTab = page.getByRole('tab',{name:'My History',exact:true});
    await historyTab.waitFor({state:'visible',timeout:90_000});
    if (await historyTab.getAttribute('aria-selected') !== 'true') await historyTab.click();
    const history = page.getByRole('tabpanel', {name:'My History', exact:true});
    await history.waitFor({state:'attached',timeout:90_000});
    // MiFILE's floating history form can be visible outside a zero-height panel.
    await history.getByRole('textbox',{name:'Start Date:',exact:true}).waitFor({state:'visible',timeout:90_000});
    const date = new Date(job.createdAt);
    if (!Number.isFinite(date.getTime())) throw new Error('The preparation date is invalid. Check MiFILE History manually.');
    date.setDate(date.getDate()-1);
    const formatted = (value:Date) => String(value.getMonth()+1).padStart(2,'0')+'/'+String(value.getDate()).padStart(2,'0')+'/'+value.getFullYear();
    await history.getByRole('textbox',{name:'Start Date:',exact:true}).fill(formatted(date));
    await history.getByRole('textbox',{name:'End Date:',exact:true}).fill(formatted(new Date()));
    progress('waiting_for_history');
    await history.getByRole('button',{name:'Search',exact:true}).click();
    const waitForHistory = () => history.getByText('Please wait...', {exact:true}).waitFor({state:'hidden',timeout:90_000});
    await waitForHistory();
    await history.locator('#searchResultsStatus').filter({hasText:'Search complete.'}).waitFor({state:'attached',timeout:90_000});
    if (!await matchesMiFileAccountHeader(page,account.username)) throw new Error('MiFILE history account could not be verified.');
    const view = history.locator('#historyViewTypeSelect');
    await view.waitFor({state:'visible',timeout:90_000});
    await view.selectOption({label:'Bundle View'});
    await waitForHistory();
    const table = history.locator('#bundleHistoryTable');
    await table.waitFor({state:'visible',timeout:90_000});
    const observations: MiFileReceiptObservation[] = [];
    let receiptErrors = 0;
    const seenPages = new Set<string>(), deadline = Date.now()+120_000;
    for (let pageIndex=0;pageIndex<100 && Date.now()<deadline;pageIndex++) {
        progress('reading_history_rows');
        const signature = JSON.stringify(await table.locator('tbody').allTextContents());
        if (seenPages.has(signature)) throw new Error('MiFILE History did not advance to another page. Check the existing bundle manually; do not retry payment.');
        seenPages.add(signature);
        const linkedRows = table.locator('tr').filter({visible:true,has:page.locator('a[href*="' + job.externalBundleId + '" i]')});
        const count = await linkedRows.count();
        for (let index = 0; index < count; index++) {
            const row = linkedRows.nth(index);
            const rowLinks = await row.getByRole('link').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href));
            if (!rowLinks.some(link => exactBundleLink(link,job.externalBundleId!))) continue;
            const cells = await row.locator('td').allTextContents();
            const statuses = cells.map(parseReceiptStatus).filter((status): status is ReceiptStatus => status !== null);
            if (statuses.length !== 1) continue;
            observations.push({bundleId:job.externalBundleId,accountEmail:account.username,kind:'bundle_status',
                externalReference:job.externalBundleId,status:statuses[0],documentId:null,occurredAt:null,observedAt:checkedAt,
                totalCents:null,currency:null,receiptUrl:null,source:'mifile_history'});
            const links = await row.getByRole('link').evaluateAll(elements => elements.filter(element =>
                /receipt/i.test((element as HTMLElement).innerText)).map(element => (element as HTMLAnchorElement).href));
            for (const link of links.slice(0,10)) {
                try {
                    progress('reading_receipt_documents');
                    const receiptUrl = new URL(link);
                    if (receiptUrl.origin !== url.origin || receiptUrl.username || receiptUrl.password) throw new Error('Untrusted receipt');
                    const response = await fetchReceipt(receiptUrl.href);
                    if (!response.ok() || !response.headers()['content-type']?.includes('application/pdf') ||
                        Number(response.headers()['content-length'] || 0) > 5*1024*1024) throw new Error('Unreadable receipt');
                    const content = await response.body();
                    if (content.length > 5*1024*1024) throw new Error('Oversized receipt');
                    observations.push(await parseMiFileReceiptPdf(content,job,account,
                        statuses[0] === 'Refunded' ? 'refund' : 'payment',receiptUrl.href));
                } catch { receiptErrors++; /* Preserve the observed status even when its receipt cannot be fetched. */ }
            }
        }
        // Current Bundle View exposes expandable rows, not bundle hyperlinks. A saved TEMP number,
        // exact court/filer and the complete pinned PDF manifest must agree before using those statuses.
        const expandable = table.locator(':scope > tbody > tr[role="button"]');
        for (let index=0;index<await expandable.count();index++) {
            const row = expandable.nth(index), cells = await row.locator(':scope > td').allTextContents();
            if (cells.length !== 7 || cells[2].trim() !== job.payload?.courtName ||
                cells[3].trim() !== job.temporaryCaseNumber || !isRequiredMiFileFiler(cells[5])) continue;
            progress('reading_history_rows');
            if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
            const details = row.locator('xpath=following-sibling::tr[1]').locator('#historyTable');
            await details.waitFor({state:'visible',timeout:90_000});
            const length = details.locator('..').locator('select[aria-controls="historyTable"]');
            if (await length.count() === 1) await length.selectOption('25');
            const readRows = () => details.locator(':scope > tbody > tr[role="button"]').evaluateAll(elements => elements.map(element => ({
                cells:[...element.querySelectorAll(':scope > td')].map(cell => (cell as HTMLElement).innerText),
                message:element.nextElementSibling?.classList.contains('child') ? (element.nextElementSibling as HTMLElement).innerText : null,
            })));
            const rows = await readRows();
            const next = details.locator('..').getByRole('button',{name:'Next page',exact:true});
            if (await next.count() === 1 && await next.isEnabled()) continue;
            observations.push(...parseExpandedBundleHistory(cells,rows,job,account,checkedAt));
        }
        if (observations.length) break;
        const next = history.getByRole('button',{name:'Next page',exact:true}).filter({visible:true});
        if (await next.count() !== 1 || !await next.isEnabled() || await next.getAttribute('aria-disabled') === 'true') break;
        progress('waiting_for_history');
        await next.click();
        await waitForHistory();
    }
    return {kind:'receipts',observations,state:observations.length ? 'found' : 'inconclusive',checkedAt,
        issue:receiptErrors ? 'Some receipt links could not be verified. Reported statuses are retained; check MiFILE before any payment retry.' :
            observations.some(item => item.kind === 'payment' || item.kind === 'refund') ? null : observations.length ?
            'Status observed. An exact transaction receipt has not been verified; check MiFILE Status Updates.' :
            'The bundle could not be matched to a receipt with an exact reference. Check MiFILE History before any payment retry.'};
}
