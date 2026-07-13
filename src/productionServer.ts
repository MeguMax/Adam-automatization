import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import { createAdminServer } from './adminServer';
import { getWorkflowDatabase, PlaintiffMappingSeed } from './database';
import { runWorker } from './index';

function isWorkerEnabled(): boolean {
    const value = (process.env.WORKER_ENABLED ?? 'true').trim().toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(value);
}

function importPlaintiffMappingSeed(): void {
    const seedPath = process.env.PLAINTIFF_MAPPINGS_SEED_PATH?.trim();
    if (!seedPath) return;

    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as PlaintiffMappingSeed;
    const db = getWorkflowDatabase();
    const changed = db.importPlaintiffMappingSeed(seed);
    console.log(`Imported ${changed} Plaintiff mapping(s) from startup seed: ${seedPath}`);
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise(resolve => {
        server.close(() => resolve());
    });
}

async function main(): Promise<void> {
    importPlaintiffMappingSeed();

    const port = Number(process.env.PORT || process.env.ADMIN_PORT || 3000);
    const server = createAdminServer(port, {
        handleSignals: false,
        closeDatabaseOnShutdown: false,
    });
    const controller = new AbortController();
    const workerEnabled = isWorkerEnabled();
    const workerPromise = workerEnabled
        ? runWorker({ signal: controller.signal, closeDatabaseOnExit: false })
        : Promise.resolve();
    let shuttingDown = false;

    const shutdown = async (reason: string, exitCode = 0) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Production service shutdown requested: ${reason}`);
        controller.abort();
        await Promise.all([
            closeServer(server),
            workerPromise.catch(error => {
                console.error('Worker stopped during shutdown:', error);
            }),
        ]);
        getWorkflowDatabase().close();
        process.exit(exitCode);
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    if (workerEnabled) {
        console.log('Production worker enabled.');
        workerPromise.catch(error => {
            console.error('Production worker stopped unexpectedly:', error);
            void shutdown('worker failure', 1);
        });
    } else {
        console.log('Production worker disabled; admin-only bootstrap mode is active.');
    }
}

main().catch(error => {
    console.error('Production service failed to start:', error);
    process.exitCode = 1;
});
