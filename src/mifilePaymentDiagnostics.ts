import type {Page} from 'playwright';
import {paymentEvidenceStatus} from './mifilePaymentEvidence';

export async function readPaymentDiagnostics(page:Page) {
    const dialog=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Checkout',exact:true})}).last();
    const dom=await dialog.evaluate(root=>{
        const visible=(element:Element)=>element.getClientRects().length>0 && getComputedStyle(element).visibility!=='hidden';
        const shape=(value:string)=>!value?'empty':/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)?'uuid':/^\d+$/.test(value)?'integer':'other';
        const model=(element:Element,name:string)=>{
            const value=element.getAttribute(name) || element.getAttribute('data-'+name) || '';
            return /^[A-Za-z_$][\w.$\[\]]{0,100}$/.test(value) && !/^[a-f0-9]{16,}$/i.test(value)?value:null;
        };
        const headingNames=new Set(['Select','Type','Card Nickname','Number','Expiration Date','Fee Type','Amount',
            'Default','Payment Method','Actions','Nickname','Expiration','Account Name','Card Number']);
        const group=[...root.querySelectorAll('fieldset,[role="group"]')].find(element=>
            element.getAttribute('aria-label')==='Available Payment Accounts' ||
            (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent?.trim() || '').join(' ')==='Available Payment Accounts' ||
            element.querySelector('legend')?.textContent?.trim()==='Available Payment Accounts');
        return {version:1 as const,groupPresent:Boolean(group),
            tables:[...root.querySelectorAll('table')].slice(0,10).map(table=>({visible:visible(table),
                headings:[...table.querySelectorAll('th')].slice(0,12).map(cell=>{
                    const text=cell.textContent?.trim().replace(/\s+/g,' ') || '';
                    return headingNames.has(text)?text:'unrecognized';
                }),rows:table.querySelectorAll('tbody tr').length,
                radios:table.querySelectorAll('input[type="radio"]').length,
                checkboxes:table.querySelectorAll('input[type="checkbox"]').length})),
            controls:[...root.querySelectorAll('input,select,[role="radio"],[role="checkbox"],tr[ng-click]')].slice(0,60).map(element=>({
                tag:element.tagName.toLowerCase(),type:element instanceof HTMLInputElement?element.type:null,
                role:['radio','checkbox','option','combobox'].includes(element.getAttribute('role') || '')?element.getAttribute('role'):null,
                visible:visible(element),disabled:element.matches(':disabled'),
                checked:element instanceof HTMLInputElement?element.checked:element.getAttribute('aria-checked')==='true',
                inPaymentGroup:Boolean(group?.contains(element)),
                valueShape:element instanceof HTMLInputElement || element instanceof HTMLSelectElement?shape(element.value):null,
                model:model(element,'ng-model'),valueBinding:model(element,'ng-value'),
                clickHandler:(element.getAttribute('ng-click') || '').match(/^\s*([A-Za-z_$][\w.$]*)\s*\(/)?.[1] || null,
            })),
            missingMessageVisible:(root as HTMLElement).innerText.includes('No payment methods exist for your account'),
        };
    });
    return {...dom,accountResponse:paymentEvidenceStatus(page)};
}

export type PaymentDiagnostics=Awaited<ReturnType<typeof readPaymentDiagnostics>>;
