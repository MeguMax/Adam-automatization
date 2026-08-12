import { createHash } from 'crypto';
import path from 'path';
import { validatePdfBuffer } from './pdfValidation';

export type ComplaintFieldConfidence = 'high' | 'medium' | 'low';

export interface ComplaintPartyExtraction {
    displayName: string;
    entityName?: string;
    firstName?: string;
    middleName?: string;
    lastName?: string;
    suffix?: string;
    address1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    phone?: string;
}

export interface ComplaintExtractionData {
    courtDistrict?: string;
    caseNumber?: string;
    plaintiff?: ComplaintPartyExtraction;
    defendants?: ComplaintPartyExtraction[];
    attorney?: ComplaintPartyExtraction & { barNumber?: string };
    includeAllOtherOccupants?: boolean;
}

export interface ComplaintExtractionWarning {
    code:
        | 'unsupported_form'
        | 'missing_filled_section'
        | 'missing_plaintiff'
        | 'missing_defendant'
        | 'multiple_defendants_review'
        | 'related_action_review'
        | 'claim_amount_review';
    message: string;
}

export interface ComplaintExtractionResult {
    extractorVersion: 1;
    formType: string | null;
    pageCount: number;
    textHash: string;
    data: ComplaintExtractionData;
    fieldConfidence: Record<string, ComplaintFieldConfidence>;
    warnings: ComplaintExtractionWarning[];
}

interface TextItemLike {
    str?: unknown;
    transform?: unknown;
    hasEOL?: unknown;
}

let pdfJsPromise: Promise<any> | null = null;

