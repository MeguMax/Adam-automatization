import {chromium, type Browser, type Page} from 'playwright';
import type {FilingJobView} from './database';
import {getMiFileCredentials} from './mifileAccountSettings';
import {getMiFileRuntimeConfig} from './mifileRuntimeConfig';
import {MiFileFilingRunner} from './mifileFilingRunner';
import {getCheckoutAccount, openCheckoutForInspection, readVerifiedCheckoutQuote} from './mifileCheckoutRunner';
import {selectPaymentMethodForQuote} from './mifilePaymentMethods';
import {collectReceiptObservations} from './mifileReceipts';
import {filingReleaseChecks,miFileBundleId} from './mifilePreparationEvidence';
import {digest, quoteDigest, FINAL_MIFILE_ACTIONS_ENABLED, type CheckoutAccount, type CheckoutQuote,
    type MiFileReceiptObservation} from './mifileCheckout';
import {executeSubmission, type SubmissionSnapshot, type SubmissionStore, type SubmissionTransport} from './mifileSubmission';
import {inspectCheckoutSubmitControl,waitForCheckoutSubmissionResult} from './mifileCheckoutControl';
import {observePaymentAccounts} from './mifilePaymentEvidence';

export function sameSubmissionCheckout(snapshot:SubmissionSnapshot,quote:CheckoutQuote,account:CheckoutAccount,now=Date.now()):boolean {
    return account.accountEnvironment==='production' && account.productionConfirmed &&
        account.identity===snapshot.accountIdentity && account.username.trim().toLowerCase()===snapshot.accountEmail &&
        quote.accountIdentity===account.identity && quote.accountEmail===snapshot.accountEmail &&
        quote.bundleId===snapshot.bundleId && quote.filingJobId===snapshot.filingJobId &&
        quote.totalCents===snapshot.totalCents && quote.currency===snapshot.currency &&
        quote.packageDigest===snapshot.packageDigest && quote.paymentMethodFingerprint===snapshot.paymentMethodFingerprint &&
        snapshot.feeLinesDigest===digest(quote.lines) && quoteDigest(quote)===quote.quoteDigest &&
        Date.parse(snapshot.expiresAt)>now && Date.parse(quote.expiresAt)>now;
}

export class MiFileSubmissionTransport implements SubmissionTransport {
    private browser:Browser|null=null;
    private page:Page|null=null;
    private snapshot:SubmissionSnapshot|null=null;
    private source:{packageDigest:string;sourceFeeSubtotalCents:number}|null=null;
    private clicked=false;
    private stopPaymentObservation:(()=>void)|null=null;
    private runner=new MiFileFilingRunner(()=>{});
    constructor(private store:SubmissionStore,private intentId:string,private job:FilingJobView,
        private account:CheckoutAccount,private progress:(stage:string)=>void=()=>{}) {}

