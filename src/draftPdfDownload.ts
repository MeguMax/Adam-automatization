/** Only read operations belong here: a timeout must never retry an uncertain cloud write. */
export async function downloadDraftPdf(url: string, options: {
    download?: (url: string, signal: AbortSignal) => Promise<Buffer>;
    timeoutMs?: number;
    timeoutMessage?: string;
} = {}): Promise<Buffer> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 120_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(Object.assign(new Error(options.timeoutMessage ||
                'PDF download timed out. Automatic recognition will retry this file separately.'), {code: 'PDF_READ_TIMEOUT'}));
            controller.abort();
        }, timeoutMs);
    });
    try {
        const read = options.download || (async (shareUrl: string, signal: AbortSignal) => {
            const drive = await import('./oneDriveClient');
            const item = await drive.resolveSharedDriveItem(shareUrl, signal);
            signal.throwIfAborted();
            return drive.downloadDriveItemBuffer(item.driveId, item.itemId, signal);
        });
        return await Promise.race([read(url, controller.signal), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
