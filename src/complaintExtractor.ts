import { createHash } from 'crypto';
import path from 'path';
import { validatePdfBuffer, pdfResourceOptions } from './pdfValidation';
import { documentLabel } from './documentRecognition';
import { recognizeScannedPdf, OcrPage, OcrLine } from './pdfOcr';
import { createCanvas } from '@napi-rs/canvas';
import { readComplaintSelections, mergeComplaintSelections, type ComplaintSelections } from './pdfCheckboxes';

export const CURRENT_COMPLAINT_EXTRACTOR_VERSION = 9;

export type ComplaintFieldConfidence = 'high' | 'medium' | 'low';

export interface ComplaintPartyExtraction {
    partyType?: 'person' | 'entity';
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
        | 'claim_amount_review'
        | 'caption_review'
        | 'source_conflict'
        | 'scan_review';
    message: string;
    field?: keyof ComplaintExtractionData;
}

export interface ComplaintExtractionResult {
    textSource?: 'pdf' | 'ocr';
    contentHash?: string;
    extractorVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
    extractionMethod?: 'form_fields' | 'positioned_text' | 'ocr';
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
    width?: number;
    height?: number;
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
    const values = Array.isArray(text) ? text : text.split(/\r\n|\r|\n/);
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
        .replace(/\s*[|:]+\s*$/g, '')
        .trim();
}

