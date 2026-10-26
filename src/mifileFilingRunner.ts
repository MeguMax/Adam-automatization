import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { chromium, Frame, Locator, Page } from 'playwright';
import {
    DraftAttorney,
    DraftParty,
    FilingDocumentPayload,
    FilingJobView,
    FilingPayload,
} from './database';
import { downloadDriveItemBuffer, resolveSharedDriveItem } from './oneDriveClient';
import { validatePdfBuffer } from './pdfValidation';
import { getMiFileRuntimeConfig } from './mifileRuntimeConfig';
import { getMiFileCredentials, MiFileCredentials } from './mifileAccountSettings';
import { authenticateMifilePage, dismissMifilePreparationNotice } from './mifileSession';
import { isRequiredMiFileFiler, isRequiredMiFileFilerOption, miFileBundleId, preparationDigest, REQUIRED_MIFILE_FILER, usdCents,
    type FilingSourceFingerprint, type MiFileFeeObservation, type MiFileSavedBundleEvidence } from './mifilePreparationEvidence';

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
    documentManifest?: MiFileDocumentReceipt[];
    savedBundleEvidence?: MiFileSavedBundleEvidence;
}

export interface MiFileDocumentReceipt {
    documentId: string;
    filename: string;
    filingName: string;
    filingType: string;
    filingRelation: 'separate' | 'connected_to_complaint';
    parentDocumentId: string | null;
    mifileRowId: string;
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
    fingerprint: FilingSourceFingerprint;
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
        const filing = job.payload.filingData;
        if (!filing || !['none', 'previously_filed'].includes(filing.relatedCivilAction) ||
            typeof filing.moneyJudgmentRequested !== 'boolean') {
            throw new MiFileFilingError(
                'Confirm Complaint paragraphs 2 and 10 before preparing the package.',
                'CASE_ANSWERS_UNCONFIRMED', 'starting',
            );
        }
        if (filing.relatedCivilAction === 'previously_filed' &&
            (!filing.relatedCaseCourt || !filing.relatedCaseDocketNumber || typeof filing.relatedCasePending !== 'boolean')) {
            throw new MiFileFilingError(
                'Complete the prior civil action court, docket number and status before preparing the package.',
                'RELATED_ACTION_UNCONFIRMED', 'starting',
            );
        }
        if (filing.moneyJudgmentRequested && (!filing.claimAmount ||
            !Number.isFinite(Number(filing.claimAmount)) || Number(filing.claimAmount) <= 0)) {
            throw new MiFileFilingError(
                'Enter the positive total claim amount from paragraph 10 before preparing the package.',
                'CLAIM_AMOUNT_UNCONFIRMED', 'starting',
            );
        }
        if (!job.payload.documents.length || job.payload.documents.some(document =>
            !['separate', 'connected_to_complaint'].includes(document.filingRelation))) {
            throw new MiFileFilingError(
                'Include the filing PDFs and choose Other or Connected for every supporting document.',
                'DOCUMENT_RELATION_UNCONFIRMED', 'starting',
            );
        }
        this.validateConnectedPackage(job.payload.documents);
        const runtimeConfig = getMiFileRuntimeConfig();
        const credentials = getMiFileCredentials();
        if (!runtimeConfig.ready) {
            throw new MiFileFilingError(
                runtimeConfig.issues.join(' '),
                'MIFILE_ACCOUNT_NOT_READY',
                'login',
            );
        }
        await this.log(
            'info',
            'account_preflight',
            `${runtimeConfig.accountLabel} verified for unsubmitted-only preparation.`,
            { accountEnvironment: runtimeConfig.accountEnvironment },
        );

        const jobDirectory = path.join(this.debugRoot, safePathToken(job.id));
        const documentDirectory = path.join(jobDirectory, 'documents');
        fs.mkdirSync(documentDirectory, { recursive: true });
        let page: Page | null = null;
        let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
        let lastCheckpoint = 'starting';
        let failureScreenshot: string | null = null;