    private assertIntent(phase:'checking'|'committing'):SubmissionSnapshot {
        const intent=this.store.get(this.intentId);
        if(!FINAL_MIFILE_ACTIONS_ENABLED || !getMiFileRuntimeConfig().ready ||
            getCheckoutAccount().identity!==this.account.identity || !intent || intent.status!==phase ||
            intent.attempts!==(phase==='committing'?1:0) || intent.snapshot.filingJobId!==this.job.id ||
            intent.snapshot.accountIdentity!==this.account.identity ||
            !filingReleaseChecks(this.job,this.account).primaryAccountConfirmed || filingReleaseChecks(this.job,this.account).testOnly ||
            this.snapshot && digest(this.snapshot)!==digest(intent.snapshot)) {
            throw new Error('The exact package does not have a current live submission authorization. No new payment attempt is allowed.');
        }
        return intent.snapshot;
    }
    async inspect(snapshot:SubmissionSnapshot) {
        if(this.page || digest(this.assertIntent('checking'))!==digest(snapshot))throw new Error('Submission inspection cannot be reused.');
        this.snapshot=snapshot;
        this.browser=await chromium.launch({headless:!['false','0'].includes(process.env.MIFILE_FILING_HEADLESS || 'true'),
            args:['--no-sandbox','--disable-dev-shm-usage']});
        this.page=await this.browser.newPage({viewport:{width:1440,height:1000}});
        this.page.setDefaultTimeout(45_000);this.page.setDefaultNavigationTimeout(60_000);
        this.progress('login');await this.runner.login(this.page,getMiFileCredentials());
        this.progress('checking_prior_activity');
        const receipts=await collectReceiptObservations(this.page,this.job,this.account,undefined,this.progress);
        if(receipts.kind!=='receipts' || receipts.state!=='unsubmitted')throw new Error('The existing bundle is not verified Unsubmitted. Do not retry submission.');
        this.progress('checking_sources_and_saved_bundle');
        this.source=await this.runner.inspectSavedForCheckout(this.page,this.job,this.account);
        if(!await this.page.getByRole('button',{name:'Save Progress',exact:true}).isEnabled()) {
            throw new Error('The verified bundle is no longer editable Unsubmitted.');
        }
        // Source hashing can take time. The reopened, verified editable bundle supplies fresh status evidence.
        const currentUnsubmitted:MiFileReceiptObservation={bundleId:snapshot.bundleId,accountEmail:this.account.username,
            kind:'bundle_status',externalReference:snapshot.bundleId,documentId:null,status:'Unsubmitted',
            occurredAt:null,observedAt:new Date().toISOString(),totalCents:null,currency:null,receiptUrl:null,source:'mifile_history'};
        this.stopPaymentObservation=observePaymentAccounts(this.page,snapshot.bundleId);
        await openCheckoutForInspection(this.page);
        if(snapshot.paymentMethodFingerprint)await selectPaymentMethodForQuote(this.page,snapshot.paymentMethodFingerprint);
        const quote=await readVerifiedCheckoutQuote(this.page,this.job,this.account,this.source);
        const control=await inspectCheckoutSubmitControl(this.page);
        if(!control.ready || !sameSubmissionCheckout(snapshot,quote,getCheckoutAccount())) {
            throw new Error(control.issue || 'The exact total, payment account or package changed. No payment attempted.');
        }
        return {quote,observations:[currentUnsubmitted],account:getCheckoutAccount()};
    }
    async submitOnce():Promise<void> {
        const snapshot=this.assertIntent('committing');
        if(this.clicked || !this.page || !this.source)throw new Error('The submission transport is not fresh. Do not retry payment.');
        if(miFileBundleId(this.page.url())!==snapshot.bundleId)throw new Error('Checkout left the authorized MiFILE bundle. Do not retry payment.');
        await this.runner.verifyAccount(this.page,this.account.username);
        const quote=await readVerifiedCheckoutQuote(this.page,this.job,this.account,this.source);
        const control=await inspectCheckoutSubmitControl(this.page);
        this.assertIntent('committing');
        if(!control.ready || !sameSubmissionCheckout(snapshot,quote,getCheckoutAccount()))throw new Error(
            control.issue || 'Checkout changed immediately before submission. Check MiFILE before any further action.');
        // Set before Playwright dispatch. A timeout must never cause a second click.
        this.clicked=true;this.progress('submitting_once');
        const dialog=this.page.getByRole('dialog').filter({has:this.page.getByRole('heading',{name:'Checkout',exact:true})}).last();
        await dialog.getByRole('button',{name:'Submit',exact:true}).click({timeout:15_000});
        await waitForCheckoutSubmissionResult(this.page);
        this.progress('reading_submission_result');
    }
    async receipts():Promise<MiFileReceiptObservation[]> {
        if(!this.page || !this.clicked)throw new Error('No submission was dispatched by this transport.');
        // Never click a second confirmation. Unknown dialogs and results go to reconciliation.
        const result=await collectReceiptObservations(this.page,this.job,this.account,undefined,this.progress);
        if(result.kind!=='receipts')throw new Error('The submission receipts could not be read. Do not retry.');
        return result.observations;
    }
    async close():Promise<void> {try{this.stopPaymentObservation?.();await this.browser?.close();}finally{this.browser=null;this.page=null;}}
}

export async function runAuthorizedSubmission(store:SubmissionStore,id:string,job:FilingJobView,
    progress:(stage:string)=>void=()=>{}):Promise<void> {
    const account=getCheckoutAccount();
    await executeSubmission(store,id,account,new MiFileSubmissionTransport(store,id,job,account,progress));
}