function parseCityStateZip(value: string): {
    city?: string;
    state?: string;
    postalCode?: string;
} {
    const match = normalizeLine(value).match(/^(.+?)[,\s]+([A-Z]{2})\s+(\d{5})(?:-?(\d{4}))?$/i);
    return match
        ? {
            city: cleanName(match[1]),
            state: match[2].toUpperCase(),
            postalCode: match[3] + (match[4] ? '-' + match[4] : ''),
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
    return /COMPLAINT[\s\S]{0,80}(?:NONPAYMENT OF RENT|TERMINATION OF TENANCY|RECOVER POSSESSION OF PROPERTY|Landlord-Tenant)/i.test(text) &&
        /SUPPLEMENTAL COMPLAINT/i.test(text);
}

function complaintFormType(text: string): string | null {
    return text.match(/COMPLAINT[,\s]+(NONPAYMENT OF RENT|TERMINATION OF TENANCY)/i)?.[1]?.toUpperCase()
        ?? (/COMPLAINT\s+TO\s+RECOVER POSSESSION OF PROPERTY/i.test(text) ? 'RECOVER POSSESSION OF PROPERTY' : null);
}

function partyFromLines(lines: string[]): ComplaintPartyExtraction | undefined {
    if (!lines[0] || !/[a-z]{2}/i.test(lines[0])) return;
    const name = cleanName(lines[0]);
    const cityIndex = lines.findIndex(line => Boolean(parseCityStateZip(line).state));
    const addressLines = cityIndex > 0 ? lines.slice(1, cityIndex).filter(line => !/^(?:devlin law|.*P\d{5})/i.test(line)) : [];
    return {
        displayName: name, ...personNameParts(name),
        ...(cityIndex > 0 ? { address1: addressLines.join(' '), ...parseCityStateZip(lines[cityIndex]) } : {}),
        phone: lines.map(normalizedPhone).find(Boolean),
    };
}

const ENTITY_NAME = /\b(?:L\.?L\.?C\.?|L\.?L\.?P\.?|L\.?P\.?|incorporated|inc\.?|corp(?:oration)?\.?|ltd\.?|limited|association|management|apartments?|properties)\b/i;

function applyDefendants(result: Pick<ComplaintExtractionResult,'data'|'fieldConfidence'|'warnings'>,
    party: ComplaintPartyExtraction, confidence: ComplaintFieldConfidence): void {
    const boundary = party.displayName.search(/(?:,?\s+and\s+)?\ball other occupants\b/i);
    result.data.includeAllOtherOccupants = boundary >= 0;
    const name = cleanName(boundary >= 0 ? party.displayName.slice(0, boundary) : party.displayName);
    const commaParts: string[] = [];
    for (const part of name.split(/\s*,\s*/)) {
        if (commaParts.length && /^(?:L\.?L\.?C\.?|L\.?L\.?P\.?|L\.?P\.?|Inc\.?|Corp\.?|Ltd\.?|Jr\.?|Sr\.?|II|III|IV)$/i.test(part)) {
            commaParts[commaParts.length - 1] += ', ' + part;
        } else if (part.trim()) commaParts.push(part.trim());
    }
    const names = commaParts.flatMap(part => {
        const afterCompany=part.match(/^(.*?\b(?:L\.?L\.?C\.?|L\.?L\.?P\.?|Inc\.?|Corp\.?|Ltd\.?))\s+(?:and|&)\s+(.+)$/i);
        if(afterCompany) return [afterCompany[1],...afterCompany[2].split(/\s+(?:and|&)\s+/)];
        return ENTITY_NAME.test(part) ? [part] : part.split(/\s+(?:and|&)\s+/);
    }).map(cleanName).filter(Boolean);
    const canSplit = names.length > 1 && names.every(value => ENTITY_NAME.test(value) || Boolean(personNameParts(value).lastName));
    result.data.defendants = (canSplit ? names : [name]).map(displayName => ({
        ...party, displayName,
        ...(ENTITY_NAME.test(displayName) ? { partyType: 'entity' as const, entityName: displayName,
            firstName:undefined,middleName:undefined,lastName:undefined,suffix:undefined } :
            { partyType: 'person' as const, ...personNameParts(displayName) }),
    }));
    result.fieldConfidence.defendants = confidence;
    result.fieldConfidence.includeAllOtherOccupants = confidence;
    if (!canSplit && names.length > 1) result.warnings.push({
        code: 'multiple_defendants_review', message: 'Confirm how the Defendant names should be split into parties.',
    });
}

export interface ComplaintFormWidget {
    fieldName?: string;
    fieldValue?: unknown;
    fieldType?: string;
    checkBox?: boolean;
}

/** Read the typed values rather than OCRing an AcroForm's appearance streams. */
export function parseComplaintFormFields(text: string, widgets: ComplaintFormWidget[], pageCount = 1): ComplaintExtractionResult | null {
    const prefix = /\bDC\s*102c\b/i.test(text) ? 'dc102c' : /\bDC\s*102a\b/i.test(text) ? 'dc102a' : null;
    if (!prefix || !isLikelyComplaint(text)) return null;
    const fields = new Map<string, ComplaintFormWidget>();
    const conflictingFields = new Set<string>();
    const comparable = (widget: ComplaintFormWidget) => widget.fieldType === 'Btn' && widget.checkBox
        ? widget.fieldValue === 'Off' ? 'unchecked' : widget.fieldValue ? 'checked' : 'unknown'
        : typeof widget.fieldValue === 'string' ? normalizeLine(widget.fieldValue) : JSON.stringify(widget.fieldValue);
    for (const widget of widgets) {
        const key = widget.fieldName?.toLowerCase();
        if (!key) continue;
        const previous = fields.get(key);
        if (previous && (previous.fieldType !== widget.fieldType || comparable(previous) !== comparable(widget))) conflictingFields.add(key);
        fields.set(key, widget);
    }
    const field = (number: number) => {
        const key = `${prefix}_${String(number).padStart(2, '0')}`;
        return conflictingFields.has(key) ? undefined : fields.get(key);
    };
    const value = (number: number) => typeof field(number)?.fieldValue === 'string' ? String(field(number)!.fieldValue) : '';
    if (!value(5).trim() && !value(7).trim() && !conflictingFields.has(`${prefix}_05`) && !conflictingFields.has(`${prefix}_07`)) return null;
    const checked = (number: number): boolean | undefined => {
        const widget = field(number);
        if (widget?.fieldType !== 'Btn' || widget.checkBox !== true || typeof widget.fieldValue !== 'string' || !widget.fieldValue) return;
        return widget.fieldValue !== 'Off';
    };
    const result: ComplaintExtractionResult = {
        extractorVersion: 3, extractionMethod: 'form_fields', textSource: 'pdf',
        formType: complaintFormType(text), pageCount,
        textHash: createHash('sha256').update(text + JSON.stringify(widgets)).digest('hex'),
        data: { mailingRequested: true }, fieldConfidence: { mailingRequested: 'high' }, warnings: [],
    };
    const conflictGroups: Array<[keyof ComplaintExtractionData, number[], string]> = [
        ['courtDistrict', [1], 'court district'], ['plaintiff', [5], 'Plaintiff'],
        ['defendants', [7], 'Defendant names and addresses'], ['attorney', [6], 'attorney'],
        ['relatedCivilAction', [8, 9], 'paragraph 2 answer'],
        ['relatedCaseCourt', [10], 'related court'], ['relatedCaseDocketNumber', [11], 'related case reference'],
        ['relatedCaseJudge', [11], 'related case judge'],
        ['relatedCasePending', [12, 13], 'related case status'],
        ['moneyJudgmentRequested', [prefix === 'dc102c' ? 39 : 32], 'paragraph 10 answer'],
        ['claimAmount', [prefix === 'dc102c' ? 40 : 37], 'claim amount'],
    ];
    for (const [key, numbers, label] of conflictGroups) {
        if (numbers.some(number => conflictingFields.has(`${prefix}_${String(number).padStart(2, '0')}`))) {
            const partyField = ['plaintiff','defendants','attorney'].includes(key);
            result.warnings.push({code:'source_conflict',field:key,
                message:`The Complaint contains conflicting PDF field values for ${label}. ` + (partyField
                    ? 'Replace it with the correct single-case Complaint before preparation.'
                    : 'Check the source and enter the correct value, or replace the PDF.')});
        }
    }
    const plaintiff = partyFromLines(normalizedLines(value(5)));
    if (plaintiff) { result.data.plaintiff = { ...plaintiff, entityName: plaintiff.displayName }; result.fieldConfidence.plaintiff = 'high'; }
    const defendantLines = normalizedLines(value(7));
    const defendant = partyFromLines(defendantLines);
    if (defendant) applyDefendants(result, defendant, 'high');
    const cityIndex = defendantLines.findIndex(line => Boolean(parseCityStateZip(line).state));
    const extraCaption = cityIndex >= 0 ? defendantLines.slice(cityIndex + 1).filter(line => !normalizedPhone(line)) : [];
    if (extraCaption.length && !/^Notice\s+per\s+MCL\s+600\.3238\(6\)/i.test(extraCaption[0])) result.warnings.push({
        code: 'caption_review', message: 'The Defendant caption contains additional notice recipients or instructions. Review the parties before preparation.',
    });
    const attorneyLines = normalizedLines(value(6));
    const bar = attorneyLines[0]?.match(/\(?\bP\d{5,8}\b\)?/i);
    const attorney = partyFromLines([attorneyLines[0]?.replace(/\(?\bP\d{5,8}\b\)?/i, '').trim() || '', ...attorneyLines.slice(1)]);
    if (attorney && bar) { result.data.attorney = { ...attorney, barNumber: bar[0].replace(/[()]/g, '').toUpperCase() }; result.fieldConfidence.attorney = 'high'; }
    const district = value(1).trim().match(/^(\d{1,3}[AB]?(?:-?\d)?)(?:st|nd|rd|th)?$/i);
    if (district) { result.data.courtDistrict = district[1].toUpperCase(); result.fieldConfidence.courtDistrict = 'high'; }
    if (value(2).trim()) { result.data.caseNumber = value(2).trim(); result.fieldConfidence.caseNumber = 'high'; }
    const none = checked(8), previous = checked(9);
    if (none !== undefined && previous !== undefined && none !== previous) {
        result.data.relatedCivilAction = none ? 'none' : 'previously_filed';
        result.fieldConfidence.relatedCivilAction = 'high';
        if (none) result.warnings = result.warnings.filter(warning => warning.code !== 'source_conflict' ||
            !warning.field || !['relatedCaseCourt','relatedCaseDocketNumber','relatedCaseJudge','relatedCasePending'].includes(warning.field));
        if (previous) {
            result.data.relatedCaseCourt = value(10).trim() || undefined;
            const docket = value(11).match(/\b[A-Z0-9]+(?:-[A-Z0-9]+){1,4}\b/i);
            result.data.relatedCaseDocketNumber = docket?.[0];
            result.data.relatedCaseJudge = value(11).replace(docket?.[0] || '', '').trim() || undefined;
            const pending = checked(12), resolved = checked(13);
            if (pending !== undefined && resolved !== undefined && pending !== resolved) result.data.relatedCasePending = pending;
        }
    } else result.warnings.push({ code: 'related_action_review', message: 'Paragraph 2 is missing or ambiguous. Confirm the related civil action answer.' });
    const money = checked(prefix === 'dc102c' ? 39 : 32);
    if (money !== undefined) {
        result.data.moneyJudgmentRequested = money;
        result.fieldConfidence.moneyJudgmentRequested = 'high';
        result.data.claimAmount = money ? normalizedMoney(value(prefix === 'dc102c' ? 40 : 37)) : '0.00';
        if (result.data.claimAmount) result.fieldConfidence.claimAmount = 'high';
        if (!money) result.warnings = result.warnings.filter(warning => warning.code !== 'source_conflict' || warning.field !== 'claimAmount');
    }
    if (money === undefined || (money && !result.data.claimAmount)) result.warnings.push({ code: 'claim_amount_review', message: 'Confirm paragraph 10 and its total claim amount. No amount has been guessed from the rent rate.' });
    if (!plaintiff) result.warnings.push({ code: 'missing_plaintiff', message: 'Enter the Plaintiff from the Complaint.' });
    if (!defendant) result.warnings.push({ code: 'missing_defendant', message: 'Enter the Defendant names and address from the Complaint.' });
    return result;
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
    const normalized = value.trim();
    if (!/^\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2}0*)?$/.test(normalized)) return undefined;
    const amount = Number(normalized.replace(/[$,\s]/g, ''));
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
    const value = documentLabel(documentType, filename).toLowerCase();
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
    const formType = complaintFormType(joined);

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
        if (rawDefendant) {
            const defendantCity = parseCityStateZip(filled[defendantIndex + 2] ?? '');
            applyDefendants({data,fieldConfidence,warnings},{
                displayName: rawDefendant,
                address1: filled[defendantIndex + 1],
                ...defendantCity,
            },'high');
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
        ...pdfResourceOptions(),
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
        const widgets: ComplaintFormWidget[] = [];
        const layoutPages: OcrPage[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
            const page = await document.getPage(pageNumber);
            widgets.push(...await page.getAnnotations());
            const content = await page.getTextContent();
            const textItems = content.items as TextItemLike[];
            const viewport = page.getViewport({ scale: 1 });
            const layoutWords: OcrLine[] = textItems.flatMap(item => {
                if (typeof item.str !== 'string' || !item.str.trim() || !Array.isArray(item.transform)) return [];
                const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
                return [{ text: item.str.trim(), confidence: 100, pageNumber,
                    x: x * 612 / viewport.width, y: (y - (item.height || 0)) * 792 / viewport.height,
                    width: (item.width || 0) * 612 / viewport.width, height: (item.height || 0) * 792 / viewport.height }];
            });
            layoutPages.push({ text: layoutWords.map(word => word.text).join('\n'), confidence: 100, lines: layoutWords, words: layoutWords });
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
            page.cleanup();
        }

        const formResult = parseComplaintFormFields(lines.join('\n'), widgets, document.numPages);
        if (formResult) return { ...formResult, extractorVersion: CURRENT_COMPLAINT_EXTRACTOR_VERSION,
            contentHash:createHash('sha256').update(buffer).digest('hex') };

        const result = parseComplaintText(lines, {
            pageCount: document.numPages,
            documentType,
            positionedValues,
        });
        let recovered: ComplaintExtractionResult = { ...result, textSource: 'pdf' };
        if (result.warnings.some(warning => warning.code === 'missing_filled_section')) {
            const layout = parseLayoutComplaint(layoutPages, document.numPages, 'pdf');
            recovered = layout.data.plaintiff && layout.data.defendants?.length
                ? layout : parseScannedComplaint(await recognizeScannedPdf(buffer), document.numPages);
        }
        const observations: ComplaintSelections[] = [];
        for (let index = 0; index < layoutPages.length; index++) {
            if (!layoutPages[index].words.some(word => /^10\.$|^There is no other pending|^A civil action between/i.test(word.text))) continue;
            const page = await document.getPage(index + 1);
            const viewport = page.getViewport({scale:3});
            if (viewport.width * viewport.height > 5_000_000) continue;
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const context = canvas.getContext('2d');
            await page.render({canvasContext:context, viewport}).promise;
            observations.push(readComplaintSelections(context.getImageData(0,0,canvas.width,canvas.height).data,
                canvas.width, canvas.height, layoutPages[index].words));
            canvas.width=1; canvas.height=1; page.cleanup();
        }
        const selections = mergeComplaintSelections(observations);
        if (selections.money === undefined && recovered.textSource !== 'ocr' && recovered.data.moneyJudgmentRequested === false) {
            delete recovered.data.moneyJudgmentRequested;
            delete recovered.data.claimAmount;
            delete recovered.fieldConfidence.moneyJudgmentRequested;
            delete recovered.fieldConfidence.claimAmount;
            recovered.warnings.push({code:'claim_amount_review',message:'The paragraph 10 checkbox could not be verified from the page.'});
        }
        recovered = applyVisualComplaintSelections(recovered, selections, layoutPages);
        return {...recovered, extractorVersion: CURRENT_COMPLAINT_EXTRACTOR_VERSION,
            contentHash:createHash('sha256').update(buffer).digest('hex')};
    } finally {
        await loadingTask.destroy();
    }
}

