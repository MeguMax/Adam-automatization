import type {Page,Response} from 'playwright';
import {miFileBundleId} from './mifilePreparationEvidence';

const opaqueId=/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
export interface ObservedPaymentAccount {
    id:string;label:string;defaultAccount:boolean;publicLabel:string;
}
interface Evidence {bundleId:string;checkedAt:number;accounts:ObservedPaymentAccount[]|null;failed:boolean;responseStatus:number|null;recordCount:number|null}
const evidence=new WeakMap<Page,Evidence>();

export function parseObservedPaymentAccounts(value:unknown):ObservedPaymentAccount[] {
    if(!Array.isArray(value) || value.length>20)throw new Error('Unrecognized MiFILE payment account response.');
    const accounts=value.map(item=>{
        if(!item || typeof item!=='object' || typeof item.id!=='string' || !opaqueId.test(item.id) ||
            typeof item.defaultAccount!=='boolean')throw new Error('Unrecognized MiFILE payment account identity.');
        const field=(name:string)=>{
            const text=item[name];
            if(text==null)return '';
            if(typeof text!=='string' || text.length>200 || /[\u0000-\u001f]/.test(text))throw new Error('Unrecognized payment account label.');
            return text;
        };
        const name=field('nickName') || field('cardHolderName'),type=field('accountType'),number=field('maskedAccountNumber'),expiry=field('expirationDate');
        // Only a masked card suffix may be used to associate the API record with its visible radio.
        if(!name || !type || !/^(?:[*xX\u2022 -]*\d{4})$/.test(number) || !expiry)throw new Error('Payment account metadata is incomplete or unmasked.');
        const kind=/^(?:visa|mc|mastercard|amex|discover)$/i.test(type)?'Card':
            /^(?:bank|checking|savings|ach)$/i.test(type)?'Bank account':'Payment account';
        return {id:item.id.toLowerCase(),defaultAccount:item.defaultAccount,publicLabel:`${kind} ending ${number.slice(-4)}`,
            label:`Select payment account ${name}, ${type}, ending in ${number}, expires ${expiry}${item.defaultAccount?', Default account':''}`};
    });
    if(new Set(accounts.map(account=>account.id)).size!==accounts.length ||
        new Set(accounts.map(account=>account.label.replace(/\s+/g,' ').trim())).size!==accounts.length) {
        throw new Error('MiFILE payment account identities are ambiguous.');
    }
    return accounts;
}

/** Observe the GET already made by checkout. Never call payment mutation endpoints. */
export function observePaymentAccounts(page:Page,bundleId:string):()=>void {
    if(miFileBundleId(page.url())!==bundleId)throw new Error('Payment evidence requires the verified bundle page.');
    const current:Evidence={bundleId,checkedAt:0,accounts:null,failed:false,responseStatus:null,recordCount:null};evidence.set(page,current);
    let responses=0;
    const listener=async(response:Response)=>{
        const url=new URL(response.url());
        if(url.origin!=='https://mifile.courts.michigan.gov' || url.pathname!=='/api/payment/getcourt' ||
            response.request().method()!=='GET')return;
        try {
            current.responseStatus=response.status();
            if(++responses!==1 || miFileBundleId(page.url())!==bundleId ||
                !opaqueId.test(url.searchParams.get('courtId') || '') || !response.ok() ||
                !response.headers()['content-type']?.includes('application/json') ||
                Number(response.headers()['content-length'] || 0)>256*1024)throw new Error('Payment account observation changed.');
            const body=await response.body();if(body.length>256*1024)throw new Error('Oversized account response.');
            const data=JSON.parse(body.toString('utf8'));current.recordCount=Array.isArray(data)?data.length:null;
            const accounts=parseObservedPaymentAccounts(data);
            if(evidence.get(page)!==current || current.failed || miFileBundleId(page.url())!==bundleId)return;
            current.accounts=accounts;current.checkedAt=Date.now();
        }catch {current.failed=true;current.accounts=null;}
    };
    page.on('response',listener);
    return ()=>{page.off('response',listener);if(evidence.get(page)===current)evidence.delete(page);};
}

export function observedPaymentAccounts(page:Page):ObservedPaymentAccount[]|null {
    const current=evidence.get(page);
    return current && !current.failed && current.accounts && miFileBundleId(page.url())===current.bundleId &&
        Date.now()-current.checkedAt<120_000?current.accounts:null;
}

export function paymentEvidenceStatus(page:Page) {
    const current=evidence.get(page);
    return {state:!current?'not_observed':current.failed?'failed':observedPaymentAccounts(page)?'verified':'waiting',
        responseStatus:current?.responseStatus ?? null,recordCount:current?.recordCount ?? null};
}