        try {
            lastCheckpoint = 'materialize_documents';
            await this.log('info', lastCheckpoint, 'Downloading filing PDFs from OneDrive.');
            const documents = await this.materializeDocuments(job.payload, documentDirectory);
            browser = await chromium.launch({
                headless: envFlag(
                    process.env.MIFILE_FILING_HEADLESS ?? process.env.TRUECERTIFY_HEADLESS,
                    true,
                ),
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
            });
            page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
            page.setDefaultTimeout(this.timeoutMs);
            lastCheckpoint = 'login';
            await this.log('info', 'login', 'Signing in to MiFILE.');
            await this.login(page, credentials);
            lastCheckpoint = 'select_filing';
            await this.openNewLtCase(page, job.payload);
            lastCheckpoint = 'case_form';
            await this.log('info', lastCheckpoint, 'Completing the MiFILE case-initiation fields.');
            await this.completeCaseForm(page, job.payload);
            lastCheckpoint = 'document_upload';
            const documentManifest = await this.uploadDocuments(page, documents);
            lastCheckpoint = 'save_progress';
            await this.log(
                'info',
                'save_progress',
                'Saving the bundle to MiFILE History > Unsubmitted.',
            );
            await this.saveProgress(page);

            const savedUrl = page.url();
            const savedText = await page.locator('body').innerText();
            const externalBundleId = miFileBundleId(savedUrl);
            const temporaryCaseNumber = savedText.match(/\bTEMP-[A-Z0-9-]+\b/i)?.[0] || null;
            if (!externalBundleId || !temporaryCaseNumber) {
                throw new MiFileFilingError('MiFILE saved the bundle but its exact reference could not be verified.',
                    'SAVED_BUNDLE_REFERENCE_MISSING', 'save_progress');
            }
            await this.log('info', 'verify_saved_bundle', 'Reopening the saved bundle to verify its PDFs and filer.', {
                event: 'bundle_saved', externalBundleId, temporaryCaseNumber,
            });
            lastCheckpoint = 'verify_saved_bundle';
            await page.reload({ waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
            await page.locator('#documentTable').waitFor({ state: 'visible', timeout: this.timeoutMs });
            await dismissMifilePreparationNotice(page);
            await this.verifySavedBundle(page, job.payload, documentManifest, credentials.username, externalBundleId, temporaryCaseNumber);
            const sources = documents.map(document => document.fingerprint);
            const savedBundleEvidence: MiFileSavedBundleEvidence = {
                version: 1, verifiedAt: new Date().toISOString(), externalBundleId, temporaryCaseNumber,
                accountEmail: credentials.username.trim().toLowerCase(), filer: REQUIRED_MIFILE_FILER,
                courtName: job.payload.courtName, sourcePdfCount: documents.length,
                connectedPdfCount: documentManifest.filter(document => document.filingRelation === 'connected_to_complaint').length,
                generatedPdfCount: 1, packageDigest: preparationDigest(job.payload, sources), sources,
                fees: await this.observeFees(page), paymentAuthorized: false, courtSubmissionAuthorized: false,
            };

            const screenshotPath = path.join(jobDirectory, 'prepared.png');
            await page.screenshot({ path: screenshotPath, fullPage: true });
            const bodyText = await page.locator('body').innerText();
            const result = {
                checkpoint: 'saved_unsubmitted' as const,
                url: page.url(),
                externalBundleId,
                temporaryCaseNumber,
                uploadedDocuments: documents.length,
                mifileVersion: bodyText.match(/Version\s+([\d.]+)/i)?.[1] ?? null,
                screenshotPath,
                documentManifest,
                savedBundleEvidence,
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
            if (lastCheckpoint === 'login') {
                throw new MiFileFilingError(
                    error instanceof Error ? error.message :
                        'MiFILE sign-in failed or timed out. Check the account and any verification requirements.',
                    'LOGIN_FAILED', 'login', failureScreenshot,
                );
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
            try {
                await browser?.close();
            } finally {
                if (!envFlag(process.env.MIFILE_KEEP_FILING_TEMP, false)) {
                    fs.rmSync(documentDirectory, { recursive: true, force: true });
                }
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
                `${String(index + 1).padStart(2, '0')}-${safePathToken(document.filename.replace(/\.pdf$/i, ''))}.pdf`,
            );
            fs.writeFileSync(localPath, buffer);
            materialized.push({ document, localPath, fingerprint: {
                documentId: document.id, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
            } });
            await this.log('info', 'materialize_documents', 'PDF validated for MiFILE upload.', {
                documentId: document.id,
                filename: document.filename,
                bytes: buffer.length,
            });
        }
        return materialized;
    }

    private async login(page: Page, credentials: MiFileCredentials): Promise<void> {
        await authenticateMifilePage(page, credentials, { strictNotices: true });
        // The identity cookie can arrive just before MiFILE finishes its own
        // redirect to /cases. Let that navigation settle before opening /file.
        await page.waitForTimeout(1_500);
        await page.goto('https://mifile.courts.michigan.gov/file', {
            waitUntil: 'domcontentloaded',
            timeout: this.timeoutMs,
        });
        await dismissMifilePreparationNotice(page);
        if (page.url().toLowerCase().includes('/login')) {
            throw new MiFileFilingError(
                'MiFILE rejected the login or requested additional verification.',
                'LOGIN_FAILED',
                'login',
            );
        }
        await this.verifyAccount(page, credentials.username);
        await this.log('info', 'login', 'Authenticated with MiFILE.');
    }

    private async openNewLtCase(page: Page, payload: FilingPayload): Promise<void> {
        await this.log('info', 'select_filing', 'Choosing the MiFILE court, filer, and LT case type.');
        if (!page.url().endsWith('/file')) {
            await page.goto('https://mifile.courts.michigan.gov/file', {
                waitUntil: 'domcontentloaded',
                timeout: this.timeoutMs,
            });
        }
        await page.waitForTimeout(1_000);
        await dismissMifilePreparationNotice(page);
        const courtName = courtDisplayName(payload.courtName);
        const courtInput = page.locator('#court_select_dropdown');
        await courtInput.fill(courtName);
        await page.waitForTimeout(300);
        await dismissMifilePreparationNotice(page);
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
        await this.selectRequiredFiler(page);
        await this.selectCaseType(page, payload.caseType);
        await page.locator('#nextButton').click();
        await page.locator('#formFrame').waitFor({ state: 'visible' });
        await this.log('info', 'select_filing', 'Selected court, filer, and LT case type.', {
            courtName: payload.courtName,
            caseType: payload.caseType,
        });
    }

    private async selectRequiredFiler(page: Page): Promise<void> {
        const configuredFiler = REQUIRED_MIFILE_FILER;
        const selectedFiler = page.locator('#filer-input-selected');
        const selectedFilerText = await selectedFiler.inputValue().catch(() => '');
        if (!isRequiredMiFileFiler(selectedFilerText)) {
            const filerInput = page.locator('#filer-input-empty');
            await filerInput.waitFor({ state: 'visible', timeout: this.timeoutMs });
            await filerInput.click();
            const filerOptions = page.locator('#filer-listbox [role="option"]');
            await filerOptions.first().waitFor({ state: 'visible', timeout: this.timeoutMs })
                .catch(async () => {
                    // The filer list is populated asynchronously and can occasionally
                    // close before the account connections arrive. Reopening it gives
                    // MiFILE another chance without restarting the entire filing.
                    await filerInput.click();
                    await filerOptions.first().waitFor({
                        state: 'visible',
                        timeout: this.timeoutMs,
                    });
                });
            const matchingFilers = [];
            for (let index = 0; index < await filerOptions.count(); index++) {
                const option = filerOptions.nth(index);
                if (await option.isVisible() && isRequiredMiFileFilerOption(
                    await option.getAttribute('aria-label') || await option.innerText())) matchingFilers.push(option);
            }
            if (matchingFilers.length !== 1) {
                const availableFilers = (await filerOptions.allTextContents())
                    .map(value => value.trim())
                    .filter(Boolean);
                throw new MiFileFilingError(
                    `MiFILE filer is unavailable: ${configuredFiler}. ` +
                    `Available filers: ${availableFilers.join(', ') || 'none'}.`,
                    'FILER_NOT_AVAILABLE',
                    'select_filing',
                );
            }
            await matchingFilers[0].click();
        }
        const confirmedFiler = await selectedFiler.inputValue().catch(() => '');
        if (!isRequiredMiFileFiler(confirmedFiler)) {
            throw new MiFileFilingError(
                `MiFILE did not select the required filer: ${configuredFiler}.`,
                'FILER_NOT_AVAILABLE',
                'select_filing',
            );
        }
    }

    private async selectCaseType(page: Page, caseType: string): Promise<void> {
        // MiFILE can expose the search box before the asynchronously loaded tree.
        // Its initialisation can reset an earlier search, leaving all leaves hidden.
        const tree = page.getByRole('tree');
        await tree.locator('[role="treeitem"][aria-level="1"]').first()
            .waitFor({ state: 'visible', timeout: this.timeoutMs });
        await page.locator('#searchField').fill('Landlord');
        const option = tree.getByRole('treeitem', { name: caseType, exact: true });
        await option.waitFor({ state: 'visible', timeout: this.timeoutMs });
        await option.click();
        try {
            await page.waitForFunction(expected => {
                const selected = Array.from(document.querySelectorAll('[role="tree"] [role="treeitem"][aria-selected="true"]'));
                return selected.length === 1 && selected[0].textContent?.trim() === expected;
            }, caseType, { timeout: this.timeoutMs });
        } catch {
            throw new MiFileFilingError(
                `MiFILE did not confirm the requested case type: ${caseType}.`,
                'CASE_TYPE_SELECTION_UNCONFIRMED', 'select_filing',
            );
        }
    }

    private async waitForCaseForm(page: Page): Promise<Frame> {
        const element = await page.locator('#formFrame').elementHandle();
        try {
            const frame = await element?.contentFrame();
            if (!frame) throw new Error('Missing case form frame.');
            await frame.waitForURL(url => url.origin === 'https://mifile.courts.michigan.gov' &&
                url.pathname.endsWith('/getform'), { timeout: this.timeoutMs });
            await frame.locator('#psn0Address').waitFor({ state: 'visible', timeout: this.timeoutMs });
            await frame.locator('#claimAmount').waitFor({ state: 'attached', timeout: this.timeoutMs });
            return frame;
        } catch {
            throw new MiFileFilingError(
                'MiFILE case-initiation form did not finish loading. No case fields were entered.',
                'CASE_FORM_NOT_FOUND',
                'case_form',
            );
        } finally { await element?.dispose(); }
    }

    private async completeCaseForm(page: Page, payload: FilingPayload): Promise<void> {
        const frame = await this.waitForCaseForm(page);
        await this.fillParty(frame, 0, payload.filingData.plaintiff, true);
        for (let index = 0; index < payload.filingData.defendants.length; index += 1) {
            if (index > 0) {
                await frame.getByRole('button', { name: 'Add Defendant', exact: true }).click();
            }
            await this.fillParty(frame, index + 1, payload.filingData.defendants[index], false);
        }

        if (payload.filingData.relatedCivilAction === 'none') {
            await frame.locator('#relatedCivilActions_0').check({ force: true });
        } else if (payload.filingData.relatedCivilAction === 'previously_filed') {
            await frame.locator('#relatedCivilActions_1').check({ force: true });
            const relatedCourt = payload.filingData.relatedCaseCourt || '';
            if (/^this court$/i.test(relatedCourt)) {
                await frame.locator('#relatedCivilActions_CourtOption_0').check({ force: true });
            } else {
                await frame.locator('#relatedCivilActions_CourtOption_1').check({ force: true });
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
            ).check({ force: true });
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
            await frame.locator('#requestSecondMail').check({ force: true });
        } else {
            throw new MiFileFilingError(
                'Court service by mail is required for this workflow.',
                'MAILING_NOT_REQUESTED',
                'case_form',
            );
        }

        const saveForm = await firstVisible(
            frame.getByRole('button', { name: 'Save Case Initiation Form', exact: true }).or(
                frame.getByRole('button', { name: 'Save', exact: true }),
            ),
        );
        if (!saveForm) {
            throw new MiFileFilingError(
                'MiFILE case-initiation Save button was not found.',
                'CASE_FORM_SAVE_NOT_FOUND',
                'case_form',
            );
        }
        const attorneyIndex = payload.filingData.defendants.length + 1;
        const attorneyFirstName = frame.locator(`#psn${attorneyIndex}FirstName`);
        if (!(await attorneyFirstName.count())) {
            // MiFILE renders the represented-party attorney section only after
            // the base form is saved once. That first save intentionally leaves
            // the form open so the attorney fields can be completed.
            await saveForm.click();
            await attorneyFirstName.waitFor({ state: 'attached', timeout: this.timeoutMs });
        }
        await this.fillAttorney(
            frame,
            attorneyIndex,
            payload.filingData.attorney,
        );
        await this.verifyCaseAnswers(frame, payload);
        await saveForm.click();
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

    private async fillAttorney(
        frame: Frame,
        index: number,
        attorney: DraftAttorney,
    ): Promise<void> {
        const nameTokens = String(attorney.name || '').trim().split(/\s+/).filter(Boolean);
        if (nameTokens.length < 2) {
            throw new MiFileFilingError(
                'The filing attorney needs separate first and last names.',
                'ATTORNEY_NAME_INCOMPLETE',
                'case_form',
            );
        }
        const prefix = `psn${index}`;
        const attorneyPrefix = `aty${index}`;
        const registeredEmail = await frame.locator('#attorneyEmail').inputValue().catch(() => '');
        const email = attorney.email?.trim() || registeredEmail.trim();
        if (!email) {
            throw new MiFileFilingError(
                'The filing attorney email is required by MiFILE.',
                'ATTORNEY_EMAIL_MISSING',
                'case_form',
            );
        }
        await frame.locator(`#${prefix}FirstName`).fill(nameTokens.slice(0, -1).join(' '));
        await frame.locator(`#${prefix}MiddleName`).fill('');
        await frame.locator(`#${prefix}FamilyName`).fill(nameTokens[nameTokens.length - 1]);
        await frame.locator(`#${prefix}Suffix`).fill('');
        await frame.locator(`#${attorneyPrefix}BarNumber`).fill(attorney.barNumber || 'P72877');
        await frame.selectOption(`#${attorneyPrefix}Jurisdiction`, { label: 'Michigan' });
        await frame.selectOption(`#${prefix}Country`, 'US');
        await frame.locator(`#${prefix}Address`).fill(attorney.address1 || '');
        await frame.locator(`#${prefix}Address2`).fill(attorney.address2 || '');
        await frame.locator(`#${prefix}City`).fill(attorney.city || '');
        await frame.selectOption(`#${prefix}State`, { label: stateLabel(attorney.state) });
        await frame.locator(`#${prefix}Zip`).fill(attorney.postalCode || '');
        await frame.locator(`#${prefix}Email`).fill(email);
        const phone = frame.locator(`#${prefix}Phone`);
        if (await phone.count()) await phone.fill(attorney.phone || '');
    }

    private async verifyCaseAnswers(frame: Frame, payload: FilingPayload): Promise<void> {
        const filing = payload.filingData;
        const related = filing.relatedCivilAction === 'none' ? 0 : 1;
        const actualAmount = usdCents(await frame.locator('#claimAmount').inputValue());
        const expectedAmount = filing.moneyJudgmentRequested ? usdCents(filing.claimAmount || '') : 0;
        let correct = expectedAmount !== null && actualAmount === expectedAmount &&
            await frame.locator(`#relatedCivilActions_${related}`).isChecked() &&
            !await frame.locator(`#relatedCivilActions_${1 - related}`).isChecked() &&
            await frame.locator('#requestSecondMail').isChecked();
        if (filing.relatedCivilAction === 'previously_filed') {
            const sameCourt = /^this court$/i.test(filing.relatedCaseCourt || '');
            correct = correct && await frame.locator(`#relatedCivilActions_CourtOption_${sameCourt ? 0 : 1}`).isChecked() &&
                await frame.locator('#relatedCivilActions_CaseNumber').inputValue() === filing.relatedCaseDocketNumber &&
                await frame.locator(`#relatedCivilActions_State_${filing.relatedCasePending ? 0 : 1}`).isChecked();
            if (!sameCourt) correct = correct &&
                await frame.locator('#relatedCivilActions_Court').inputValue() === filing.relatedCaseCourt;
        }
        if (!correct) throw new MiFileFilingError('MiFILE did not retain the required Complaint answers, claim amount or mailing request.',
            'CASE_FORM_VALUES_MISMATCH', 'case_form');
        await this.log('info', 'case_form', 'Confirmed Complaint answers, claim amount and mailing request in the MiFILE form.');
    }

    private async verifyAccount(page: Page, username: string): Promise<void> {
        const header = await page.getByRole('banner').innerText();
        if (!header.toLowerCase().split(/\s+/).includes(username.trim().toLowerCase())) {
            throw new MiFileFilingError('The signed-in MiFILE account does not match the configured login.',
                'ACCOUNT_IDENTITY_MISMATCH', 'login');
        }
    }

    private async verifySavedBundle(page: Page, payload: FilingPayload, receipts: MiFileDocumentReceipt[],
        username: string, bundleId: string, temporaryCaseNumber: string): Promise<void> {
        try {
            if (miFileBundleId(page.url()) !== bundleId) throw new Error('MiFILE did not reopen the expected saved bundle.');
            await this.verifyAccount(page, username);
            const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
            if (!body.includes(payload.courtName.replace(/\s+/g, ' ')) ||
                body.match(/\bTEMP-[A-Z0-9-]+\b/i)?.[0] !== temporaryCaseNumber ||
                !isRequiredMiFileFiler(await page.locator('#filer-input-selected').inputValue())) {
                throw new Error('Saved bundle court, temporary case or filer did not match the preparation snapshot.');
            }
            if (await page.getByRole('checkbox', { name: 'Serve Document', exact: true }).isChecked() ||
                await page.locator('#isEmergency').isChecked()) {
                throw new Error('Unexpected service or emergency settings require review.');
            }
            await page.waitForFunction(expected => document.querySelectorAll(
                '#documentTable tbody[id^="filing-"], #documentTable tbody[id^="child-"]').length === expected,
            receipts.length + 1, { timeout: this.timeoutMs });
            const generated = page.locator('#documentTable tbody[id^="filing-"]').filter({ hasNot: page.locator('input[name^="documentName_"]') });
            if (await generated.count() !== 1 || !(await generated.innerText()).includes('CASE INIT FORM')) {
                throw new Error('The generated Case Initiation Form is missing or ambiguous.');
            }
            await this.verifyDocumentManifest(page, receipts);
        } catch (error) {
            throw new MiFileFilingError(error instanceof Error ? error.message : 'Saved bundle verification failed.',
                'SAVED_BUNDLE_VERIFICATION_FAILED', 'verify_saved_bundle');
        }
        await this.log('info', 'verify_saved_bundle', 'Reopened bundle matches the expected court, account, filer and complete PDF manifest.',
            { externalBundleId: bundleId, temporaryCaseNumber, sourcePdfCount: receipts.length });
    }

    private async observeFees(page: Page): Promise<MiFileFeeObservation> {
        const lines = await page.locator('#documentTable tbody[id]').evaluateAll(rows => rows.map(row => {
            const cells = Array.from(row.querySelector('tr')?.children || []) as HTMLElement[];
            return { label: row.querySelector<HTMLInputElement>('input[name^="documentName_"]')?.value || cells[1]?.innerText || 'Case Initiation Form',
                quantity: null, amount: cells[cells.length - 2]?.innerText || '' };
        }));
        const additional = await page.locator('table').evaluateAll(tables => tables.filter(table =>
            table.getClientRects().length && (table as HTMLElement).innerText.includes('Additional Payment Type')).flatMap(table =>
            Array.from(table.querySelectorAll('tbody tr')).map(row => {
                const cells = Array.from(row.children) as HTMLElement[];
                return { label: cells[0]?.innerText.trim() || 'Additional payment',
                    quantity: /^\d+$/.test(cells[1]?.innerText.trim() || '') ? Number(cells[1].innerText) : null,
                    amount: cells[2]?.innerText.trim() || '' };
            })));
        const observed = [...lines, ...additional].map(line => ({ label: line.label.trim().slice(0, 200),
            quantity: line.quantity, cents: usdCents(line.amount) }));
        const subtotal = observed.length && observed.every(line => line.cents !== null) &&
            additional.every(line => line.quantity === 1) &&
            additional.filter(line => line.label === 'Mailing Fee').length === 1
            ? observed.reduce((sum, line) => sum + line.cents!, 0) : null;
        return { source: 'unsubmitted_upload', currency: 'USD', observedAt: new Date().toISOString(), lines: observed,
            displayedSubtotalCents: subtotal !== null && Number.isSafeInteger(subtotal) ? subtotal : null,
            checkoutTotalCents: null, processingFeeCents: null };
    }

    private async fillParty(
        frame: Frame,
        index: number,
        party: DraftParty,
        isPlaintiff: boolean,
    ): Promise<void> {
        const prefix = `psn${index}`;
        if (party.partyType === 'entity') {
            await frame.locator(`#${prefix}IsPerson_1`).check({ force: true });
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
            await frame.locator(`#${prefix}IsPerson_0`).check({ force: true });
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
            await frame.locator('#pty0SelfRepresented_0').check({ force: true });
        }
    }

    private validateConnectedPackage(documents: FilingDocumentPayload[]): void {
        if (!documents.some(document => document.filingRelation === 'connected_to_complaint')) return;
        const primary = documents.filter(document => document.isPrimary && document.packageRole === 'complaint' && document.filingRelation === 'separate');
        if (primary.length !== 1 || documents.some(document => document.filingRelation === 'connected_to_complaint' && document.packageRole !== 'ancillary')) {
            throw new MiFileFilingError('Connected PDFs require exactly one primary Complaint and supporting documents only.', 'CONNECTED_COMPLAINT_REQUIRED', 'starting');
        }
    }

    private async waitForUpload(page: Page, rowId: string, filename: string): Promise<void> {
        const status = await page.waitForFunction(id => {
            const row = document.getElementById(id);
            if (!row) return false;
            const visible = (selector: string) => [...row.querySelectorAll<HTMLElement>(selector)].find(element =>
                element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
            if (visible('.glyphicon-remove[ng-show*="uploadStatus"]')) return 'failed';
            if (visible('.glyphicon-alert[ng-show*="uploadStatus"]')) return 'warning';
            return visible('.glyphicon-ok') ? 'uploaded' : false;
        }, rowId, { timeout: this.uploadTimeoutMs }).then(handle => handle.jsonValue()).catch(() => 'timeout');
        if (status !== 'uploaded') {
            throw new MiFileFilingError(status === 'warning'
                ? `MiFILE reported a document warning for ${filename}. Check its redactions and upload result.`
                : `MiFILE ${status === 'failed' ? 'rejected' : 'did not confirm uploading'} ${filename}.`,
            status === 'warning' ? 'DOCUMENT_UPLOAD_WARNING' : status === 'failed' ? 'DOCUMENT_UPLOAD_FAILED' : 'DOCUMENT_UPLOAD_TIMEOUT', 'document_upload');
        }
    }

    private async selectFilingType(page: Page, row: Locator, file: FilingDocumentPayload): Promise<void> {
        const typeInput = row.locator('input[id^="selectFilingTypeInput_"]');
        await typeInput.fill(file.filingType);
        await dismissMifilePreparationNotice(page);
        await typeInput.fill(file.filingType);
        const escaped = file.filingType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = `^\\s*${escaped}(?:\\s+-\\s+\\$[\\d,]+\\.\\d{2})?\\s*$`;
        const exact = page.locator('ul.dropdown-menu:visible li[role="option"]').filter({ hasText: new RegExp(pattern) }).first();
        try { await exact.waitFor({ state: 'visible', timeout: this.timeoutMs }); await exact.click(); }
        catch { throw new MiFileFilingError(`MiFILE does not offer the exact Filing Type "${file.filingType}" for ${file.filename}. Review the document type for this court.`, 'FILING_TYPE_NOT_AVAILABLE', 'document_upload'); }
        const id = await typeInput.getAttribute('id');
        await page.waitForFunction(({ id, pattern }) => {
            const input = document.getElementById(id!) as HTMLInputElement | null;
            return input && new RegExp(pattern).test(input.value) && !input.classList.contains('ng-invalid-editable') && !input.classList.contains('ng-invalid-parse');
        }, { id, pattern }, { timeout: this.timeoutMs }).catch(() => {
            throw new MiFileFilingError(`MiFILE did not confirm the selected Filing Type for ${file.filename}.`, 'FILING_TYPE_NOT_CONFIRMED', 'document_upload');
        });
    }

    private async uploadDocuments(
        page: Page,
        documents: MaterializedDocument[],
    ): Promise<MiFileDocumentReceipt[]> {
        if (!documents.length) {
            throw new MiFileFilingError(
                'The filing package does not contain any PDF documents.',
                'NO_FILING_DOCUMENTS',
                'document_upload',
            );
        }
        this.validateConnectedPackage(documents.map(item => item.document));
        const rank = (item: MaterializedDocument) => item.document.isPrimary ? 0 : item.document.filingRelation === 'connected_to_complaint' ? 1 : 2;
        documents = [...documents].sort((left, right) => rank(left) - rank(right));
        const receipts: MiFileDocumentReceipt[] = [];
        let primaryRowId: string | null = null;
        const primaryDocumentId = documents.find(item => item.document.isPrimary)?.document.id || null;
        const rows = page.locator('tbody[id^="filing-"]').filter({
            has: page.locator('input[name^="documentName_"]'),
        });
        const initialCount = await rows.count() + await page.locator('tbody[id^="child-"]').count();
        await this.log('info', 'document_upload', 'Uploading the complete PDF package to MiFILE.', {
            documentCount: documents.length,
        });
        for (let index = 0; index < documents.length; index += 1) {
            const item = documents[index];
            await this.log('info', 'document_upload', 'Uploading PDF to MiFILE.', { event: 'document_started', documentId: item.document.id,
                filename: item.document.filename, documentNumber: index + 1, documentCount: documents.length });
            try {
                const before = await rows.evaluateAll(elements => elements.map(element => element.id));
                // One source per change event avoids matching asynchronous rows by batch position.
                await page.locator('#fileUpload').setInputFiles(item.localPath);
                await page.waitForFunction(ids => [...document.querySelectorAll('tbody[id^="filing-"]')].some(row =>
                    row.querySelector('input[name^="documentName_"]') && !ids.includes(row.id)), before,
                { timeout: this.uploadTimeoutMs }).catch(() => {
                    throw new MiFileFilingError(`MiFILE did not create an upload row for ${item.document.filename}.`, 'UPLOAD_ROWS_INCOMPLETE', 'document_upload');
                });
                const after = await rows.evaluateAll(elements => elements.map(element => element.id));
                const added = after.filter(id => !before.includes(id));
                if (added.length !== 1 || before.some(id => !after.includes(id)) || !/^filing-\d+$/.test(added[0])) {
                    throw new MiFileFilingError('MiFILE changed the upload rows unexpectedly. Check the partial bundle before retrying.', 'UPLOAD_ROW_AMBIGUOUS', 'document_upload');
                }
                let rowId = added[0];
                let row = page.locator('#' + rowId);
                await this.waitForUpload(page, rowId, item.document.filename);
                const uploadedName = path.basename(item.localPath).replace(/\.pdf$/i, '').slice(0, 200);
                if (await row.locator('input[name^="documentName_"]').inputValue() !== uploadedName) {
                    throw new MiFileFilingError(`MiFILE's new upload row does not match ${item.document.filename}. No document type was assigned.`, 'UPLOAD_SOURCE_MISMATCH', 'document_upload');
                }
                await row.locator('input[name^="documentName_"]').fill(item.document.filingName);
                if (item.document.filingRelation === 'connected_to_complaint') {
                    const position = after.indexOf(rowId);
                    if (!primaryRowId || position < 1 || after[position - 1] !== primaryRowId) {
                        throw new MiFileFilingError('The supporting PDF is not directly below its primary Complaint. Connection was stopped.', 'CONNECTED_PARENT_MISMATCH', 'document_upload');
                    }
                    const parentIndex = primaryRowId.slice('filing-'.length);
                    const children = page.locator(`tbody[id^="child-${parentIndex}-"]`);
                    const childIndex = await children.count();
                    const connect = row.locator('[id$="-connect-filing"]');
                    if (!await connect.isVisible().catch(() => false) || !await connect.isEnabled()) {
                        throw new MiFileFilingError(`MiFILE cannot connect ${item.document.filename} to the Complaint. Review the court rule.`, 'CONNECTED_FILING_UNAVAILABLE', 'document_upload');
                    }
                    await connect.click();
                    rowId = `child-${parentIndex}-${childIndex}`;
                    await page.waitForFunction(({ rowId, name, expectedParents }) => {
                        const child = document.getElementById(rowId);
                        const parents = [...document.querySelectorAll('tbody[id^="filing-"]')].filter(row => row.querySelector('input[name^="documentName_"]'));
                        return child?.querySelector<HTMLInputElement>('input[name^="documentName_"]')?.value === name && parents.length === expectedParents;
                    }, { rowId, name: item.document.filingName, expectedParents: before.length }, { timeout: this.timeoutMs }).catch(() => {
                        throw new MiFileFilingError(`MiFILE did not confirm connecting ${item.document.filename} to its Complaint.`, 'CONNECTED_FILING_NOT_CONFIRMED', 'document_upload');
                    });
                    row = page.locator('#' + rowId);
                    if ((await row.locator('td').nth(4).innerText()).trim() !== 'CONNECTED FILING') {
                        throw new MiFileFilingError('MiFILE did not label the attached PDF as CONNECTED FILING. Review this court\'s connection/merge rule.', 'CONNECTED_FILING_NOT_CONFIRMED', 'document_upload');
                    }
                } else await this.selectFilingType(page, row, item.document);
                if (item.document.isPrimary) primaryRowId = rowId;
                const receipt: MiFileDocumentReceipt = { documentId: item.document.id, filename: item.document.filename,
                    filingName: item.document.filingName, filingType: item.document.filingRelation === 'connected_to_complaint' ? 'CONNECTED FILING' : item.document.filingType,
                    filingRelation: item.document.filingRelation as 'separate' | 'connected_to_complaint',
                    parentDocumentId: item.document.filingRelation === 'connected_to_complaint' ? primaryDocumentId : null, mifileRowId: rowId };
                receipts.push(receipt);
                await this.log('info', 'document_upload', 'PDF uploaded and verified in MiFILE.', { ...receipt, event: 'document_ready', documentNumber: index + 1, documentCount: documents.length });
            } catch (error) {
                await this.log('error', 'document_upload', error instanceof Error ? error.message : String(error), {
                    event: 'document_failed', documentId: item.document.id, filename: item.document.filename,
                    documentNumber: index + 1, documentCount: documents.length,
                });
                throw error;
            }
        }
        if (await rows.count() + await page.locator('tbody[id^="child-"]').count() !== initialCount + documents.length) {
            throw new MiFileFilingError('The MiFILE PDF count changed before saving. Check every source PDF.', 'UPLOAD_MANIFEST_MISMATCH', 'document_upload');
        }
        await this.verifyDocumentManifest(page, receipts);
        return receipts;
    }

    private async verifyDocumentManifest(page: Page, receipts: MiFileDocumentReceipt[]): Promise<void> {
        if (!receipts.length || new Set(receipts.map(receipt => receipt.documentId)).size !== receipts.length ||
            new Set(receipts.map(receipt => receipt.mifileRowId)).size !== receipts.length) {
            throw new MiFileFilingError('The PDF manifest contains missing or duplicate identities.', 'UPLOAD_MANIFEST_MISMATCH', 'document_upload');
        }
        for (const receipt of receipts) {
            const row = page.locator('#' + receipt.mifileRowId);
            if (await row.count() !== 1 || await row.locator('input[name^="documentName_"]').inputValue() !== receipt.filingName) {
                throw new MiFileFilingError(`MiFILE lost or replaced the upload row for ${receipt.filename}.`, 'UPLOAD_MANIFEST_MISMATCH', 'document_upload');
            }
            await this.waitForUpload(page, receipt.mifileRowId, receipt.filename);
            const escaped = receipt.filingType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const selectedType = receipt.filingRelation === 'connected_to_complaint'
                ? (await row.locator('td').nth(4).innerText()).trim()
                : await row.locator('input[id^="selectFilingTypeInput_"]').inputValue();
            if (!new RegExp(`^\\s*${escaped}(?:\\s+-\\s+\\$[\\d,]+\\.\\d{2})?\\s*$`).test(selectedType)) {
                throw new MiFileFilingError(`MiFILE changed the Filing Type for ${receipt.filename} before saving.`, 'UPLOAD_MANIFEST_MISMATCH', 'document_upload');
            }
            if (receipt.filingRelation === 'connected_to_complaint') {
                const parent = receipts.find(item => item.documentId === receipt.parentDocumentId);
                if (!parent || !/^filing-\d+$/.test(parent.mifileRowId) ||
                    !receipt.mifileRowId.startsWith(`child-${parent.mifileRowId.slice('filing-'.length)}-`)) {
                    throw new MiFileFilingError(`The Connected parent for ${receipt.filename} changed.`,
                        'UPLOAD_MANIFEST_MISMATCH', 'document_upload');
                }
            }
        }
    }

    private async saveProgress(page: Page): Promise<void> {
        await page.getByRole('button', { name: 'Save Progress', exact: true }).click();
        const confirmation = page.getByText('Your progress has been saved.', { exact: false });
        await confirmation.waitFor({ state: 'visible', timeout: this.timeoutMs });
        const savedDialog = await firstVisible(page.getByRole('dialog').filter({ hasText: 'Your progress has been saved.' }));
        if (savedDialog) {
            await savedDialog.getByRole('button', { name: 'OK', exact: true }).click();
            await savedDialog.waitFor({ state: 'hidden' });
        }
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
