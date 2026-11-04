import type {Page} from 'playwright';

export interface CheckoutSubmitControl {ready:boolean;issue:string|null;label:'Submit';contract:'mifile-checkout-v1'}

/** Inspect only: never accept terms, add cards, or click a financial control. */
export async function inspectCheckoutSubmitControl(page:Page):Promise<CheckoutSubmitControl> {
    const result={label:'Submit' as const,contract:'mifile-checkout-v1' as const};
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