export function applyVisualComplaintSelections(result: ComplaintExtractionResult, selections: ComplaintSelections,
    pages: OcrPage[]): ComplaintExtractionResult {
    const conflicts = new Set(selections.conflicts || []);
    if (conflicts.has('noRelated') || conflicts.has('previousRelated')) {
        delete result.data.relatedCivilAction;
        result.fieldConfidence.relatedCivilAction = 'low';
        result.warnings.push({code:'source_conflict',field:'relatedCivilAction',
            message:'Paragraph 2 has conflicting checkbox readings. Check the Complaint and confirm the related civil action answer.'});
    }
    if (conflicts.has('money')) {
        delete result.data.moneyJudgmentRequested;
        delete result.data.claimAmount;
        result.fieldConfidence.moneyJudgmentRequested = 'low';
        result.warnings.push({code:'source_conflict',field:'moneyJudgmentRequested',
            message:'Paragraph 10 has conflicting checkbox readings. Check the Complaint and confirm whether a money judgment is requested.'});
    }
    const amountConflict = selections.money !== false && (conflicts.has('rent') || conflicts.has('damages'));
    if (amountConflict) {
        delete result.data.claimAmount;
        result.fieldConfidence.claimAmount = 'low';
        result.warnings.push({code:'source_conflict',field:'claimAmount',
            message:'The rent or damages selection has conflicting readings. Check paragraph 10 and enter the total claim amount.'});
    }
    if (!conflicts.has('noRelated') && !conflicts.has('previousRelated') &&
        selections.noRelated !== undefined && selections.previousRelated !== undefined && selections.noRelated !== selections.previousRelated) {
        result.data.relatedCivilAction = selections.noRelated ? 'none' : 'previously_filed';
        result.fieldConfidence.relatedCivilAction = 'high';
        if (selections.noRelated) result.warnings = result.warnings.filter(w => w.code !== 'related_action_review');
    }
    if (!conflicts.has('money') && selections.money !== undefined) {
        result.data.moneyJudgmentRequested = selections.money;
        result.fieldConfidence.moneyJudgmentRequested = 'high';
        if (!selections.money) result.data.claimAmount = '0.00';
        else if (!amountConflict && selections.damages === true) {
            delete result.data.claimAmount;
            delete result.fieldConfidence.claimAmount;
            const candidates: string[] = [];
            for (const page of pages) {
                for (const anchor of page.words.filter(word => /damages/i.test(word.text) && word.confidence >= 80)) {
                    const line = page.words.filter(word => word.pageNumber === anchor.pageNumber && Math.abs(word.y - anchor.y) < 5 && word.x >= anchor.x)
                        .sort((a,b) => a.x-b.x);
                    if (!/^damages\s+claimed\s*:/i.test(line.map(word=>word.text).join(' '))) continue;
                    const amount = line.filter(word => word.confidence >= 90)
                        .map(word => normalizedMoney(word.text)).filter((value): value is string => !!value);
                    if (amount.length === 1) candidates.push(amount[0]);
                    else if (!amount.length && line.every(word=>word.confidence>=90)) {
                        const combined=line.map(word=>word.text).join(' ').match(/^damages\s+claimed\s*:\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i);
                        const total=combined && normalizedMoney(combined[1]);
                        if(total) candidates.push(total);
                    }
                }
            }
            if (new Set(candidates).size === 1) result.data.claimAmount = candidates[0];
            else if (new Set(candidates).size > 1) result.warnings.push({code:'source_conflict',field:'claimAmount',
                message:'The Complaint contains different damages totals. Check paragraph 10 and enter the correct total claim amount.'});
        } else if (!amountConflict && selections.rent === true && selections.damages === false) {
            delete result.data.claimAmount;
            delete result.fieldConfidence.claimAmount;
            const words = pages.flatMap(page => page.words);
            const amounts: string[] = [];
            for (const label of words.filter(word => /total rent due now is/i.test(word.text) && word.confidence >= 80)) {
                const candidates = words.filter(word => word.pageNumber === label.pageNumber &&
                    word.x >= label.x + label.width - 2 && word.x < label.x + label.width + 100 &&
                    word.confidence >= 90 && Math.abs(word.y - label.y) < 8)
                    .map(word => normalizedMoney(word.text)).filter((amount): amount is string => !!amount);
                if (candidates.length === 1) amounts.push(candidates[0]);
            }
            if (new Set(amounts).size === 1) result.data.claimAmount = amounts[0];
            else if (new Set(amounts).size > 1) result.warnings.push({code:'source_conflict',field:'claimAmount',
                message:'The Complaint contains different total-rent amounts. Check the source and enter the correct total claim amount.'});
        }
        if (result.data.claimAmount) {
            result.fieldConfidence.claimAmount = 'high';
            result.warnings = result.warnings.filter(w => w.code !== 'claim_amount_review');
        } else if (!result.warnings.some(warning => warning.code === 'claim_amount_review' ||
            (warning.code === 'source_conflict' && warning.field === 'claimAmount'))) {
            result.warnings.push({code:'claim_amount_review',field:'claimAmount',
                message:'Confirm the total claim amount from paragraph 10. No rent rate or earlier unverified amount has been substituted.'});
        }
    }
    return result;
}

