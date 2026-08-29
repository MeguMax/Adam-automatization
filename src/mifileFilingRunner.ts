import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, Frame, Locator, Page } from 'playwright';
import {
    DraftParty,
    FilingDocumentPayload,
    FilingJobView,
    FilingPayload,
} from './database';
import { downloadDriveItemBuffer, resolveSharedDriveItem } from './oneDriveClient';
import { validatePdfBuffer } from './pdfValidation';

const MIFILE_LOGIN_URL =
    'https://mifile.courts.michigan.gov/login?returnurl=%2Ffile';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 180_000;
const MAX_MIFILE_FILE_BYTES = 25 * 1024 * 1024;

export interface MiFileRunnerLog {
    level: 'info' | 'warning' | 'error';
    checkpoint: string;
    message: string;
    details?: Record<string, unknown>;
}

export interface MiFilePreparationResult {
    checkpoint: 'saved_unsubmitted';
    url: string;
    externalBundleId: string | null;
    temporaryCaseNumber: string | null;
    uploadedDocuments: number;
    mifileVersion: string | null;
    screenshotPath: string | null;
}

export class MiFileFilingError extends Error {
    readonly code: string;
    readonly checkpoint: string;
    readonly debugArtifactPath: string | null;

    constructor(
        message: string,
        code: string,
        checkpoint: string,
        debugArtifactPath: string | null = null,
    ) {
        super(message);
        this.name = 'MiFileFilingError';
        this.code = code;
        this.checkpoint = checkpoint;
        this.debugArtifactPath = debugArtifactPath;
    }
}

interface MaterializedDocument {
    document: FilingDocumentPayload;
    localPath: string;
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function boundedTimeout(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? Math.min(Math.max(Math.floor(parsed), 5_000), 10 * 60_000)
        : fallback;
}

function safePathToken(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'document.pdf';
}

function courtDisplayName(value: string): string {
    return value.replace(/^MI\s+/i, '').trim();
}

function partyPersonNames(party: DraftParty): { firstName: string; lastName: string } {
    const explicitFirst = party.firstName?.trim() || '';
    const explicitLast = party.lastName?.trim() || '';
    if (explicitFirst && explicitLast) {
        return { firstName: explicitFirst, lastName: explicitLast };
    }
    const tokens = String(party.displayName || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
        throw new MiFileFilingError(
            `Party ${party.displayName || party.id} needs separate first and last names.`,
            'PARTY_NAME_INCOMPLETE',
            'case_form',
        );
    }
    return {
        firstName: explicitFirst || tokens.slice(0, -1).join(' '),
        lastName: explicitLast || tokens[tokens.length - 1],
    };
}

const STATE_NAMES: Record<string, string> = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
    KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
    MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
    NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
    NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    DC: 'District of Columbia',
};

function stateLabel(value: string | null): string {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new MiFileFilingError('Party state is required.', 'PARTY_STATE_MISSING', 'case_form');
    }
    return STATE_NAMES[normalized.toUpperCase()] || normalized;
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return null;
}

export class MiFileFilingRunner {
    private readonly timeoutMs = boundedTimeout(
        process.env.MIFILE_FILING_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
    );
    private readonly uploadTimeoutMs = boundedTimeout(
        process.env.MIFILE_FILING_UPLOAD_TIMEOUT_MS,
        DEFAULT_UPLOAD_TIMEOUT_MS,
    );
    private readonly debugRoot = path.resolve(
        process.env.MIFILE_FILING_DEBUG_DIR ||
        process.env.TRUECERTIFY_DEBUG_DIR ||
        path.join(os.tmpdir(), 'mifile-filing-debug'),
    );

    constructor(
        private readonly onLog: (entry: MiFileRunnerLog) => void | Promise<void> = () => {},
    ) {}

