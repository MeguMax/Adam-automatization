import { districtCode } from './courtForms';

export const ADAM_FILING_POLICY_VERSION = 'adam-confirmed-2026-10-25';

export const ADAM_OFFICE = {
    address1: '30850 Telegraph Rd Ste 250',
    city: 'Bingham Farms',
    state: 'MI',
    postalCode: '48025',
    phone: '248-703-6201',
    email: 'ajd@devlinlawpllc.com',
} as const;

export const ADAM_ATTORNEY = { name: 'Adam J Devlin', barNumber: 'P72877', ...ADAM_OFFICE } as const;

const CONNECTED_COURTS = new Set(['45', '17', '47', '41A-1', '18', '1', '32A', '71A', '54A', '66', '56A', '73A']);

/** Attorney-supplied workflow policy, not a rule inferred from court practice. */
export function approvedSupportingRelation(courtName: string): 'separate' | 'connected_to_complaint' | null {
    if (!/^MI\s+.+\bDistrict Court\b/i.test(courtName)) return null;
    const code = districtCode(courtName);
    if (!code) return null;
    // 41A's divisions differ. An unspecified division is not safe to classify.
    if (code === '41A') return null;
    return CONNECTED_COURTS.has(code) ? 'connected_to_complaint' : 'separate';
}
