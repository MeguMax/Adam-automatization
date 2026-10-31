import { createHash } from 'node:crypto';
import { inspectFilingPdf } from './pdfValidation';
import { recognizeScannedPdf } from './pdfOcr';

export const DOCUMENT_LABELS = {
    complaint: 'Complaint', summons: 'Summons, Landlord-Tenant/Land Contract',
    request: 'Request for Court Mailing and Record (Landlord-Tenant)',
    advice: 'Advice of Rights and Information (Landlord-Tenant)',
    local: 'Local Rental and Housing Information', ancillary: 'Ancillary document', unknown: 'Unclassified PDF',
} as const;
export type RecognizedRole = keyof typeof DOCUMENT_LABELS;
export type SupportingDocumentKind = 'demand' | 'notice_to_quit' | 'lease' | 'deed' | 'affidavit' | 'other' | 'unknown';
export const DOCUMENT_RECOGNITION_VERSION = 2;
export interface DocumentRecognition {
    role: RecognizedRole;
    source: 'content' | 'filename' | 'conflict' | 'unknown' | 'supplied';
    message: string;
    textSource?: 'pdf' | 'ocr';
    supportingKind?: SupportingDocumentKind;
    contentHash?: string;
    recognitionVersion?: number;
    supportingMessage?: string;
    pdfVerified?: boolean;
    outOfScope?: boolean;
}

