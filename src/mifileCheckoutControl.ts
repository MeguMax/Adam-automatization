import type {Page} from 'playwright';
import {readCheckoutTerms} from './mifileCheckoutTerms';

export interface CheckoutSubmitControl {
    ready:boolean;issue:string|null;label:'Submit';contract:'mifile-checkout-v2';
    termsState:'accepted'|'required'|'unverified'|'not_required';checkedAt:string;
}

export function validCheckoutSubmitControl(value:unknown,totalCents:number,quotedAt:string,now=Date.now()):value is CheckoutSubmitControl {
    const control=value as CheckoutSubmitControl|null;
    if(!control || control.contract!=='mifile-checkout-v2' || control.label!=='Submit' || typeof control.ready!=='boolean' ||
        !['accepted','required','unverified','not_required'].includes(control.termsState) ||
        typeof control.checkedAt!=='string' || control.issue!==null && (typeof control.issue!=='string' || !control.issue || control.issue.length>500) ||
        control.ready && (control.issue!==null || control.termsState!==(totalCents===0?'not_required':'accepted')) ||
        !control.ready && !control.issue || totalCents>0 && control.termsState==='not_required')return false;
    const checked=Date.parse(control.checkedAt),quoted=Date.parse(quotedAt);
    return Number.isFinite(checked) && Number.isFinite(quoted) && checked>=quoted-5000 && checked<=quoted+60_000 &&
        checked<=now+5000 && now-checked<15*60_000;
}

/** Inspect only: never accept terms, add cards, or click a financial control. */
export async function inspectCheckoutSubmitControl(page:Page,totalCents:number):Promise<CheckoutSubmitControl> {
    if(!Number.isSafeInteger(totalCents) || totalCents<0)throw new Error('Checkout requires its exact verified amount.');
    const termsState=totalCents===0?'not_required' as const:await readCheckoutTerms(page);
    const result={label:'Submit' as const,contract:'mifile-checkout-v2' as const,termsState,checkedAt:new Date().toISOString()};
    const dialog=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Checkout',exact:true})}).last();
    if(!await dialog.isVisible())return {...result,ready:false,issue:'The Checkout dialog is not visible.'};
    const submit=dialog.getByRole('button',{name:'Submit',exact:true}).filter({visible:true});
    if(await submit.count()!==1 || !await submit.isVisible() || !await submit.isEnabled()) {
        return {...result,ready:false,issue:'MiFILE does not expose one enabled Submit control.'};
    }
    const controls=await dialog.locator('input,select,textarea,button,[role="button"],[role="checkbox"],[role="switch"]')
        .evaluateAll(elements=>elements.filter(element=>element.getClientRects().length>0).map(element=>({
            tag:element.tagName.toLowerCase(),type:(element as HTMLInputElement).type || '',
            role:element.getAttribute('role'),label:element.getAttribute('aria-label') ||
                (element.tagName==='INPUT' && ['button','submit'].includes((element as HTMLInputElement).type)
                    ? (element as HTMLInputElement).value : (element as HTMLElement).innerText.trim()),
            checked:(element as HTMLInputElement).checked,ariaChecked:element.getAttribute('aria-checked'),
        })));
    if(controls.some(control=>(control.type==='checkbox' || ['checkbox','switch'].includes(control.role || '')) &&
        !control.checked && control.ariaChecked!=='true')) {
        return {...result,ready:false,issue:'An unchecked checkout acknowledgment needs human review.'};
    }
    if(controls.some(control=>(control.tag==='button' || control.role==='button' || control.tag==='input' && ['button','submit'].includes(control.type)) &&
        !['Submit','Cancel','Add Payment Account','Request Fee Waiver','Edit Fee Waiver','Close','\u00d7'].includes(control.label)) ||
        controls.some(control=>control.tag==='textarea' || control.tag==='input' && !['radio','checkbox','hidden','button','submit'].includes(control.type))) {
        return {...result,ready:false,issue:'Checkout has unfamiliar controls. Review MiFILE before submission.'};
    }
    if(termsState==='required')return {...result,ready:false,
        issue:'The MiFILE account has not accepted its checkout terms. The account owner must review them in MiFILE; this app does not accept terms or attempt payment.'};
    if(termsState==='unverified')return {...result,ready:false,
        issue:'MiFILE checkout terms could not be verified. Refresh checkout or ask the account owner to review MiFILE before payment.'};
    return {...result,ready:true,issue:null};
}

export async function waitForCheckoutSubmissionResult(page:Page,timeoutMs=60_000):Promise<void> {
    const checkout=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Checkout',exact:true})}).last();
    // Navigating to History while the submission request is still pending can abort it.
    await checkout.waitFor({state:'hidden',timeout:timeoutMs});
    await page.getByRole('status',{name:'Please wait while information is being processed.',exact:true})
        .waitFor({state:'hidden',timeout:timeoutMs});
    if(await page.getByRole('dialog').filter({visible:true}).count()) {
        throw new Error('MiFILE opened another confirmation after Submit. Check the existing bundle; do not repeat payment.');
    }
}