    async prepare(job: FilingJobView): Promise<MiFilePreparationResult> {
        if (job.mode !== 'prepare') {
            throw new MiFileFilingError(
                'Final submission is not available in the preparation runner.',
                'UNSUPPORTED_JOB_MODE',
                'starting',
            );
        }
        if (!job.payload) {
            throw new MiFileFilingError(
                'The filing job has no payload snapshot.',
                'MISSING_PAYLOAD',
                'starting',
            );
        }
        if (!process.env.MIFILE_USER || !process.env.MIFILE_PASSWORD) {
            throw new MiFileFilingError(
                'MIFILE_USER and MIFILE_PASSWORD are required.',
                'MISSING_CREDENTIALS',
                'login',
            );
        }

        const jobDirectory = path.join(this.debugRoot, safePathToken(job.id));
        const documentDirectory = path.join(jobDirectory, 'documents');
        fs.mkdirSync(documentDirectory, { recursive: true });
        let page: Page | null = null;
        let lastCheckpoint = 'starting';
        let failureScreenshot: string | null = null;

        await this.log('info', 'materialize_documents', 'Downloading filing PDFs from OneDrive.');
        const documents = await this.materializeDocuments(job.payload, documentDirectory);
        const browser = await chromium.launch({
            headless: envFlag(
                process.env.MIFILE_FILING_HEADLESS ?? process.env.TRUECERTIFY_HEADLESS,
                true,
            ),
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        try {
            page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            page.setDefaultTimeout(this.timeoutMs);
            lastCheckpoint = 'login';
            await this.login(page);
            lastCheckpoint = 'select_filing';
            await this.openNewLtCase(page, job.payload);
            lastCheckpoint = 'case_form';
            await this.completeCaseForm(page, job.payload);
            lastCheckpoint = 'document_upload';
            await this.uploadDocuments(page, documents);
            lastCheckpoint = 'save_progress';
            await this.saveProgress(page);

            const screenshotPath = path.join(jobDirectory, 'prepared.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            const bodyText = await page.locator('body').innerText();
            const result = {
                checkpoint: 'saved_unsubmitted' as const,
                url: page.url(),
                externalBundleId: this.extractBundleId(page.url(), bodyText),
                temporaryCaseNumber: bodyText.match(/\bTEMP-[A-Z0-9-]+\b/i)?.[0] ?? null,
                uploadedDocuments: documents.length,
                mifileVersion: bodyText.match(/Version\s+([\d.]+)/i)?.[1] ?? null,
                screenshotPath,
            };
            await this.log(
                'info',
                'saved_unsubmitted',
                'Bundle saved in MiFILE History > Unsubmitted. It has not been submitted to the court.',
                { uploadedDocuments: documents.length },
            );
            return result;
        } catch (error) {
            if (page) {
                failureScreenshot = path.join(jobDirectory, `failed-${safePathToken(lastCheckpoint)}.png`);
                await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => {});
            }
            if (error instanceof MiFileFilingError) {
                throw new MiFileFilingError(
                    error.message,
                    error.code,
                    error.checkpoint || lastCheckpoint,
                    error.debugArtifactPath || failureScreenshot,
                );
            }
            throw new MiFileFilingError(
                error instanceof Error ? error.message : String(error),
                'MIFILE_AUTOMATION_FAILED',
                lastCheckpoint,
                failureScreenshot,
            );
        } finally {
            await browser.close();
            if (!envFlag(process.env.MIFILE_KEEP_FILING_TEMP, false)) {
                fs.rmSync(documentDirectory, { recursive: true, force: true });
            }
        }
    }

    private async materializeDocuments(
        payload: FilingPayload,
        directory: string,
    ): Promise<MaterializedDocument[]> {
        const materialized: MaterializedDocument[] = [];
        for (let index = 0; index < payload.documents.length; index += 1) {
            const document = payload.documents[index];
            const sharedItem = await resolveSharedDriveItem(document.oneDriveUrl);
            const buffer = await downloadDriveItemBuffer(sharedItem.driveId, sharedItem.itemId);
            const validation = validatePdfBuffer(buffer);
            if (!validation.valid) {
                throw new MiFileFilingError(
                    `${document.filename} is not a valid PDF: ${validation.reason || 'validation failed'}`,
                    'INVALID_PDF',
                    'materialize_documents',
                );
            }
            if (buffer.length > MAX_MIFILE_FILE_BYTES) {
                throw new MiFileFilingError(
                    `${document.filename} exceeds the MiFILE 25 MB document limit.`,
                    'FILE_TOO_LARGE',
                    'materialize_documents',
                );
            }
            const localPath = path.join(
                directory,
                `${String(index + 1).padStart(2, '0')}-${safePathToken(document.filename)}`,
            );
            fs.writeFileSync(localPath, buffer);
            materialized.push({ document, localPath });
            await this.log('info', 'materialize_documents', 'PDF validated for MiFILE upload.', {
                documentId: document.id,
                filename: document.filename,
                bytes: buffer.length,
            });
        }
        return materialized;
    }

    private async login(page: Page): Promise<void> {
        await page.goto(MIFILE_LOGIN_URL, {
            waitUntil: 'domcontentloaded',
            timeout: this.timeoutMs,
        });
        await page.locator('#Email').fill(process.env.MIFILE_USER!);
        await page.locator('#Password').fill(process.env.MIFILE_PASSWORD!);
        await page.locator('button.login-button').click({ noWaitAfter: true });
        await page.waitForURL(url => !url.pathname.toLowerCase().includes('/login'), {
            timeout: this.timeoutMs,
        });
        await page.waitForTimeout(1_000);
        const notificationOk = await firstVisible(
            page.getByRole('button', { name: 'OK', exact: true }),
        );
        if (notificationOk) await notificationOk.click();
        if (page.url().toLowerCase().includes('/login')) {
            throw new MiFileFilingError(
                'MiFILE rejected the login or requested additional verification.',
                'LOGIN_FAILED',
                'login',
            );
        }
        await this.log('info', 'login', 'Authenticated with MiFILE.');
    }

    private async openNewLtCase(page: Page, payload: FilingPayload): Promise<void> {
        if (!page.url().endsWith('/file')) {
            await page.goto('https://mifile.courts.michigan.gov/file', {
                waitUntil: 'domcontentloaded',
                timeout: this.timeoutMs,
            });
        }
        const courtName = courtDisplayName(payload.courtName);
        const courtInput = page.locator('#court_select_dropdown');
        await courtInput.fill(courtName);
        const courtOption = await firstVisible(
            page.locator('li.inner-list-item').filter({ hasText: courtName }),
        );
        if (!courtOption) {
            throw new MiFileFilingError(
                `Court is not available in MiFILE: ${payload.courtName}`,
                'COURT_NOT_AVAILABLE',
                'select_filing',
            );
        }
        await courtOption.click();
        await page.selectOption('#actionSelect', { label: 'Initiate a new case' });
        await page.locator('#filer-input-empty').click();
        const configuredFiler = process.env.MIFILE_FILER_NAME?.trim() || 'Devlin, Adam';
        let filer = await firstVisible(page.getByText(configuredFiler, { exact: true }));
        if (!filer) {
            filer = await firstVisible(page.locator('.case-row').filter({ hasText: 'Attorney' }));
        }
        if (!filer) {
            throw new MiFileFilingError(
                `MiFILE filer is unavailable: ${configuredFiler}`,
                'FILER_NOT_AVAILABLE',
                'select_filing',
            );
        }
        await filer.click();
        await page.locator('#searchField').fill('Landlord');
        await page.getByText(payload.caseType, { exact: true }).click();
        await page.locator('#nextButton').click();
        await page.locator('#formFrame').waitFor({ state: 'visible' });
        await this.log('info', 'select_filing', 'Selected court, filer, and LT case type.', {
            courtName: payload.courtName,
            caseType: payload.caseType,
        });
    }

    private async completeCaseForm(page: Page, payload: FilingPayload): Promise<void> {
        const frame = page.frames().find(candidate => candidate.url().includes('/getform'));
        if (!frame) {
            throw new MiFileFilingError(
                'MiFILE case-initiation form did not open.',
                'CASE_FORM_NOT_FOUND',
                'case_form',
            );
        }
        await this.fillParty(frame, 0, payload.filingData.plaintiff, true);
        for (let index = 0; index < payload.filingData.defendants.length; index += 1) {
            if (index > 0) {
                await frame.getByRole('button', { name: 'Add Defendant', exact: true }).click();
            }
            await this.fillParty(frame, index + 1, payload.filingData.defendants[index], false);
        }

        if (payload.filingData.relatedCivilAction === 'none') {
            await frame.locator('#relatedCivilActions_0').check();
        } else if (payload.filingData.relatedCivilAction === 'previously_filed') {
            await frame.locator('#relatedCivilActions_1').check();
            const relatedCourt = payload.filingData.relatedCaseCourt || '';
            if (/^this court$/i.test(relatedCourt)) {
                await frame.locator('#relatedCivilActions_CourtOption_0').check();
            } else {
                await frame.locator('#relatedCivilActions_CourtOption_1').check();
                await frame.locator('#relatedCivilActions_Court').fill(relatedCourt);
            }
            await frame.locator('#relatedCivilActions_CaseNumber').fill(
                payload.filingData.relatedCaseDocketNumber || '',
            );
            await frame.locator('#relatedCivilActions_Judge').fill(
                payload.filingData.relatedCaseJudge || '',
            );
            await frame.locator(
                payload.filingData.relatedCasePending
                    ? '#relatedCivilActions_State_0'
                    : '#relatedCivilActions_State_1',
            ).check();
        } else {
            throw new MiFileFilingError(
                'Related civil action must be confirmed before preparing the filing.',
                'RELATED_ACTION_UNCONFIRMED',
                'case_form',
            );
        }

        await frame.locator('#claimAmount').fill(
            payload.filingData.moneyJudgmentRequested
                ? String(payload.filingData.claimAmount || '')
                : '0',
        );
        if (payload.filingData.mailingRequested) {
            await frame.locator('#requestSecondMail').check();
        } else {
            throw new MiFileFilingError(
                'Court service by mail is required for this workflow.',
                'MAILING_NOT_REQUESTED',
                'case_form',
            );
        }

        await frame.getByRole('button', { name: 'Save Case Initiation Form' }).click();
        await page.locator('#fileUpload').waitFor({
            state: 'attached',
            timeout: this.uploadTimeoutMs,
        }).catch(async () => {
            const validationText = await frame.locator('body').innerText().catch(() => '');
            throw new MiFileFilingError(
                `MiFILE did not accept the case form. ${validationText.slice(-1000)}`,
                'CASE_FORM_REJECTED',
                'case_form',
            );
        });
        await this.log('info', 'case_form', 'MiFILE accepted the case-initiation fields.');
    }

    private async fillParty(
        frame: Frame,
        index: number,
        party: DraftParty,
        isPlaintiff: boolean,
    ): Promise<void> {
        const prefix = `psn${index}`;
        if (party.partyType === 'entity') {
            await frame.locator(`#${prefix}IsPerson_1`).check();
            const entityName = party.entityName || party.displayName;
            if (!entityName) {
                throw new MiFileFilingError(
                    `Party ${party.id} needs an organization name.`,
                    'PARTY_NAME_INCOMPLETE',
                    'case_form',
                );
            }
            await frame.locator(`#${prefix}EntityName`).fill(entityName);
        } else {
            await frame.locator(`#${prefix}IsPerson_0`).check();
            const names = partyPersonNames(party);
            await frame.locator(`#${prefix}FirstName`).fill(names.firstName);
            await frame.locator(`#${prefix}MiddleName`).fill(party.middleName || '');
            await frame.locator(`#${prefix}FamilyName`).fill(names.lastName);
            await frame.locator(`#${prefix}Suffix`).fill(party.suffix || '');
        }
        await frame.selectOption(`#${prefix}Country`, 'US');
        await frame.locator(`#${prefix}Address`).fill(party.address1 || '');
        await frame.locator(`#${prefix}Address2`).fill(party.address2 || '');
        await frame.locator(`#${prefix}City`).fill(party.city || '');
        await frame.selectOption(`#${prefix}State`, { label: stateLabel(party.state) });
        await frame.locator(`#${prefix}Zip`).fill(party.postalCode || '');
        const phone = frame.locator(`#${prefix}Phone`);
        if (await phone.count()) await phone.fill(party.phone || '');
        const email = frame.locator(`#${prefix}Email`);
        if (await email.count() && party.email) await email.fill(party.email);
        if (isPlaintiff) {
            await frame.locator('#pty0SelfRepresented_0').check();
        }
    }

    private async uploadDocuments(
        page: Page,
        documents: MaterializedDocument[],
    ): Promise<void> {
        const uploadedRows = new Map<string, string>();
        for (const item of documents) {
            const priorCount = await page.locator('tbody[id^="filing-"] input[name^="documentName_"]').count();
            await page.locator('#fileUpload').setInputFiles(item.localPath);
            await page.waitForFunction(
                count => document.querySelectorAll(
                    'tbody[id^="filing-"] input[name^="documentName_"]',
                ).length > count,
                priorCount,
                { timeout: this.uploadTimeoutMs },
            );
            const rows = page.locator('tbody[id^="filing-"]').filter({
                has: page.locator('input[name^="documentName_"]'),
            });
            const row = rows.last();
            await row.locator('.glyphicon-ok').waitFor({
                state: 'visible',
                timeout: this.uploadTimeoutMs,
            });
            const rowId = await row.getAttribute('id');
            if (!rowId) {
                throw new MiFileFilingError(
                    `MiFILE did not create a filing row for ${item.document.filename}.`,
                    'UPLOAD_ROW_MISSING',
                    'document_upload',
                );
            }
            uploadedRows.set(item.document.id, rowId);
            await row.locator('input[name^="documentName_"]').fill(item.document.filingName);
            const typeInput = row.locator('input[id^="selectFilingTypeInput_"]');
            await typeInput.fill(item.document.filingType);
            const exactType = await firstVisible(
                page.locator('ul.dropdown-menu:visible').getByText(
                    item.document.filingType,
                    { exact: true },
                ),
            );
            if (exactType) {
                await exactType.click();
            } else {
                await typeInput.press('ArrowDown');
                await typeInput.press('Enter');
            }
            await this.log('info', 'document_upload', 'Document uploaded and classified.', {
                documentId: item.document.id,
                filename: item.document.filename,
                filingType: item.document.filingType,
            });
        }

        for (const item of documents.filter(candidate =>
            candidate.document.filingRelation === 'connected_to_complaint')) {
            const rowId = uploadedRows.get(item.document.id);
            if (!rowId) continue;
            const connect = page.locator(`#${rowId}-connect-filing`);
            if (await connect.isVisible().catch(() => false)) {
                await connect.click();
                await page.waitForTimeout(300);
                await this.log('info', 'document_upload', 'Connected ancillary filing to Complaint.', {
                    documentId: item.document.id,
                });
            }
        }
    }

    private async saveProgress(page: Page): Promise<void> {
        await page.getByRole('button', { name: 'Save Progress', exact: true }).click();
        const confirmation = page.getByText('Your progress has been saved.', { exact: false });
        await confirmation.waitFor({ state: 'visible', timeout: this.timeoutMs });
        const ok = await firstVisible(page.getByRole('button', { name: 'OK', exact: true }));
        if (ok) await ok.click();
    }

    private extractBundleId(url: string, bodyText: string): string | null {
        const fromUrl = url.match(/(?:batch|bundle|filing)[=/]([a-f0-9-]{16,}|\d+)/i)?.[1];
        if (fromUrl) return fromUrl;
        return bodyText.match(/Bundle(?:\s+No\.?|\s+Number)?\s*[:#]?\s*([A-Z0-9-]+)/i)?.[1] ?? null;
    }

    private async log(
        level: MiFileRunnerLog['level'],
        checkpoint: string,
        message: string,
        details?: Record<string, unknown>,
    ): Promise<void> {
        await this.onLog({ level, checkpoint, message, details });
    }
}
