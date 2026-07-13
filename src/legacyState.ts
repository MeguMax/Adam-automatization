import fs from 'fs/promises';

const LEGACY_STATE_PATH = 'processedEmails.json';

export interface ProcessedState {
    messageIds: string[];
}

export async function loadLegacyProcessed(): Promise<ProcessedState> {
    try {
        const raw = await fs.readFile(LEGACY_STATE_PATH, 'utf8');
        return JSON.parse(raw);
    } catch {
        return { messageIds: [] };
    }
}
