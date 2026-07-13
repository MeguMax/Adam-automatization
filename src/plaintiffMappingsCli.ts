import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getWorkflowDatabase, PlaintiffMappingSeed } from './database';

function usage(): never {
    throw new Error(
        'Usage: node dist/plaintiffMappingsCli.js <export|import> <path-to-json-file>',
    );
}

function main(): void {
    const [command, filePath] = process.argv.slice(2);
    if (!command || !filePath || !['export', 'import'].includes(command)) usage();

    const targetPath = path.resolve(filePath);
    const db = getWorkflowDatabase();
    try {
        if (command === 'export') {
            const seed = db.exportPlaintiffMappingSeed();
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
            console.log(`Exported ${seed.mappings.length} Plaintiff mapping(s) to ${targetPath}`);
            return;
        }

        const seed = JSON.parse(fs.readFileSync(targetPath, 'utf8')) as PlaintiffMappingSeed;
        const changed = db.importPlaintiffMappingSeed(seed);
        console.log(`Imported ${changed} Plaintiff mapping(s) from ${targetPath}`);
    } finally {
        db.close();
    }
}

try {
    main();
} catch (error) {
    console.error('Plaintiff mapping import/export failed:', error);
    process.exitCode = 1;
}
