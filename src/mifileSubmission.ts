import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FilingJobView} from './database';
import type {CheckoutStore} from './checkoutStore';
import {bundleExecutionKey,rememberBundleActivity} from './mifileBundleSafety';
import {checkoutReviewIssues,digest,FINAL_MIFILE_ACTIONS_ENABLED,receiptSummary,validateReceipt,
    type CheckoutAccount,type CheckoutQuote,type MiFileReceiptObservation} from './mifileCheckout';

export interface SubmissionSnapshot {
    version:1;filingJobId:string;bundleId:string;accountEmail:string;accountIdentity:string;executionKey:string;
    quoteId:string;quoteDigest:string;packageDigest:string;totalCents:number;currency:'USD';
    paymentMethodFingerprint:string|null;expiresAt:string;
}
type IntentStatus='rehearsed'|'authorized'|'checking'|'committing'|'blocked'|'reconciliation_required'|'submitted';
interface SubmissionIntent {id:string;status:IntentStatus;snapshot:SubmissionSnapshot;attempts:number;createdAt:string;updatedAt:string;error:string|null}
export class SubmissionStore {
    constructor(private db:DatabaseSync,private checkout:CheckoutStore,private job:(id:string)=>FilingJobView|null,
        private audit:(id:string,action:string,details:Record<string,unknown>)=>void,
        private enabled:()=>boolean=()=>FINAL_MIFILE_ACTIONS_ENABLED) {}
    private transaction<T>(action:()=>T):T {
        this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}
        catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    get(id:string):SubmissionIntent|null {
        const row=this.db.prepare('SELECT * FROM mifile_submission_intents WHERE id=?').get(id) as any;
        if(!row)return null;
        const snapshot=JSON.parse(row.snapshot_json) as SubmissionSnapshot;
        if(snapshot.version!==1 || digest(snapshot)!==row.snapshot_digest ||
            snapshot.executionKey!==row.execution_key || snapshot.executionKey!==bundleExecutionKey(snapshot.accountEmail,snapshot.bundleId) ||
            !Number.isSafeInteger(snapshot.totalCents) || snapshot.totalCents<0 || snapshot.currency!=='USD' ||
            !Number.isFinite(Date.parse(snapshot.expiresAt)))throw new Error('Submission evidence is invalid. Reconciliation is required.');
        return {id:row.id,status:row.status,snapshot,attempts:row.attempt_count,createdAt:row.created_at,updatedAt:row.updated_at,error:row.error_message};
    }
    private snapshot(filingJobId:string,account:CheckoutAccount,now:number):SubmissionSnapshot {
        const state=this.checkout.state(filingJobId,account,now),q=state.quote;
        if(!q || !state.preflight.complete || !state.preflight.recordedAt || state.active || state.priorBundleActivity ||
            state.receiptSummary.submissionObserved)throw new Error('Complete a fresh exact-amount review and Unsubmitted receipt check first.');
        const rows=this.db.prepare(`SELECT result_json FROM mifile_checkout_inspections WHERE filing_job_id=?
            AND kind='quote' AND status='completed' ORDER BY created_at DESC,rowid DESC LIMIT 25`).all(filingJobId) as Array<{result_json:string}>;
        const quote=rows.map(row=>JSON.parse(row.result_json)).find(result=>result?.kind==='quote' && result.quote?.id===q.id)?.quote as CheckoutQuote|undefined;
        if(!quote || quote.quoteDigest!==q.quoteDigest || quote.totalCents>0 && !/^[a-f0-9]{64}$/.test(quote.paymentMethodFingerprint || ''))throw new Error('The selected payment account requires a fresh checkout check.');
        return {version:1,filingJobId,bundleId:q.bundleId,accountEmail:account.username.trim().toLowerCase(),accountIdentity:account.identity,
            executionKey:bundleExecutionKey(account.username,q.bundleId),quoteId:q.id,quoteDigest:q.quoteDigest,packageDigest:q.packageDigest,
            totalCents:q.totalCents,currency:'USD',paymentMethodFingerprint:quote.paymentMethodFingerprint,expiresAt:q.expiresAt};
    }
    state(filingJobId:string,account:CheckoutAccount,now=Date.now()) {
        const job=this.job(filingJobId);let intent:SubmissionIntent|null=null,issue:string|null=null,ready=false;
        try {
            if(job?.externalBundleId){const row=this.db.prepare('SELECT id FROM mifile_submission_intents WHERE execution_key=?')
                .get(bundleExecutionKey(account.username,job.externalBundleId)) as {id:string}|undefined;if(row)intent=this.get(row.id);}
            const current=this.snapshot(filingJobId,account,now);
            ready=!intent || ['rehearsed','blocked'].includes(intent.status) && intent.attempts===0;
            if(intent && digest(current)!==digest(intent.snapshot))issue='The recorded rehearsal no longer matches the current checkout. Rehearse again.';
        }catch(error){issue=(error as Error).message;}
        return {id:intent?.id || null,status:intent?.status || null,attempts:intent?.attempts || 0,
            updatedAt:intent?.updatedAt || null,issue,canRehearse:ready,executionEnabled:this.enabled(),
            paymentAuthorized:intent?.status==='authorized' && this.enabled(),courtSubmissionAuthorized:intent?.status==='authorized' && this.enabled()};
    }
    rehearse(filingJobId:string,input:{quoteId:string;quoteDigest:string;totalCents:number;noPaymentAcknowledged:boolean},account:CheckoutAccount,actor:string,now=Date.now()):SubmissionIntent {
        return this.transaction(()=>{
            const snapshot=this.snapshot(filingJobId,account,now);
            if(input.noPaymentAcknowledged!==true || snapshot.quoteId!==input.quoteId || snapshot.quoteDigest!==input.quoteDigest || snapshot.totalCents!==input.totalCents)throw new Error('Confirm this exact package and amount for a no-payment rehearsal.');
            const row=this.db.prepare('SELECT id FROM mifile_submission_intents WHERE execution_key=?').get(snapshot.executionKey) as {id:string}|undefined;
            const prior=row?this.get(row.id):null;
            if(prior && (!['rehearsed','blocked'].includes(prior.status) || prior.attempts!==0))throw new Error('This bundle has an execution hold. Reconcile MiFILE; do not retry payment.');
            if(prior?.status==='rehearsed' && digest(prior.snapshot)===digest(snapshot))return prior;
            const id=prior?.id || randomUUID(),stamp=new Date(now).toISOString();
            this.db.prepare(`INSERT INTO mifile_submission_intents
                (id,execution_key,filing_job_id,status,snapshot_json,snapshot_digest,created_at,updated_at,actor)
                VALUES(?,?,?,'rehearsed',?,?,?,?,?) ON CONFLICT(execution_key) DO UPDATE SET
                filing_job_id=excluded.filing_job_id,status='rehearsed',snapshot_json=excluded.snapshot_json,
                snapshot_digest=excluded.snapshot_digest,updated_at=excluded.updated_at,actor=excluded.actor,error_message=NULL`)
                .run(id,snapshot.executionKey,filingJobId,JSON.stringify(snapshot),digest(snapshot),stamp,stamp,actor);
            this.audit(id,'submission_rehearsed',{filingJobId,totalCents:snapshot.totalCents,quoteId:snapshot.quoteId,paymentAuthorized:false,courtSubmissionAuthorized:false});
            return this.get(id)!;
        });
    }
    authorize(id:string,input:{quoteId:string;quoteDigest:string;totalCents:number;paymentAndSubmissionApproved:boolean},account:CheckoutAccount,now=Date.now()):void {
        if(!this.enabled())throw new Error('Live payment and court submission are disabled. Rehearsal does not authorize either action.');
        this.transaction(()=>{
            const intent=this.get(id);if(!intent || intent.status!=='rehearsed' || intent.attempts!==0 || input.paymentAndSubmissionApproved!==true)throw new Error('A new explicit payment and submission approval is required.');
            const current=this.snapshot(intent.snapshot.filingJobId,account,now);
            if(digest(current)!==digest(intent.snapshot) || input.quoteId!==current.quoteId || input.quoteDigest!==current.quoteDigest || input.totalCents!==current.totalCents)throw new Error('The package, account or exact amount changed.');
            this.db.prepare("UPDATE mifile_submission_intents SET status='authorized',updated_at=? WHERE id=?").run(new Date(now).toISOString(),id);
        });
    }
    begin(id:string,account:CheckoutAccount,now=Date.now()):SubmissionSnapshot {
        if(!this.enabled())throw new Error('Live payment and court submission are disabled.');
        return this.transaction(()=>{
            if(this.db.prepare("SELECT 1 FROM filing_jobs WHERE status='running'").get() ||
                this.db.prepare("SELECT 1 FROM mifile_checkout_inspections WHERE status='running'").get() ||
                this.db.prepare("SELECT 1 FROM mifile_submission_intents WHERE status IN ('checking','committing')").get()) {
                throw new Error('Wait for the active MiFILE operation to finish.');
            }
            const intent=this.get(id);if(!intent || intent.status!=='authorized' || intent.attempts!==0 ||
                digest(this.snapshot(intent.snapshot.filingJobId,account,now))!==digest(intent.snapshot))throw new Error('Submission authorization is stale or already used.');
            this.db.prepare("UPDATE mifile_submission_intents SET status='checking',updated_at=? WHERE id=?").run(new Date(now).toISOString(),id);
            return intent.snapshot;
        });
    }
    commitStarted(id:string,account:CheckoutAccount,now=Date.now()):void {
        if(!this.enabled())throw new Error('Live payment and court submission are disabled.');
        this.transaction(()=>{
            const intent=this.get(id);if(!intent || intent.status!=='checking' || intent.attempts!==0 ||
                digest(this.snapshot(intent.snapshot.filingJobId,account,now))!==digest(intent.snapshot))throw new Error('The final submission check is stale.');
            this.db.prepare("UPDATE mifile_submission_intents SET status='committing',attempt_count=1,updated_at=? WHERE id=?")
                .run(new Date(now).toISOString(),id);
            this.audit(id,'submission_commit_started',{filingJobId:intent.snapshot.filingJobId,totalCents:intent.snapshot.totalCents});
        });
    }
    checkLive(id:string,account:CheckoutAccount,quote:CheckoutQuote,observations:MiFileReceiptObservation[],now=Date.now()):void {
        const intent=this.get(id),job=intent && this.job(intent.snapshot.filingJobId);
        if(!intent || intent.status!=='checking' || !job || !Array.isArray(observations) || !observations.length || observations.length>200) {
            throw new Error('The live checkout could not be verified. No payment attempted.');
        }
        const snapshot=intent.snapshot,issues=checkoutReviewIssues(quote,job,account,now);
        let valid=true;
        for(const observation of observations) {
            try {
                validateReceipt(observation,job,account);
                rememberBundleActivity(this.db,observation,job.id);
                const time=Date.parse(observation.observedAt);
                if(time>now+5000 || now-time>=60_000)valid=false;
            }catch {valid=false;}
        }
        if(issues.length || !valid || receiptSummary(observations).submissionObserved ||
            !observations.some(item=>item.kind==='bundle_status' && item.status==='Unsubmitted') ||
            account.identity!==snapshot.accountIdentity || account.username.trim().toLowerCase()!==snapshot.accountEmail ||
            quote.totalCents!==snapshot.totalCents || quote.packageDigest!==snapshot.packageDigest ||
            quote.paymentMethodFingerprint!==snapshot.paymentMethodFingerprint) {
            throw new Error('The live checkout no longer matches the authorized package. No payment attempted.');
        }
    }
    finish(id:string,account:CheckoutAccount,observations:MiFileReceiptObservation[]):void {
        const issue=this.transaction(()=>{
            const intent=this.get(id),job=intent && this.job(intent.snapshot.filingJobId);
            if(!intent || intent.status!=='committing' || !job || account.identity!==intent.snapshot.accountIdentity ||
                account.username.trim().toLowerCase()!==intent.snapshot.accountEmail)throw new Error('Submission result requires reconciliation.');
            const valid:MiFileReceiptObservation[]=[];let malformed=false;
            for(const receipt of (Array.isArray(observations)?observations:[]).slice(0,200)) {
                try {
                    validateReceipt(receipt,job,account);
                    rememberBundleActivity(this.db,receipt,job.id);valid.push(receipt);
                    if(Date.parse(receipt.observedAt)<Date.parse(intent.updatedAt)-5000 || Date.parse(receipt.observedAt)>Date.now()+5000)malformed=true;
                }catch {malformed=true;}
            }
            if(!Array.isArray(observations) || observations.length>200)malformed=true;
            const paid=valid.some(receipt=>receipt.kind==='payment' && receipt.status==='Paid' && receipt.totalCents===intent.snapshot.totalCents);
            const submitted=valid.some(receipt=>receipt.kind==='bundle_status' && ['Submitted','In Progress','Accepted','Filed'].includes(receipt.status));
            const issue=malformed || !submitted || intent.snapshot.totalCents>0 && !paid ||
                valid.some(receipt=>['Payment Rejected','Rejected','Refunded'].includes(receipt.status) ||
                    receipt.kind==='payment' && receipt.totalCents!==intent.snapshot.totalCents)
                ? 'Exact payment and submission receipts are not both verified. Do not retry.' : null;
            this.db.prepare('UPDATE mifile_submission_intents SET status=?,updated_at=?,result_json=?,error_message=? WHERE id=?')
                .run(issue?'reconciliation_required':'submitted',new Date().toISOString(),JSON.stringify(valid),issue,id);
            this.audit(id,issue?'submission_reconciliation_required':'submission_result_verified',
                {filingJobId:job.id,verifiedReceiptCount:valid.length,totalCents:intent.snapshot.totalCents});
            return issue;
        });
        if(issue)throw new Error(issue);
    }
    failed(id:string,error:string):void {
        const intent=this.get(id);if(!intent || !['checking','committing'].includes(intent.status))return;
        this.db.prepare('UPDATE mifile_submission_intents SET status=?,error_message=?,updated_at=? WHERE id=?')
            .run(intent.status==='committing'?'reconciliation_required':'blocked',error.slice(0,1200),new Date().toISOString(),id);
    }
    recover():number {return Number(this.db.prepare(`UPDATE mifile_submission_intents SET status='reconciliation_required',
        error_message='The process stopped during submission. Check MiFILE before any further action.',updated_at=?
        WHERE status IN ('checking','committing')`).run(new Date().toISOString()).changes);}
}

export interface SubmissionTransport {
    inspect(snapshot:SubmissionSnapshot):Promise<{quote:CheckoutQuote;observations:MiFileReceiptObservation[];account:CheckoutAccount}>;
    submitOnce():Promise<void>;
    receipts():Promise<MiFileReceiptObservation[]>;
    close():Promise<void>;
}
/** The durable committing checkpoint is written before the one irreversible transport call. */
export async function executeSubmission(store:SubmissionStore,id:string,account:CheckoutAccount,transport:SubmissionTransport):Promise<void> {
    let began=false;
    try {
        const snapshot=store.begin(id,account);began=true;
        const current=await transport.inspect(snapshot);
        store.checkLive(id,current.account,current.quote,current.observations);
        store.commitStarted(id,account);
        await transport.submitOnce();
        store.finish(id,account,await transport.receipts());
    }catch(error){if(began)store.failed(id,(error as Error).message);throw error;}
    finally{await transport.close();}
}
