import { inspectFilingPdf } from './pdfValidation';
import { recognizeScannedPdf } from './pdfOcr';

export const DOCUMENT_LABELS = {
    complaint: 'Complaint', summons: 'Summons, Landlord-Tenant/Land Contract',
    request: 'Request for Court Mailing and Record (Landlord-Tenant)',
    advice: 'Advice of Rights and Information (Landlord-Tenant)',
    local: 'Local Rental and Housing Information', ancillary: 'Ancillary document', unknown: 'Unclassified PDF',
} as const;
export type RecognizedRole = keyof typeof DOCUMENT_LABELS;
export interface DocumentRecognition {
    role: RecognizedRole;
    source: 'content' | 'filename' | 'conflict' | 'unknown';
    message: string;
    textSource?: 'pdf' | 'ocr';
}

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
    return /\b(demand|notice|lease|deed|ancillary|other|connected)\b/.test(value) ? 'ancillary' : 'unknown';
}

export function recognizeDocumentText(pages: string[], filename: string): DocumentRecognition {
    const roles = new Set<RecognizedRole>();
    const patterns: Array<[RecognizedRole, RegExp]> = [
        ['complaint', /^(?:complaint|complaint[, ]+(?:for )?(?:possession|nonpayment|termination|health hazard).*)$/i],
        ['summons', /^summons(?:\s*[,(-]\s*landlord[-\s]tenant(?:\s*\/\s*land contract)?\s*\)?)?$/i],
        ['request', /^request for court mailing and record(?:\s*\(.*)?$/i],
        ['advice', /^advice of rights(?: and information)?(?:\s*\(.*)?$/i],
        ['local', /^local rental (?:and|&) housing (?:information|assistance information)(?:\s*\(.*)?$/i],
        ['ancillary', /^(?:demand for possession.*|notice to quit.*|residential lease(?: agreement)?|lease agreement|warranty deed|quitclaim deed)$/i],
    ];
    for (const page of pages) {
        const lines = page.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 24);
        const candidates = lines.flatMap((line, index) => [line, `${line} ${lines[index + 1] || ''}`.trim()]);
        for (const line of candidates) for (const [role, pattern] of patterns) if (pattern.test(line)) roles.add(role);
    }
    const named = filenameRole(filename);
    if (roles.size > 1) return { role: 'unknown', source: 'conflict', message: 'Several document titles were found in this PDF. Split or classify the document before preparation.' };
    const role = [...roles][0];
    if (role && named !== 'unknown' && role !== named) return {
        role, source: 'conflict', message: 'The PDF title and filename suggest different document types. Confirm the Filing Type.',
    };
    if (role) return { role, source: 'content', message: 'Identified from the PDF title.' };
    if (named !== 'unknown') return { role: named, source: 'filename', message: 'Identified from the filename only. Check the PDF and confirm the Filing Type.' };
    return { role: 'unknown', source: 'unknown', message: 'No recognized document title was found. Select the Filing Type after checking the PDF.' };
}

export async function recognizeDocumentPdf(buffer: Buffer, filename: string): Promise<DocumentRecognition> {
    try { return await recognizeDocumentPages(buffer, await inspectFilingPdf(buffer), filename); }
    catch { return { role: 'unknown', source: 'unknown', message: 'PDF text recognition failed. Check the document and confirm its Filing Type.' }; }
}

export async function recognizeDocumentPages(buffer: Buffer, pages: string[], filename: string): Promise<DocumentRecognition> {
    const initial = recognizeDocumentText(pages, filename);
    if (initial.source === 'content' && pages.every(text => text.trim().length > 0)) return { ...initial, textSource: 'pdf' };
    const scanned = pages.flatMap((text, index) => text.replace(/\s/g, '').length < 80 ? [index + 1] : []);
    if (!scanned.length) return { ...recognizeDocumentText(pages, filename), textSource: 'pdf' };
    try {
        const ocr = await recognizeScannedPdf(buffer, scanned);
        const combined = [...pages];
        scanned.forEach((number, i) => { combined[number - 1] = ocr[i].text; });
        const result = recognizeDocumentText(combined, filename);
        if (ocr.some(page => page.confidence < 70) && result.source === 'content') {
            return { ...result, source: 'filename', textSource: 'ocr', message: 'Low-confidence scan recognition. Check the PDF and confirm the Filing Type.' };
        }
        return { ...result, textSource: 'ocr', message: result.source === 'content' ? 'Identified from the scanned PDF using OCR.' : result.message };
    } catch (error) {
        return { ...recognizeDocumentText(pages, filename), textSource: 'ocr', source: 'unknown',
            message: `Scan needs review: ${error instanceof Error ? error.message : String(error)}` };
    }
}
