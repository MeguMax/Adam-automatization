import type { Page } from 'playwright';
import { digest, type CheckoutQuote, type CheckoutPaymentMethod } from './mifileCheckout';

function safePaymentLabel(text: string, fingerprint: string): string {
    const kind = /\b(?:visa|master\s*card|amex|american express|discover|credit|debit|card)\b/i.test(text)
        ? 'Card' : /\b(?:bank|checking|savings|ach)\b/i.test(text) ? 'Bank account' : 'Payment account';
    const lastFour = text.match(/(?:ending(?:\s+in)?|last\s*(?:four|4)|[*x\u2022]{2,})[\s:.-]*(\d{4})(?!\d)/i)?.[1];
    return lastFour ? `${kind} ending ${lastFour}` : `${kind} ${fingerprint.slice(0, 8)}`;
}

async function paymentOptions(page: Page) {
    const dialog = page.getByRole('dialog').filter({has:page.getByRole('heading', {name:'Checkout', exact:true})}).last();
    const group = dialog.getByRole('group', {name:'Available Payment Accounts', exact:true});
    // MiFILE can render the card table as a sibling of the fieldset containing its legend and Add button.
    const tables=dialog.getByRole('table').filter({has:page.getByRole('columnheader',{name:'Card Nickname',exact:true})})
        .filter({visible:true});
    if(await tables.count()>1)throw new Error('MiFILE shows ambiguous payment account tables. Check checkout manually.');
    const hasTable=await tables.count()===1;
    if(hasTable && JSON.stringify((await tables.getByRole('columnheader').allTextContents()).map(text=>text.trim().replace(/\s+/g,' ')))!==
        JSON.stringify(['Select','Type','Card Nickname','Number','Expiration Date'])) {
        throw new Error('MiFILE payment table has an unfamiliar layout. Check checkout manually.');
    }
    const scope=hasTable?group.or(tables):group;
    const controls = await scope.locator('input[type="radio"], select').evaluateAll(elements => elements.flatMap(element => {
        if (element instanceof HTMLSelectElement) {
            if (element.disabled || !element.getClientRects().length) return [];
            return Array.from(element.options).filter(option => !option.disabled).map(option => ({
                kind:'select', token:option.value, selected:option.selected, text:option.label,
            }));
        }
        const radio = element as HTMLInputElement;
        if (radio.disabled) return [];
        if (!radio.getClientRects().length && !Array.from(radio.labels || []).some(label => label.getClientRects().length)) return [];
        const rowText=Array.from(radio.closest('tr')?.querySelectorAll('th,td') || [])
            .map(cell=>(cell as HTMLElement).innerText.trim()).join(' ');
        const text = [radio.getAttribute('aria-label'),Array.from(radio.labels || []).map(label => label.innerText).join(' '),
            radio.closest('label')?.textContent,rowText,radio.closest('td, li')?.textContent]
            .find(text=>text?.trim()) || '';
        return [{kind:'radio', token:radio.value, selected:radio.checked, text}];
    }));
    // Only observed opaque MiFILE account IDs are accepted; labels and card data never become IDs.
    const usable = controls.filter(control => /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(control.token));
    if (controls.some(control => control.selected && control.token && !usable.includes(control))) {
        throw new Error('MiFILE selected an unrecognized payment account. Check checkout manually.');
    }
    const fingerprints = usable.map(control => digest(control.token));
    if (usable.length > 20 || new Set(fingerprints).size !== fingerprints.length) {
        throw new Error('MiFILE shows ambiguous payment account controls. No account was selected.');
    }
    return {dialog, group, scope, controls, usable, methods:usable.map(control => {
        const fingerprint = digest(control.token);
        return {fingerprint, label:safePaymentLabel(control.text, fingerprint)};
    })};
}

export async function readPaymentMethods(page: Page): Promise<{
    state: CheckoutQuote['paymentMethodState']; fingerprint: string | null;
    available: CheckoutPaymentMethod[];
}> {
    const snapshot = await paymentOptions(page);
    const selected = snapshot.usable.filter(control => control.selected);
    if (selected.length > 1) throw new Error('MiFILE shows more than one selected payment account. Check checkout manually.');
    const emptyAccountPanel = !snapshot.controls.length &&
        (await snapshot.group.innerText()).replace(/\s+/g,' ').trim() === 'Available Payment Accounts Add Payment Account';
    const missing = (await snapshot.dialog.innerText()).includes('No payment methods exist for your account');
    if (missing && snapshot.usable.length) throw new Error('MiFILE payment account information is inconsistent. Refresh checkout.');
    if (!missing && !emptyAccountPanel && !snapshot.usable.length) {
        throw new Error('MiFILE payment accounts are not readable yet. Check checkout again or inspect the payment account in MiFILE. No payment was attempted.');
    }
    return {state:missing ? 'missing' : emptyAccountPanel ? 'unverified' : selected.length === 1 ? 'selected' : 'not_selected',
        fingerprint:selected.length === 1 ? digest(selected[0].token) : null, available:snapshot.methods};
}

export async function selectPaymentMethodForQuote(page: Page, fingerprint: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid payment account selection.');
    const snapshot = await paymentOptions(page);
    const matches = snapshot.usable.filter(control => digest(control.token) === fingerprint);
    if (matches.length !== 1) throw new Error('The chosen payment account is no longer available. Clear the choice and check checkout again.');
    const target = matches[0];
    try {
    if (target.kind === 'radio') {
        const radio = snapshot.scope.locator('input[type="radio"][value="' + target.token + '"]');
        if (await radio.isVisible()) await radio.check();
        else {
            const id = await radio.getAttribute('id');
            const label = id && /^[\w:-]{1,160}$/.test(id)
                ? snapshot.scope.locator('label[for="' + id + '"]')
                : snapshot.scope.locator('label').filter({has:radio});
            if (await label.count() !== 1 || !await label.isVisible()) throw new Error('The chosen payment account has no visible selection control.');
            await label.click();
        }
    } else {
        const select = snapshot.scope.locator('select').filter({has:page.locator('option[value="' + target.token + '"]')});
        if (await select.count() !== 1) throw new Error('MiFILE shows an ambiguous payment selector.');
        await select.selectOption(target.token);
    }
    const after = await readPaymentMethods(page);
    if (after.state !== 'selected' || after.fingerprint !== fingerprint) {
        throw new Error('MiFILE did not retain the chosen payment account. No payment was attempted.');
    }
    } catch {
        // Playwright errors can include the raw value in their selector. Keep it out of stored logs.
        throw new Error('MiFILE could not verify the chosen payment account. Clear the choice and check checkout again. No payment was attempted.');
    }
}
