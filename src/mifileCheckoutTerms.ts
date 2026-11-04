import type {Page,Response} from 'playwright';
import {miFileBundleId} from './mifilePreparationEvidence';

export type CheckoutTermsState='accepted'|'required'|'unverified';
interface TermsEvidence {bundleId:string;state:CheckoutTermsState;observedAt:number;responses:number;failed:boolean}
const evidence=new WeakMap<Page,TermsEvidence>();

export function parseCheckoutTermsAcceptance(value:unknown):boolean {
    if(typeof value==='boolean')return value;
    if(value===null || value==='')return false;
    if(typeof value==='string' && /^(?:true|false)$/i.test(value))return value.toLowerCase()==='true';
    throw new Error('MiFILE checkout terms could not be verified.');
}

/** Observe checkout's existing property read. Never accept or save terms for the user. */
export function observeCheckoutTerms(page:Page,bundleId:string):()=>void {
    if(miFileBundleId(page.url())!==bundleId)throw new Error('Checkout terms require the verified bundle page.');
    const current:TermsEvidence={bundleId,state:'unverified',observedAt:0,responses:0,failed:false};
    evidence.set(page,current);
    const listener=async(response:Response)=>{
        const url=new URL(response.url());
        if(url.origin!=='https://mifile.courts.michigan.gov' || url.pathname!=='/User/GetUserPropertyForCurrentUser' ||
            response.request().method()!=='GET' || url.searchParams.get('propertyName')!=='CheckoutTCAccepted')return;
        try {
            const type=response.headers()['content-type']?.split(';')[0].trim().toLowerCase();
            if(++current.responses!==1 || miFileBundleId(page.url())!==bundleId || !response.ok() ||
                url.searchParams.getAll('propertyName').length!==1 ||
                !['application/json','text/plain'].includes(type || '') ||
                Number(response.headers()['content-length'] || 0)>1024)throw new Error('Unrecognized terms response.');
            const body=await response.body();if(body.length>1024)throw new Error('Oversized terms response.');
            const raw=body.toString('utf8');
            const accepted=parseCheckoutTermsAcceptance(type==='application/json'?JSON.parse(raw):raw);
            if(evidence.get(page)!==current || current.failed || miFileBundleId(page.url())!==bundleId)return;
            current.state=accepted?'accepted':'required';current.observedAt=Date.now();
        }catch {current.failed=true;current.state='unverified';}
    };
    page.on('response',listener);
    return ()=>{page.off('response',listener);if(evidence.get(page)===current)evidence.delete(page);};
}

export async function readCheckoutTerms(page:Page):Promise<CheckoutTermsState> {
    const deadline=Date.now()+5000;
    do {
        const current=evidence.get(page);
        if(!current || current.failed || miFileBundleId(page.url())!==current.bundleId)return 'unverified';
        if(current.observedAt)return Date.now()-current.observedAt<120_000?current.state:'unverified';
        await page.waitForTimeout(50);
    }while(Date.now()<deadline);
    return 'unverified';
}