function loadPdfJs(): Promise<any> {
    if (!pdfJsPromise) {
        // TypeScript compiles import() to require() in CommonJS mode. Keep the native
        // import here because current PDF.js distributions are ESM-only.
        const nativeImport = new Function('specifier', 'return import(specifier)') as
            (specifier: string) => Promise<any>;
        pdfJsPromise = nativeImport('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfJsPromise;
}

function normalizeLine(value: unknown): string {
    return String(value ?? '')
        .replace(/[\u00a0\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizedLines(text: string | string[]): string[] {
    const values = Array.isArray(text) ? text : text.split(/\r?\n/);
    return values.map(normalizeLine).filter(Boolean);
}

function lastIndexOfLine(lines: string[], value: string): number {
    for (let index = lines.length - 1; index >= 0; index--) {
        if (lines[index].toUpperCase() === value.toUpperCase()) return index;
    }
    return -1;
}

function cleanName(value: string): string {
    return normalizeLine(value)
        .replace(/^v(?:\.|s\.?)?\s+/i, '')
        .replace(/[;,]+$/g, '')
        .trim();
}

function parseCityStateZip(value: string): {
    city?: string;
    state?: string;
    postalCode?: string;
} {
    const match = normalizeLine(value).match(/^(.+?)[,\s]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
    return match
        ? {
            city: cleanName(match[1]),
            state: match[2].toUpperCase(),
            postalCode: match[3],
        }
        : {};
}

function normalizedPhone(value: string): string | undefined {
    const match = normalizeLine(value).match(/(?:\+?1[\s.-]*)?\(?([2-9]\d{2})\)?[\s.-]+(\d{3})[\s.-]+(\d{4})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function personNameParts(value: string): Partial<ComplaintPartyExtraction> {
    const name = cleanName(value);
    if (!name || /[,/&]|\b(?:and|llc|inc|corp|management|property|apartments?)\b/i.test(name)) {
        return {};
    }
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 5) return {};
    const suffixMatch = parts[parts.length - 1].match(/^(Jr\.?|Sr\.?|II|III|IV)$/i);
    const suffix = suffixMatch ? parts.pop() : undefined;
    if (parts.length < 2) return {};
    return {
        firstName: parts[0],
        middleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : undefined,
        lastName: parts[parts.length - 1],
        suffix,
    };
}

function isLikelyComplaint(text: string): boolean {
    return /COMPLAINT[\s\S]{0,80}(?:NONPAYMENT OF RENT|Landlord-Tenant)/i.test(text) &&
        /SUPPLEMENTAL COMPLAINT/i.test(text);
}

function caseNumberFromLines(lines: string[]): string | undefined {
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        const match = line.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){0,3}LT\b|\b\d{2,4}-\d{3,8}-LT\b/i);
        if (match) return match[0].toUpperCase();
    }
    return undefined;
}

function districtFromLines(lines: string[], endIndex: number): string | undefined {
    for (let index = 0; index < endIndex; index++) {
        const match = lines[index].match(/^(\d{1,3}[A-Z]?)(?:st|nd|rd|th)?$/i);
        if (match) return match[1].toUpperCase();
    }
    return undefined;
}

export function isComplaintDocument(
    documentType: string | null | undefined,
    filename?: string | null,
): boolean {
    const value = `${documentType ?? ''} ${filename ?? ''}`.toLowerCase();
    return /\bcomplaint\b/.test(value) && !/supplemental complaint attachment/.test(value);
}

export function parseComplaintText(
    text: string | string[],
    options: { pageCount?: number; documentType?: string | null } = {},
): ComplaintExtractionResult {
    const lines = normalizedLines(text);
    const joined = lines.join('\n');
    const warnings: ComplaintExtractionWarning[] = [];
    const data: ComplaintExtractionData = {};
    const fieldConfidence: Record<string, ComplaintFieldConfidence> = {};
    const formType = joined.match(/COMPLAINT,?\s+(NONPAYMENT OF RENT|TERMINATION OF TENANCY)/i)?.[1]
        ?.toUpperCase() ?? null;

    if (!isLikelyComplaint(joined)) {
        warnings.push({
            code: 'unsupported_form',
            message: 'The primary PDF is not a recognized Michigan landlord-tenant Complaint form.',
        });
    }

    const markerIndex = lastIndexOfLine(lines, 'K');
    const filled = markerIndex >= 0 ? lines.slice(markerIndex + 1) : [];
    if (!filled.length) {
        warnings.push({
            code: 'missing_filled_section',
            message: 'The filled Complaint values could not be separated from the form text.',
        });
    }

    const attorneyIndex = filled.findIndex(line => /\bP\d{5,8}\b/i.test(line));
    if (attorneyIndex >= 0) {
        const attorneyLine = filled[attorneyIndex];
        const barMatch = attorneyLine.match(/\bP\d{5,8}\b/i);
        const attorneyName = cleanName(attorneyLine.slice(0, barMatch?.index ?? attorneyLine.length));
        const phoneIndex = filled.findIndex((line, index) =>
            index > attorneyIndex && index <= attorneyIndex + 5 && Boolean(normalizedPhone(line)));
        const cityIndex = phoneIndex > attorneyIndex
            ? filled.slice(attorneyIndex + 1, phoneIndex)
                .findIndex(line => Boolean(parseCityStateZip(line).state)) + attorneyIndex + 1
            : -1;
        const addressIndex = cityIndex > attorneyIndex ? cityIndex - 1 : attorneyIndex + 1;
        data.attorney = {
            displayName: attorneyName,
            ...personNameParts(attorneyName),
            barNumber: barMatch?.[0].toUpperCase(),
            address1: filled[addressIndex],
            ...(cityIndex > attorneyIndex ? parseCityStateZip(filled[cityIndex]) : {}),
            phone: phoneIndex > attorneyIndex ? normalizedPhone(filled[phoneIndex]) : undefined,
        };
        fieldConfidence['attorney'] = 'high';

        const plaintiffName = attorneyIndex > 0 ? cleanName(filled[attorneyIndex - 1]) : '';
        if (plaintiffName) {
            data.plaintiff = {
                displayName: plaintiffName,
                entityName: plaintiffName,
            };
            fieldConfidence['plaintiff'] = 'high';
        }

        const defendantIndex = phoneIndex >= 0 ? phoneIndex + 1 : attorneyIndex + 4;
        const rawDefendant = cleanName(filled[defendantIndex] ?? '');
        const includesOccupants = /(?:,?\s+and\s+)?all other occupants\b/i.test(rawDefendant);
        const defendantName = cleanName(
            rawDefendant.replace(/(?:,?\s+and\s+)?all other occupants\b/ig, ''),
        );
        if (defendantName) {
            const defendantCity = parseCityStateZip(filled[defendantIndex + 2] ?? '');
            data.defendants = [{
                displayName: defendantName,
                ...personNameParts(defendantName),
                address1: filled[defendantIndex + 1],
                ...defendantCity,
            }];
            data.includeAllOtherOccupants = includesOccupants;
            fieldConfidence['defendants'] = /\s+(?:and|&)\s+/i.test(defendantName)
                ? 'medium'
                : 'high';
            fieldConfidence['includeAllOtherOccupants'] = 'high';
            if (/\s+(?:and|&)\s+/i.test(defendantName)) {
                warnings.push({
                    code: 'multiple_defendants_review',
                    message: 'The Complaint may contain multiple Defendants; confirm how the name should be split.',
                });
            }
        }
    }

    const district = districtFromLines(filled, attorneyIndex >= 0 ? attorneyIndex : filled.length);
    if (district) {
        data.courtDistrict = district;
        fieldConfidence['courtDistrict'] = 'high';
    }

    const caseNumber = caseNumberFromLines(filled.length ? filled : lines);
    if (caseNumber) {
        data.caseNumber = caseNumber;
        fieldConfidence['caseNumber'] = 'high';
    }

    if (!data.plaintiff) {
        warnings.push({
            code: 'missing_plaintiff',
            message: 'Plaintiff information was not confidently extracted from the Complaint.',
        });
    }
    if (!data.defendants?.length) {
        warnings.push({
            code: 'missing_defendant',
            message: 'Defendant information was not confidently extracted from the Complaint.',
        });
    }
    warnings.push({
        code: 'related_action_review',
        message: 'Confirm the related civil action answer; checkbox extraction is not yet reliable.',
    });
    if (/Supplemental Money Judgment/i.test(options.documentType ?? '')) {
        warnings.push({
            code: 'claim_amount_review',
            message: 'Confirm the claim amount for the supplemental money judgment.',
        });
    }

    return {
        extractorVersion: 1,
        formType,
        pageCount: options.pageCount ?? 1,
        textHash: createHash('sha256').update(joined).digest('hex'),
        data,
        fieldConfidence,
        warnings,
    };
}

export async function extractComplaintPdf(
    buffer: Buffer,
    documentType?: string | null,
): Promise<ComplaintExtractionResult> {
    const validation = validatePdfBuffer(buffer);
    if (!validation.valid) {
        throw new Error(validation.reason ?? 'The Complaint is not a valid PDF');
    }

    const pdfJs = await loadPdfJs();
    const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const standardFontDataUrl = `${path.join(packageRoot, 'standard_fonts').replace(/\\/g, '/')}/`;
    const loadingTask = pdfJs.getDocument({
        data: new Uint8Array(buffer),
        disableWorker: true,
        useSystemFonts: true,
        standardFontDataUrl,
        isEvalSupported: false,
        verbosity: pdfJs.VerbosityLevel.ERRORS,
    });

    try {
        const document = await loadingTask.promise;
        const lines: string[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            let current = '';
            let currentY: number | null = null;
            const flush = () => {
                const line = normalizeLine(current);
                if (line) lines.push(line);
                current = '';
                currentY = null;
            };

            for (const rawItem of content.items as TextItemLike[]) {
                if (typeof rawItem.str !== 'string') continue;
                const transform = Array.isArray(rawItem.transform) ? rawItem.transform : [];
                const y = typeof transform[5] === 'number' ? Math.round(transform[5]) : null;
                if (current && currentY !== null && y !== null && Math.abs(y - currentY) > 2) {
                    flush();
                }
                const value = normalizeLine(rawItem.str);
                if (value) current += `${current ? ' ' : ''}${value}`;
                if (y !== null) currentY = y;
                if (rawItem.hasEOL === true) flush();
            }
            flush();
        }

        return parseComplaintText(lines, {
            pageCount: document.numPages,
            documentType,
        });
    } finally {
        await loadingTask.destroy();
    }
}