const SUPPORTING_TITLES: Array<[SupportingDocumentKind, RegExp]> = [
    ['demand', /^(?:state of michigan\s+)?demand for possession(?:\s+nonpayment of rent|\s*[,:-]\s*nonpayment of rent|\s*\(nonpayment of rent\))?$/i],
    ['notice_to_quit', /^(?:state of michigan\s+)?notice to quit(?:\s+to recover possession of property|\s*\(termination of tenancy\))?$/i],
    ['lease', /^(?:state of michigan\s+)?(?:residential\s+)?lease(?:\s+agreement)?$/i],
    ['deed', /^(?:state of michigan\s+)?(?:sheriff(?:'s|s)?\s+deed(?:\s+(?:on mortgage sale|on foreclosure(?: sale)?))?|(?:statutory\s+)?warranty deed|quit[-\s]*claim deed|deed)$/i],
    ['affidavit', /^(?:state of michigan\s+)?affidavit(?: of (?:service|personal service|attempted service|mailing|publication|posting|non[- ]?military service|ownership|possession|nonpayment|default|amount due|due diligence|compliance|merit))?$/i],
];

export function documentLabel(type?: string | null, filename?: string | null): string {
    const canonical = [...Object.values(DOCUMENT_LABELS), 'Other',
        'Complaint for Possession Only', 'Complaint for Possession and Supplemental Money Judgment (Fee Varies)'];
    return type && canonical.includes(type) ? type : `${type || ''} ${filename || ''}`;
}

function filenameRole(filename: string): RecognizedRole {
    const value = filename.replace(/[_-]/g, ' ').toLowerCase();
    for (const role of ['complaint', 'summons', 'request', 'advice', 'local'] as const) {
        if (new RegExp(`\\b${role}\\b`).test(value)) return role;
    }
    return /\b(demand|notice|lease|deed|affidavit|ancillary|other|connected)\b/.test(value) ? 'ancillary' : 'unknown';
}

export function recognizeDocumentText(pages: string[], filename: string): DocumentRecognition {
    const roles = new Set<RecognizedRole>();
    const supportingKinds = new Set<SupportingDocumentKind>();
    const patterns: Array<[RecognizedRole, RegExp]> = [
        ['complaint', /^(?:DC\s*102[ac]\s+)?(?:complaint|complaint[, ]+(?:for )?(?:possession|nonpayment|termination|health hazard).*|(?:judicial district\s+)?complaint to(?: recover possession of property)?|recover possession of property)$/i],
        ['summons', /^summons(?:\s*[,(-]\s*landlord[-\s]tenant(?:\s*\/\s*land contract)?\s*\)?)?$/i],
        ['request', /^request for court mailing(?: and (?:record|record of mailing by court))?(?:\s*\(.*)?$/i],
        ['advice', /^advice of rights(?: and information)?(?:\s*\(.*)?$/i],
        ['local', /^local rental (?:and|&) housing (?:information|assistance information)(?:\s*\(.*)?$/i],
        // Preserve broad Affidavit recognition without trusting arbitrary prose as a semantic title.
        ['ancillary', /^(?:state of michigan\s+)?affidavit(?: of [a-z ]+)?$/i],
    ];
    for (const page of pages) {
        const allLines = page.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
        // A scan can merge the two-column heading. The printed SCAO footer is a second title anchor.
        if (allLines.some(line=>/^DC\s*102[ac]\s*(?:\([^)]*\)\s*)?COMPLAINT\b/i.test(line))) roles.add('complaint');
        const lines = allLines.slice(0, 24);
        const candidates = lines.flatMap((line, index) => [line, `${line} ${lines[index + 1] || ''}`.trim()]);
        for (const line of candidates) {
            for (const [role, pattern] of patterns) if (pattern.test(line)) roles.add(role);
            const title = line.replace(/[\u2018\u2019\u02bc]/g, "'");
            for (const [kind, pattern] of SUPPORTING_TITLES) {
                if (!pattern.test(title)) continue;
                roles.add('ancillary');
                supportingKinds.add(kind);
            }
        }
    }
    const named = filenameRole(filename);
    const outOfScope = /\bmotion\b/i.test(filename.replace(/[_-]/g,' ')) ||
        (!roles.size && pages.some(page=>page.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(0,24)
            .some(line=>/^(?:ex parte\s+)?motion(?:\s+(?:for|to|and)\b.*)?$/i.test(line))));
    const supporting: Pick<DocumentRecognition, 'supportingKind' | 'supportingMessage' | 'recognitionVersion' | 'outOfScope'> = {
        recognitionVersion: DOCUMENT_RECOGNITION_VERSION,
        supportingKind: supportingKinds.size === 1 ? [...supportingKinds][0] : 'unknown',
        ...(outOfScope ? {outOfScope:true} : {}),
    };
    if (supportingKinds.size > 1) {
        supporting.supportingMessage = `Several supporting-document kinds were found (${[...supportingKinds].join(', ')}). The supporting PDF is retained as supplied.`;
    } else if (!supportingKinds.size && (roles.has('ancillary') || named === 'ancillary')) {
        supporting.supportingMessage = 'No recognized supporting-document title was found. Manual review is required; filenames and Other/Connected mappings do not establish the supporting kind.';
    }
    if (roles.size > 1) return { ...supporting, supportingKind: 'unknown',
        supportingMessage: supporting.supportingMessage || 'Conflicting document titles require manual review of the supporting kind.',
        role: 'unknown', source: 'conflict', message: 'Several document titles were found in this PDF. Split or classify the document before preparation.' };
    const role = [...roles][0];
    if (role && named !== 'unknown' && role !== named) return {
        ...supporting, supportingKind: 'unknown',
        supportingMessage: supporting.supportingMessage || 'The PDF title and filename conflict. Manual review is required to confirm the supporting kind.',
        role, source: 'conflict', message: 'The PDF title and filename suggest different document types. Confirm the Filing Type.',
    };
    if (role) return { ...supporting, role, source: 'content', message: 'Identified from the PDF title.' };
    if (named !== 'unknown') return { ...supporting, role: named, source: 'filename', message: 'Identified from the filename only. Check the PDF and confirm the Filing Type.' };
    return { ...supporting, role: 'unknown', source: 'unknown', message: 'No recognized document title was found. Select the Filing Type after checking the PDF.' };
}

function contentMetadata(buffer: Buffer) {
    return { contentHash: createHash('sha256').update(buffer).digest('hex'), recognitionVersion: DOCUMENT_RECOGNITION_VERSION };
}

export async function recognizeDocumentPdf(buffer: Buffer, filename: string): Promise<DocumentRecognition> {
    try { return await recognizeDocumentPages(buffer, await inspectFilingPdf(buffer), filename); }
    catch { return { ...contentMetadata(buffer), pdfVerified:false, supportingKind: 'unknown', role: 'unknown', source: 'unknown',
        supportingMessage: 'PDF text recognition failed. Manual review is required to identify the supporting kind.',
        message: 'PDF text recognition failed. Check the document and confirm its Filing Type.' }; }
}

export async function recognizeDocumentPages(buffer: Buffer, pages: string[], filename: string): Promise<DocumentRecognition> {
    const metadata = { ...contentMetadata(buffer), pdfVerified:pages.length>0 };
    const initial = recognizeDocumentText(pages, filename);
    if (initial.source === 'content' && pages.every(text => text.trim().length > 0)) return { ...initial, ...metadata, textSource: 'pdf' };
    const scanned = pages.flatMap((text, index) => text.replace(/\s/g, '').length < 80 ? [index + 1] : []);
    if (!scanned.length) return { ...initial, ...metadata, textSource: 'pdf' };
    try {
        const ocr = await recognizeScannedPdf(buffer, scanned);
        if (ocr.length !== scanned.length) throw new Error('Scan recognition did not return every requested page.');
        const combined = [...pages];
        scanned.forEach((number, i) => { combined[number - 1] = ocr[i].text; });
        const result = recognizeDocumentText(combined, filename);
        if (ocr.some(page => !Number.isFinite(page.confidence) || page.confidence < 70)) {
            return { ...result, ...metadata, supportingKind: 'unknown',
                supportingMessage: 'Low-confidence scan recognition cannot confirm a supporting-document kind. Manual review is required.',
                source: result.source === 'content' ? 'filename' : result.source, textSource: 'ocr',
                message: result.source === 'content' ? 'Low-confidence scan recognition. Check the PDF and confirm the Filing Type.' : result.message };
        }
        return { ...result, ...metadata, textSource: 'ocr', message: result.source === 'content' ? 'Identified from the scanned PDF using OCR.' : result.message };
    } catch (error) {
        return { ...initial, ...metadata, supportingKind: 'unknown',
            supportingMessage: 'Scan recognition failed or was incomplete. Manual review is required to identify the supporting kind.',
            textSource: 'ocr', source: 'unknown',
            message: `Scan needs review: ${error instanceof Error ? error.message : String(error)}` };
    }
}

export function applySuppliedSupportingPolicy(recognition:DocumentRecognition, filename:string):DocumentRecognition {
    const named=filenameRole(filename);
    const core=['complaint','summons','request','advice','local'];
    const verified=recognition.pdfVerified === true;
    if(!verified || !/^[a-f0-9]{64}$/.test(recognition.contentHash || '') || recognition.outOfScope ||
        /\bmotion\b/i.test(filename.replace(/[_-]/g,' ')) || core.includes(recognition.role) || core.includes(named) || recognition.source==='conflict') return recognition;
    if(recognition.role==='ancillary' && recognition.source==='content') return recognition;
    return {...recognition,role:'ancillary',source:'supplied',message:'Supporting PDF included as supplied; Other/Connected follows the court rule.',
        supportingMessage:'The supporting PDF is retained as supplied. Contents classification is optional.'};
}