export function parseScannedComplaint(pages: OcrPage[], pageCount = pages.length): ComplaintExtractionResult {
    return applyVisualComplaintSelections(parseLayoutComplaint(pages, pageCount, 'ocr'),
        mergeComplaintSelections(pages.map(page => page.selections || {})), pages);
}

function parseLayoutComplaint(pages: OcrPage[], pageCount: number, source: 'pdf' | 'ocr'): ComplaintExtractionResult {
    const text = pages.map(page => page.text).join('\n');
    const result = parseComplaintText(text, { pageCount });
    result.textSource = source;
    result.extractorVersion = 3;
    result.extractionMethod = source === 'ocr' ? 'ocr' : 'positioned_text';
    result.data = {};
    result.fieldConfidence = {};
    result.warnings = result.warnings.filter(warning => !['missing_filled_section', 'missing_plaintiff', 'missing_defendant'].includes(warning.code));
    const first = pages.find(page => /plaintiff.{0,10}name/i.test(page.text) && /defendant.{0,10}name/i.test(page.text));
    const words = first?.words || [];
    const groupLines = (items: OcrLine[]) => {
        const rows: OcrLine[][] = [];
        for (const word of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
            const row = rows.find(row => Math.abs(row[0].y - word.y) < 5);
            if (row) row.push(word); else rows.push([word]);
        }
        return rows.map(row => ({ x: Math.min(...row.map(word => word.x)), y: row[0].y,
            confidence: Math.min(100, ...row.filter(word => /[a-z0-9]/i.test(word.text)).map(word => word.confidence)),
            text: row.sort((a, b) => a.x - b.x).map(word => word.text).join(' ') }));
    };
    const statesAnchor = words.find(word => word.x >= 260 && word.x <= 340 &&
        /^(?:the\s+)?plaintiff\s+states\b/i.test(words.filter(other => other.x >= word.x - 0.5 &&
            Math.abs(other.y - word.y) < 5).sort((a,b) => a.x-b.x).map(other => other.text).join(' ')));
    const statesLabel = statesAnchor || groupLines(words).find(line => /\b(?:the\s+)?plaintiff\s+states\b/i.test(line.text));
    const divider = statesLabel && statesLabel.x >= 280 && statesLabel.x <= 320 ? Math.min(300, statesLabel.x) : 300;
    const left = groupLines(words.filter(word => word.x + word.width / 2 < 300));
    const right = groupLines(words.filter(word => word.x + word.width / 2 >= 300));
    const attorneyRows = groupLines(words.filter(word => word.x + word.width / 2 < divider));
    const plaintiffLabel = left.find(line => /plaintiff.{0,8}name/i.test(line.text));
    const defendantLabel = right.find(line => /defendant.{0,8}name/i.test(line.text));
    const attorneyLabel = left.find(line => /plaintiff.{0,8}attorney/i.test(line.text));
    function party(rows: Array<{y: number; text: string}>, start?: number, end?: number): ComplaintPartyExtraction | undefined {
        if (start === undefined || end === undefined) return;
        const values = rows.filter(line => line.y > start + 6 && line.y < end - 2)
            .map(line => line.text.trim().replace(/^[|\[\]]+(?=\d+\s)/, ''));
        // Caption names may wrap. The address begins at the first numbered street line.
        const contact = values.findIndex(line => /^\d+[A-Z]?(?:[-/]\d+)?\s+\S/i.test(line) ||
            Boolean(normalizedPhone(line)) || /^c\s*\/\s*o\b/i.test(line) || Boolean(parseCityStateZip(line).state));
        if (contact > 1) values.splice(0, contact, values.slice(0, contact).join(' '));
        const name = values[0];
        if (!name || !/[a-z]{2}/i.test(name) || /name,? address|telephone|plaintiff|defendant|attorney/i.test(name)) return;
        return partyFromLines(values);
    }
    const plaintiff = party(left, plaintiffLabel?.y, attorneyLabel?.y);
    if (plaintiff) {
        result.data.plaintiff = { ...plaintiff, entityName: plaintiff.displayName };
        result.fieldConfidence.plaintiff = source === 'pdf' ? 'high' : 'medium';
    }
    const defendant = party(right, defendantLabel?.y, statesLabel?.y);
    if (defendant) {
        applyDefendants(result, defendant, source === 'pdf' ? 'high' : 'medium');
    }
    const headerRows = groupLines(words.filter(word => word.y < (plaintiffLabel?.y || 180)));
    const header = headerRows.map(line => line.text).join('\n');
    const district = header.match(/\b(\d{1,3}[AB]?(?:-\d)?)(?:st|nd|rd|th)?\s+(?:judicial\s+)?district\b/i);
    if (district) {
        result.data.courtDistrict = district[1].toUpperCase();
        const line = headerRows.find(row => row.text.includes(district[0]));
        result.fieldConfidence.courtDistrict = source === 'pdf' ? 'high' : line && line.confidence < 80 ? 'low' : 'medium';
    }
    if (!district) {
        const candidates = words.filter(word => word.x < 150 && word.y > 65 && word.y < 110 && word.confidence >= (source === 'ocr' ? 50 : 80));
        const codes = candidates.map(word => word.text.match(/^(\d{1,3}[AB]?(?:-\d)?)(?:st|nd|rd|th)$/i)?.[1]).filter(Boolean);
        if (new Set(codes).size === 1) {
            result.data.courtDistrict = codes[0]!.toUpperCase();
            result.fieldConfidence.courtDistrict = candidates.some(word=>word.confidence<80) ? 'low' : 'medium';
        }
    }
    if (attorneyLabel) {
        const end = [...left, ...right].filter(line => line.y > attorneyLabel.y && /^2\.|^there is no other pending/i.test(line.text)).sort((a,b)=>a.y-b.y)[0]?.y || attorneyLabel.y + 120;
        const rows = attorneyRows.filter(line => line.y > attorneyLabel.y + 6 && line.y < end - 2).map(line => line.text);
        const bar = rows[0]?.match(/\(?\bP\d{5,8}\b\)?/i);
        const attorney = partyFromLines([rows[0]?.replace(/\(?\bP\d{5,8}\b\)?/i, '').trim() || '', ...rows.slice(1)]);
        if (attorney && bar) { result.data.attorney = { ...attorney, barNumber: bar[0].replace(/[()]/g, '').toUpperCase() }; result.fieldConfidence.attorney = source === 'pdf' ? 'high' : 'medium'; }
    }
    result.data.mailingRequested = true;
    delete result.data.moneyJudgmentRequested;
    delete result.data.claimAmount;
    delete result.data.relatedCivilAction;
    result.warnings.push({ code: 'claim_amount_review', message: 'Confirm paragraph 10 and the total claim amount. Missing checkbox text is not treated as an unchecked box.' });
    if (source === 'ocr') {
        result.warnings.push({ code: 'scan_review', message: 'Fields were read from a scan. Check the parties and addresses against the PDF before approving this package.' });
        for (const [key, start, end, rows] of [
            ['plaintiff', plaintiffLabel?.y, attorneyLabel?.y, left],
            ['defendants', defendantLabel?.y, statesLabel?.y, right],
        ] as const) {
            if (start === undefined || end === undefined) continue;
            if (rows.some(line => line.y > start + 6 && line.y < end - 2 && line.confidence < 80)) result.fieldConfidence[key] = 'low';
        }
        if (attorneyLabel && attorneyRows.some(line => line.y > attorneyLabel.y + 6 &&
            line.y < attorneyLabel.y + 65 && line.confidence < 80)) result.fieldConfidence.attorney = 'low';
        const uncertain = (['courtDistrict','plaintiff','defendants','attorney'] as const).filter(key=>result.fieldConfidence[key]==='low');
        for (const field of uncertain) result.warnings.push({code:'caption_review',field,
            message:'Check the low-confidence scan value: ' + ({courtDistrict:'court district',plaintiff:'Plaintiff name/contact details',
                defendants:'Defendant names/addresses',attorney:'attorney details'}[field]) + '.'});
    }
    if (!result.data.plaintiff) result.warnings.push({ code: 'missing_plaintiff', message: 'Enter the Plaintiff from the scanned Complaint.' });
    if (!result.data.defendants?.length) result.warnings.push({ code: 'missing_defendant', message: 'Enter the Defendant names and address from the scanned Complaint.' });
    if (source === 'ocr' && !result.data.courtDistrict) result.warnings.push({
        code:'caption_review', field:'courtDistrict', message:'The court district could not be read reliably from the Complaint. Select the court after checking the PDF.',
    });
    return result;
}
