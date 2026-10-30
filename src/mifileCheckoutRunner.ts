import { chromium, type Page } from 'playwright';
import type { FilingJobView } from './database';
import { getMiFileCredentials, miFileCredentialIdentity } from './mifileAccountSettings';
import { getMiFileRuntimeConfig } from './mifileRuntimeConfig';
import { MiFileFilingRunner } from './mifileFilingRunner';
import { buildCheckoutQuote, digest, type CheckoutAccount, type CheckoutInspection,
    type CheckoutInspectionResult, type CheckoutQuote } from './mifileCheckout';
import { collectReceiptObservations } from './mifileReceipts';
import { readPaymentMethods, selectPaymentMethodForQuote } from './mifilePaymentMethods';

export function getCheckoutAccount(): CheckoutAccount {
    const credentials = getMiFileCredentials();
    return { username: credentials.username.trim().toLowerCase(),
        identity: digest([miFileCredentialIdentity(credentials), credentials.accountEnvironment,
            credentials.productionConfirmed, credentials.source]),
        accountEnvironment: credentials.accountEnvironment, productionConfirmed: credentials.productionConfirmed };
}

// This allow-list contains navigation only. No payment, waiver or submission control is used.
export async function openCheckoutForInspection(page: Page): Promise<void> {
    await page.getByRole('button', {name:'Next', exact:true}).click();
    const checkout = page.getByRole('dialog').filter({has:page.getByRole('heading', {name:'Checkout', exact:true})}).last();
    const warning = page.getByRole('dialog').filter({has:page.getByRole('heading', {name:'Case Initiation Warning', exact:true})}).last();
    await checkout.or(warning).first().waitFor({state:'visible'});
    if (!await checkout.isVisible()) {
        const text = (await warning.innerText()).replace(/\s+/g, ' ');
        if (!text.includes('After submitting, you will no longer be able to file documents to this case until a case number has been assigned.') ||
            !text.includes('If you would like to file additional documents to this case immediately, please cancel and add them now.')) {
            throw new Error('An unfamiliar MiFILE warning requires manual review. Checkout was not confirmed.');
        }
        await warning.getByRole('button', {name:'Continue', exact:true}).click();
    }
    await checkout.waitFor({state:'visible'});
}

export async function readCheckoutForInspection(page: Page): Promise<{
    rows: string[][]; method: Awaited<ReturnType<typeof readPaymentMethods>>
}> {
    const dialog = page.getByRole('dialog').filter({has:page.getByRole('heading', {name:'Checkout', exact:true})}).last();
    const rows = await dialog.getByRole('table', {name:'Fees', exact:true}).locator('tbody tr').evaluateAll(elements =>
        elements.filter(element => element.getClientRects().length > 0).map(element =>
            Array.from(element.children).map(cell => (cell as HTMLElement).innerText.trim())));
    return {rows, method:await readPaymentMethods(page)};
}

export async function readVerifiedCheckoutQuote(page: Page, job: FilingJobView, account: CheckoutAccount,
    source: {packageDigest:string;sourceFeeSubtotalCents:number}): Promise<CheckoutQuote> {
    const deadline = Date.now()+15_000;
    let signature = '', stableSince = 0;
    let lastError: unknown = new Error('Checkout fees did not finish loading.');
    do {
        try {
            const snapshot = await readCheckoutForInspection(page);
            const quote = buildCheckoutQuote(job,account,snapshot.rows,snapshot.method,source.packageDigest,source.sourceFeeSubtotalCents);
            const current = digest(snapshot);
            if (signature === current && Date.now()-stableSince >= (snapshot.method.available.length ? 500 : 2_000)) return quote;
            if (signature !== current) { signature=current;stableSince=Date.now(); }
        } catch(error) {
            if (!(error instanceof Error) || !error.message.includes('does not reconcile') &&
                !error.message.startsWith('MiFILE payment accounts are not readable yet.')) throw error;
            signature=''; lastError=error;
        }
        await page.waitForTimeout(250);
    } while(Date.now()<deadline);
    throw lastError;
}

export class MiFileCheckoutRunner {
    constructor(private progress: (stage:string) => void = () => {}) {}

    async inspect(inspection: CheckoutInspection, job: FilingJobView, paymentMethodFingerprint?: string | null): Promise<{result:CheckoutInspectionResult; account:CheckoutAccount}> {
        const account = getCheckoutAccount(), runtime = getMiFileRuntimeConfig();
        if (!runtime.ready || account.identity !== inspection.accountIdentity || job.id !== inspection.filingJobId) {
            throw new Error('The configured MiFILE account changed or is not ready. Start a new read-only check.');
        }
        const browser = await chromium.launch({headless: !['false','0'].includes(
            process.env.MIFILE_FILING_HEADLESS ?? process.env.TRUECERTIFY_HEADLESS ?? 'true'),
            args:['--no-sandbox','--disable-dev-shm-usage']});
        try {
            const page = await browser.newPage({viewport:{width:1440,height:1000}});
            page.setDefaultTimeout(45_000);
            page.setDefaultNavigationTimeout(60_000);
            this.progress('login');
            const runner = new MiFileFilingRunner(() => {});
            await runner.login(page, getMiFileCredentials());
            let result: CheckoutInspectionResult;
            if (inspection.kind === 'quote') {
                this.progress('checking_sources_and_saved_bundle');
                const source = await runner.inspectSavedForCheckout(page, job, account);
                this.progress('reading_checkout');
                await openCheckoutForInspection(page);
                if (paymentMethodFingerprint) {
                    this.progress('selecting_reviewed_account_for_quote');
                    await selectPaymentMethodForQuote(page, paymentMethodFingerprint);
                }
                const quote = await readVerifiedCheckoutQuote(page, job, account, source);
                const dialog = page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Checkout',exact:true})}).last();
                await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
                await dialog.waitFor({state:'hidden'});
                result = {kind:'quote',quote};
            } else {
                this.progress('reading_receipts');
                await runner.verifyAccount(page, account.username);
                result = await collectReceiptObservations(page, job, account, undefined, this.progress);
            }
            if (getCheckoutAccount().identity !== account.identity) throw new Error('MiFILE account changed during inspection.');
            return {result,account};
        } finally { await browser.close(); }
    }
}
