import { createHash } from 'node:crypto';
import { readFilingTextFields } from './pdfValidation';
import type { ComplaintExtractionData } from './complaintExtractor';

export interface SupportingCaseIdentity {
    version: 1;
    method: 'dc100a_pdf_fields';
    sourceHash: string;
    recipient: string;
    plaintiff: string;
    premises: string;
}

export async function readSupportingCaseIdentity(buffer: Buffer): Promise<SupportingCaseIdentity | null> {
    try {
        const fields = await readFilingTextFields(buffer);
        const read = (number: string) => {
            const values = fields.filter(field => new RegExp(`(?:^|_)dc100a_${number}$`, 'i').test(field.name)).map(field => field.value.trim());
            return values.length && new Set(values).size === 1 && values[0].length <= 1500 ? values[0] : '';
        };
        const recipient = read('01'), plaintiff = read('02'), premises = read('04');
        if (!recipient || !plaintiff || !premises) return null;
        return { version: 1, method: 'dc100a_pdf_fields', sourceHash: createHash('sha256').update(buffer).digest('hex'), recipient, plaintiff, premises };
    } catch { return null; }
}

export function matchesSupportingCase(identity: SupportingCaseIdentity, data: ComplaintExtractionData): boolean {
    if (identity?.version !== 1 || identity.method !== 'dc100a_pdf_fields' || !/^[a-f0-9]{64}$/.test(identity.sourceHash) ||
        !data.plaintiff?.displayName || data.defendants?.length !== 1) return false;
    const party = data.defendants[0];
    if (![party.displayName, party.address1, party.city, party.state, party.postalCode].every(value => Boolean(value?.trim()))) return false;
    const normalize = (value: string) => value.normalize('NFKC').replace(/,?\s+and all other occupants\b/ig, '')
        .toLowerCase().replace(/[\s,.'-]+/g, '');
    const address = [party.address1, party.city, party.state, party.postalCode].join(' ');
    return normalize(identity.plaintiff) === normalize(data.plaintiff.displayName) && normalize(identity.premises) === normalize(address) &&
        normalize(identity.recipient) === normalize(party.displayName + ' ' + address);
}
