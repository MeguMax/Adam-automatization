import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {courtKey} from './formLibraryTypes';
import {getWorkflowDatabase} from './database';
import {getMiFileCredentials,initializeMiFileAccountEncryption,miFileCredentialIdentity} from './mifileAccountSettings';
import {getMiFileRuntimeConfig} from './mifileRuntimeConfig';

export interface PaymentAuditTarget {caseNumber:string;courtName:string}
export interface PaymentAuditRange {from:string;through:string}
const text=(value:unknown,max=200):value is string=>typeof value==='string' && value.length>0 && value.length<=max && !/[\u0000-\u001f]/.test(value);

export function validatePaymentAudit(targets:unknown,range:PaymentAuditRange,now=Date.now()):asserts targets is PaymentAuditTarget[] {
    if(!Array.isArray(targets) || targets.length<1 || targets.length>10 || targets.some(target=>!target ||
        !text(target.caseNumber,60) || !/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+){1,5}$/.test(target.caseNumber) || !text(target.courtName)) ||
        new Set(targets.map(target=>JSON.stringify([target.caseNumber.toUpperCase(),courtKey(target.courtName)]))).size!==targets.length) {
        throw new Error('Provide one to ten unique exact case numbers and court names.');
    }
    for(const value of [range.from,range.through])if(!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value)throw new Error('Use valid ISO dates.');
    const start=Date.parse(range.from),end=Date.parse(range.through);
    if(end<start || end-start>59*86_400_000 || end>now+86_400_000)throw new Error('The read-only audit is limited to sixty calendar days.');
}

function amountCents(value:unknown):number|null {
    if(typeof value!=='number' && typeof value!=='string')return null;
    const match=/^(-?)(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value));if(!match)return null;
    const cents=(Number(match[2])*100+Number((match[3] || '').padEnd(2,'0')))*(match[1]?-1:1);
    return Number.isSafeInteger(cents)?cents:null;
}

export function summarizePaymentLedger(value:unknown,targets:PaymentAuditTarget[],range:PaymentAuditRange,now=Date.now()) {
    validatePaymentAudit(targets,range,now);
    if(!Array.isArray(value) || value.length>10_000)throw new Error('Unrecognized or oversized MiFILE payment ledger.');
    const start=Date.parse(range.from),end=Date.parse(range.through)+86_400_000;
    const cases=targets.map(target=>{
        const matches=value.filter(row=>row && typeof row==='object' && typeof row.CaseNumber==='string' &&
            row.CaseNumber.trim().toUpperCase()===target.caseNumber.toUpperCase());
        let unverified=0;
        const records:Array<{referenceFingerprint:string;authorizedAt:string;authorizationCents:number;documentType:string}>=[];
        const seen=new Set<string>();
        for(const row of matches) {
            if(!text(row.CourtName) || courtKey(row.CourtName)!==courtKey(target.courtName))continue;
            const cents=amountCents(row.AuthorizationAmount),time=typeof row.AuthorizationDateTime==='string'?Date.parse(row.AuthorizationDateTime):NaN;
            if(cents===null || !Number.isFinite(time) || time<start || time>=end || !text(row.TransactionId) ||
                !text(row.DocumentType) || row.PaymentId!=null && !text(row.PaymentId)) {unverified++;continue;}
            const referenceFingerprint=createHash('sha256').update(JSON.stringify([row.TransactionId,row.PaymentId || null])).digest('hex');
            const record={referenceFingerprint,authorizedAt:new Date(time).toISOString(),authorizationCents:cents,documentType:row.DocumentType};
            const identity=JSON.stringify(record);if(seen.has(identity))continue;seen.add(identity);records.push(record);
        }
        return {...target,evidence:unverified?'review_required':records.length?'authorization_records_found':'no_matching_records',
            records,unverifiedRecords:unverified,
            alternateCourtNames:[...new Set(matches.map(row=>row.CourtName).filter(name=>text(name) && courtKey(name)!==courtKey(target.courtName)))].slice(0,10),
            unpaidConfirmed:false,settlementVerified:false,retryAuthorized:false};
    });
    return {checkedAt:new Date(now).toISOString(),range,readOnly:true,accountRole:'primary',cases,
        notice:'Authorization records are not settlement receipts. No matching records does not prove a case is unpaid. No payment or filing is authorized.'};
}

export async function auditMiFilePayments(targets:PaymentAuditTarget[],range:PaymentAuditRange,
    progress:(stage:'login'|'reading_payment_ledger'|'complete')=>void=()=>{}) {
    validatePaymentAudit(targets,range);
    const credentials=getMiFileCredentials(),runtime=getMiFileRuntimeConfig(),identity=miFileCredentialIdentity(credentials);
    if(!runtime.ready || credentials.accountEnvironment!=='production' || !credentials.productionConfirmed) {
        throw new Error('Verify and activate the primary MiFILE account before the read-only payment audit.');
    }
    const {MiFileFilingRunner}=await import('./mifileFilingRunner');
    const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    try {
        const page=await browser.newPage(),runner=new MiFileFilingRunner(()=>{});
        page.setDefaultTimeout(45_000);page.setDefaultNavigationTimeout(60_000);
        progress('login');await runner.login(page,credentials);await runner.verifyAccount(page,credentials.username);
        // This is the exact GET used by MiFILE's Payment Transactions view, not a payment endpoint.
        const url=new URL('https://mifile.courts.michigan.gov/api/payment/transactionsView');
        url.searchParams.set('fromDate',new Date(range.from).toISOString());
        url.searchParams.set('toDate',new Date(Date.parse(range.through)+86_400_000-1).toISOString());
        progress('reading_payment_ledger');
        const response=await page.request.get(url.href,{maxRedirects:0,timeout:45_000});
        if(!response.ok() || !response.headers()['content-type']?.includes('application/json') ||
            Number(response.headers()['content-length'] || 0)>5*1024*1024)throw new Error('The primary-account payment ledger could not be read.');
        const body=await response.body();if(body.length>5*1024*1024)throw new Error('The payment ledger exceeds the bounded audit size.');
        const result=summarizePaymentLedger(JSON.parse(body.toString('utf8')),targets,range);
        await runner.verifyAccount(page,credentials.username);
        if(miFileCredentialIdentity(getMiFileCredentials())!==identity)throw new Error('The primary account changed during the audit.');
        progress('complete');return {...result,accountEmail:credentials.username.trim().toLowerCase()};
    }finally{await browser.close();}
}

if(require.main===module) {
    require('dotenv').config({quiet:true});
    (async()=>{
        const {values}=parseArgs({options:{targets:{type:'string'},from:{type:'string'},through:{type:'string'}}});
        const targets=JSON.parse(values.targets || 'null'),range={from:values.from || '',through:values.through || ''};
        validatePaymentAudit(targets,range);
        const db=getWorkflowDatabase();
        try {
            initializeMiFileAccountEncryption(db);
            console.log(JSON.stringify(await auditMiFilePayments(targets,range,stage=>console.error('Read-only payment audit: '+stage)),null,2));
        }finally{db.close();}
    })().catch(()=>{console.error('Read-only MiFILE payment audit failed. No payment or court submission was attempted; credentials and raw ledger were not exported.');process.exitCode=1;});
}
