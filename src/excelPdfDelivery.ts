import { createHash } from 'node:crypto';
import { Client, ResponseType } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';

export interface ExcelPdfSavedCopy { name: string; url: string }
export interface ExcelPdfDelivery {
    destination(): Promise<{ name: string }>;
    save(filename: string, pdf: Buffer): Promise<ExcelPdfSavedCopy>;
}

export function excelPdfFilename(form: string, input: unknown): string {
    if (input === undefined) return form.toUpperCase() + '.pdf';
    if (typeof input !== 'string' || input.length > 174 || !input.startsWith(form.toUpperCase() + ' - ') ||
        !input.endsWith('.pdf') || /[<>:"/\\|?*\x00-\x1f]/.test(input) || input.trim() !== input) {
        throw new Error('Invalid generated PDF filename.');
    }
    return input;
}

function microsoftUrl(value: unknown, upload = false): string {
    if (typeof value !== 'string') throw new Error('OneDrive did not return a valid file link.');
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(host.endsWith('.sharepoint.com') || host.endsWith('.1drv.com') ||
            (!upload && ['onedrive.live.com', '1drv.ms'].includes(host)))) {
        throw new Error('OneDrive returned an unsupported file host.');
    }
    return url.href;
}

const digest = (pdf: Buffer) => createHash('sha256').update(pdf).digest('hex');

export function createExcelOneDriveDelivery(
    env: NodeJS.ProcessEnv = process.env,
    dependencies: { client?: Client; upload?: typeof fetch } = {},
): ExcelPdfDelivery | undefined {
    // Never reuse the court worker's destination implicitly.
    const share = env.EXCEL_PDF_ONEDRIVE_SHARE_URL;
    if (!share) return undefined;
    let credential: ClientSecretCredential | undefined;
    const withGraph = async <T>(run: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> => {
        const signal = AbortSignal.timeout(40_000);
        try {
            microsoftUrl(share);
            if (!dependencies.client && (!env.TENANT_ID || !env.CLIENT_ID || !env.CLIENT_SECRET)) {
                throw new Error('OneDrive credentials are not configured for Excel delivery.');
            }
            if (!dependencies.client) credential ||= new ClientSecretCredential(env.TENANT_ID!, env.CLIENT_ID!, env.CLIENT_SECRET!);
            const client = dependencies.client || Client.initWithMiddleware({ authProvider: {
                getAccessToken: async () => {
                    const token = await credential!.getToken('https://graph.microsoft.com/.default', { abortSignal: signal });
                    if (!token) throw new Error('OneDrive access is unavailable.');
                    return token.token;
                },
            } });
            let rejectAbort: (() => void) | undefined;
            try {
                return await Promise.race([run(client, signal), new Promise<never>((_resolve, reject) => {
                    rejectAbort = () => reject(new Error('OneDrive request timed out.'));
                    signal.addEventListener('abort', rejectAbort, {once:true});
                    if (signal.aborted) rejectAbort();
                })]);
            } finally { if (rejectAbort) signal.removeEventListener('abort', rejectAbort); }
        } catch (error) {
            if (error instanceof DeliveryConflict) throw error;
            if (signal.aborted) throw new Error('OneDrive save timed out. Retry to check whether the file was saved.');
            throw new Error('Excel OneDrive delivery is unavailable. Check the configured folder and Microsoft access, then retry.');
        }
    };
    const folder = async (client: Client, signal: AbortSignal) => {
        const shareId = 'u!' + Buffer.from(share).toString('base64url');
        const item = await client.api(`/shares/${shareId}/driveItem`).options({ signal }).select('id,name,folder,parentReference').get();
        if (!item.folder || !item.id || !item.name || !item.parentReference?.driveId) throw new Error('The Excel destination must be a folder.');
        return { id: String(item.id), drive: String(item.parentReference.driveId), name: String(item.name) };
    };
    return {
        destination: () => withGraph(async (client, signal) => ({ name: (await folder(client, signal)).name })),
        save: (filename, pdf) => withGraph(async (client, signal) => {
            if (!filename.endsWith('.pdf') || filename.length > 174 || /[<>:"/\\|?*\x00-\x1f]/.test(filename)) throw new Error('Invalid filename.');
            if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pdf.length > 5 * 1024 * 1024) throw new Error('Invalid PDF.');
            const target = await folder(client, signal);
            const hash = digest(pdf);
            const name = filename.slice(0, -4) + ' - ' + hash.slice(0, 20) + '.pdf';
            const base = `/drives/${encodeURIComponent(target.drive)}/items/${encodeURIComponent(target.id)}`;
            const filePath = `${base}:/${encodeURIComponent(name)}`;
            const existing = async (): Promise<ExcelPdfSavedCopy | null> => {
                let item;
                try { item = await client.api(filePath).options({ signal }).select('id,name,size,webUrl,file,parentReference').get(); }
                catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return null; throw error; }
                if (!item.file || item.size !== pdf.length || item.name !== name || item.parentReference?.id !== target.id ||
                    item.parentReference?.driveId !== target.drive) throw new DeliveryConflict();
                const response: Response = await client.api(`/drives/${encodeURIComponent(target.drive)}/items/${encodeURIComponent(item.id)}/content`)
                    .options({ signal }).responseType(ResponseType.RAW).get();
                if (!response.ok || !response.body) throw new Error('Cannot verify OneDrive file.');
                const reader = response.body.getReader();
                const chunks: Buffer[] = [];
                let size = 0;
                try {
                    for (;;) {
                        const part = await reader.read();
                        if (part.done) break;
                        size += part.value.byteLength;
                        if (size > pdf.length) throw new DeliveryConflict();
                        chunks.push(Buffer.from(part.value));
                    }
                } finally { await reader.cancel().catch(() => {}); }
                if (size !== pdf.length || digest(Buffer.concat(chunks)) !== hash) throw new DeliveryConflict();
                return { name, url: microsoftUrl(item.webUrl) };
            };
            const found = await existing();
            if (found) return found;
            // A deterministic name plus fail-on-conflict allows safe retries after uncertain results.
            const session = await client.api(filePath + ':/createUploadSession').options({ signal }).post({ item: {
                name, '@microsoft.graph.conflictBehavior': 'fail',
            } });
            const response = await (dependencies.upload || fetch)(microsoftUrl(session.uploadUrl, true), {
                method: 'PUT', signal, redirect: 'error', body: new Uint8Array(pdf), headers: {
                    'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length),
                    'Content-Range': `bytes 0-${pdf.length - 1}/${pdf.length}`,
                },
            });
            await response.body?.cancel();
            if (![200, 201, 409].includes(response.status)) throw new Error('OneDrive save result requires verification.');
            const saved = await existing();
            if (!saved) throw new Error('OneDrive has not confirmed the saved file.');
            return saved;
        }),
    };
}

class DeliveryConflict extends Error {
    constructor() { super('An existing OneDrive file does not match this PDF. It was not overwritten. Contact support.'); }
}
