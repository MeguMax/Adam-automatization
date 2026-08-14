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
    relatedCivilAction?: 'none' | 'previously_filed';
    relatedCaseCourt?: string;
    relatedCaseDocketNumber?: string;
    relatedCaseJudge?: string;
    relatedCasePending?: boolean;
    moneyJudgmentRequested?: boolean;
    claimAmount?: string;
    mailingRequested?: true;
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
    extractorVersion: 1 | 2;
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

export interface ComplaintPositionedValue {
    text: string;
    x: number;
    y: number;
    pageNumber?: number;
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

function isCheckboxMark(value: string): boolean {
    return /^(?:4|x|yes)$/i.test(normalizeLine(value));
}

function valuesInBox(
    values: ComplaintPositionedValue[],
    box: { xMin: number; xMax: number; yMin: number; yMax: number },
): ComplaintPositionedValue[] {
    return values.filter(value =>
        (value.pageNumber ?? 1) === 1 &&
        value.x >= box.xMin && value.x <= box.xMax &&
        value.y >= box.yMin && value.y <= box.yMax);
}

function checkedInBox(
    values: ComplaintPositionedValue[],
    box: { xMin: number; xMax: number; yMin: number; yMax: number },
): boolean {
    return valuesInBox(values, box).some(value => isCheckboxMark(value.text));
}

function textInBox(
    values: ComplaintPositionedValue[],
    box: { xMin: number; xMax: number; yMin: number; yMax: number },
): string | undefined {
    const text = valuesInBox(values, box)
        .filter(value => !isCheckboxMark(value.text))
        .sort((left, right) => right.y - left.y || left.x - right.x)
        .map(value => normalizeLine(value.text))
        .filter(Boolean)
        .join(' ');
    return text || undefined;
}

function normalizedMoney(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const match = value.replace(/[$,\s]/g, '').match(/^\d+(?:\.\d+)?$/);
    if (!match) return undefined;
    const amount = Number(match[0]);
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    return amount.toFixed(2);
}

function amountInBox(
    values: ComplaintPositionedValue[],
    box: { xMin: number; xMax: number; yMin: number; yMax: number },
): string | undefined {
    const candidates = valuesInBox(values, box)
        .filter(value => !isCheckboxMark(value.text))
        .sort((left, right) => left.x - right.x);
    for (const candidate of candidates) {
        const amount = normalizedMoney(candidate.text);
        if (amount) return amount;
    }
    return undefined;
}

function applyPositionedCheckboxData(
    data: ComplaintExtractionData,
    fieldConfidence: Record<string, ComplaintFieldConfidence>,
    warnings: ComplaintExtractionWarning[],
    values: ComplaintPositionedValue[],
): void {
    if (!values.length) return;

    const noRelatedAction = checkedInBox(values, {
        xMin: 35,
        xMax: 72,
        yMin: 508,
        yMax: 528,
    });
    const previousRelatedAction = checkedInBox(values, {
        xMin: 35,
        xMax: 72,
        yMin: 482,
        yMax: 504,
    });
    if (noRelatedAction !== previousRelatedAction) {
        data.relatedCivilAction = noRelatedAction ? 'none' : 'previously_filed';
        fieldConfidence.relatedCivilAction = 'high';
    } else {
        warnings.push({
            code: 'related_action_review',
            message: 'The related civil action selection in paragraph 2 is missing or ambiguous.',
        });
    }

    if (data.relatedCivilAction === 'previously_filed') {
        data.relatedCaseCourt = textInBox(values, {
            xMin: 175,
            xMax: 350,
            yMin: 471,
            yMax: 489,
        });
        const docketAndJudge = textInBox(values, {
            xMin: 60,
            xMax: 580,
            yMin: 459,
            yMax: 477,
        });
        if (docketAndJudge) {
            const docketMatch = docketAndJudge.match(/\b[A-Z0-9]+(?:-[A-Z0-9]+){1,4}\b/i);
            data.relatedCaseDocketNumber = docketMatch?.[0];
            data.relatedCaseJudge = cleanName(
                docketMatch ? docketAndJudge.replace(docketMatch[0], '') : docketAndJudge,
            ) || undefined;
        }
        const remainsPending = checkedInBox(values, {
            xMin: 100,
            xMax: 150,
            yMin: 447,
            yMax: 467,
        });
        const noLongerPending = checkedInBox(values, {
            xMin: 165,
            xMax: 225,
            yMin: 447,
            yMax: 467,
        });
        if (remainsPending !== noLongerPending) {
            data.relatedCasePending = remainsPending;
            fieldConfidence.relatedCasePending = 'high';
        }
        if (data.relatedCaseCourt) fieldConfidence.relatedCaseCourt = 'medium';
        if (data.relatedCaseDocketNumber) fieldConfidence.relatedCaseDocketNumber = 'medium';
        if (data.relatedCaseJudge) fieldConfidence.relatedCaseJudge = 'medium';
        if (
            !data.relatedCaseCourt ||
            !data.relatedCaseDocketNumber ||
            data.relatedCasePending === undefined
        ) {
            warnings.push({
                code: 'related_action_review',
                message: 'A prior civil action is selected; review its court, docket, judge, and status.',
            });
        }
    }

    const moneyJudgmentRequested = checkedInBox(values, {
        xMin: 30,
        xMax: 65,
        yMin: 88,
        yMax: 108,
    });
    data.moneyJudgmentRequested = moneyJudgmentRequested;
    fieldConfidence.moneyJudgmentRequested = 'high';
    if (!moneyJudgmentRequested) {
        data.claimAmount = '0.00';
        fieldConfidence.claimAmount = 'high';
    } else {
        data.claimAmount = amountInBox(values, {
            xMin: 120,
            xMax: 480,
            yMin: 50,
            yMax: 74,
        }) ?? amountInBox(values, {
            xMin: 380,
            xMax: 500,
            yMin: 305,
            yMax: 329,
        });
        if (data.claimAmount) {
            fieldConfidence.claimAmount = 'high';
        } else {
            warnings.push({
                code: 'claim_amount_review',
                message: 'Paragraph 10 requests a money judgment, but the claim amount was not found.',
            });
        }
    }
    data.mailingRequested = true;
    fieldConfidence.mailingRequested = 'high';
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
    options: {
        pageCount?: number;
        documentType?: string | null;
        positionedValues?: ComplaintPositionedValue[];
    } = {},
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

    applyPositionedCheckboxData(
        data,
        fieldConfidence,
        warnings,
        options.positionedValues ?? [],
    );
    if (!options.positionedValues?.length) {
        warnings.push({
            code: 'related_action_review',
            message: 'Confirm the related civil action answer; checkbox positions were not available.',
        });
        if (/Supplemental Money Judgment/i.test(options.documentType ?? '')) {
            warnings.push({
                code: 'claim_amount_review',
                message: 'Confirm the claim amount for the supplemental money judgment.',
            });
        }
    }

    return {
        extractorVersion: 2,
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
        const positionedValues: ComplaintPositionedValue[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            const textItems = content.items as TextItemLike[];
            let filledMarkerIndex = -1;
            for (let index = textItems.length - 1; index >= 0; index--) {
                if (normalizeLine(textItems[index]?.str) === 'K') {
                    filledMarkerIndex = index;
                    break;
                }
            }
            let current = '';
            let currentY: number | null = null;
            const flush = () => {
                const line = normalizeLine(current);
                if (line) lines.push(line);
                current = '';
                currentY = null;
            };

            for (const [itemIndex, rawItem] of textItems.entries()) {
                if (typeof rawItem.str !== 'string') continue;
                const transform = Array.isArray(rawItem.transform) ? rawItem.transform : [];
                const y = typeof transform[5] === 'number' ? Math.round(transform[5]) : null;
                const x = typeof transform[4] === 'number' ? transform[4] : null;
                if (
                    filledMarkerIndex >= 0 &&
                    itemIndex > filledMarkerIndex &&
                    x !== null &&
                    y !== null &&
                    normalizeLine(rawItem.str)
                ) {
                    positionedValues.push({
                        text: normalizeLine(rawItem.str),
                        x,
                        y,
                        pageNumber,
                    });
                }
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
            positionedValues,
        });
    } finally {
        await loadingTask.destroy();
    }
}
