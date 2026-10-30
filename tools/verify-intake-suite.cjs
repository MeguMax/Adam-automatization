const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

function checkResult(report, expected = {}) {
    let comparedFields = 0;
    const subset = (actual, wanted, field) => {
        if (wanted && typeof wanted === 'object') {
            for (const [key, value] of Object.entries(wanted)) subset(actual?.[key], value, field + '.' + key);
        } else { assert.deepEqual(actual, wanted, field); comparedFields++; }
    };
    assert.equal(report.networkAttempts, 0, 'Acceptance must not access external services');
    assert.equal(report.filingJobs, 0, 'Acceptance must not create MiFILE jobs');
    assert.equal(report.manualOverridePreserved, true);
    assert.equal(report.reprocessingIdempotent, true);
    assert.ok(report.documents.every(document => document.status === 'uploaded'), 'Every supplied PDF must survive processing');
    if (expected.pdfCount !== undefined) assert.equal(report.pdfCount, expected.pdfCount, 'PDF package count');
    if (expected.review !== undefined) assert.equal(report.issues.length > 0, expected.review, 'Review requirement');
    if (expected.extraction) subset(report.extraction.data, expected.extraction, 'Complaint');
    for (const field of expected.errorFields || []) {
        assert.ok(report.issues.some(issue => issue.severity === 'error' && issue.field === field), 'Missing required error: ' + field);
    }
    for (const kind of expected.documentKinds || []) {
        assert.ok(report.documents.some(document => document.recognition?.source === 'content' &&
            document.recognition.supportingKind === kind), 'Missing positive document evidence: ' + kind);
    }
    for (const name of expected.excludedDefendants || []) {
        assert.ok(!report.fields.defendants.some(party => party.displayName?.toLowerCase().includes(name.toLowerCase())),
            'A notice recipient must not become a Defendant: ' + name);
    }
    return comparedFields;
}

function validateManifest(manifest) {
    assert.equal(manifest.version, 1, 'Unsupported acceptance manifest');
    assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0 && manifest.cases.length <= 30);
    const ids = new Set();
    for (const sample of manifest.cases) {
        assert.match(sample.id, /^[a-z0-9][a-z0-9-]{0,69}$/);
        assert.ok(!ids.has(sample.id), 'Duplicate sample ID'); ids.add(sample.id);
        assert.ok(Array.isArray(sample.files) && sample.files.length > 0 && sample.files.length <= 30);
        assert.ok(sample.files.every(filename => typeof filename === 'string' && /\.pdf$/i.test(filename)));
        assert.ok(typeof sample.expected?.review === 'boolean', 'Each sample must define whether review is expected');
    }
}

function runSuite(manifestFile, outputDirectory) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    validateManifest(manifest);
    const root = path.dirname(path.resolve(manifestFile)), output = path.resolve(outputDirectory);
    fs.mkdirSync(output, { recursive: true });
    const results = [];
    for (const sample of manifest.cases) {
        const started = Date.now(), filename = path.join(output, sample.id + '.json');
        const args = [path.join(__dirname, 'verify-local-intake.cjs'), '--output', filename];
        if (manifest.forms) args.push('--forms', path.resolve(root, manifest.forms));
        if (sample.expected.review) args.push('--expect-review');
        args.push(...sample.files.map(file => path.resolve(root, file)));
        const child = spawnSync(process.execPath, args, { timeout: 480_000, windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
        fs.writeFileSync(path.join(output, sample.id + '.log'), (child.stdout || '') + (child.stderr || ''));
        try {
            assert.equal(child.error, undefined, child.error?.message);
            assert.equal(child.status, 0, 'The isolated intake process failed; see its local log');
            const report = JSON.parse(fs.readFileSync(filename, 'utf8'));
            const expected = { ...sample.expected };
            if (expected.extractionFile) expected.extraction = JSON.parse(fs.readFileSync(path.resolve(root, expected.extractionFile), 'utf8'));
            const comparedFields = checkResult(report, expected);
            results.push({ id: sample.id, passed: true, comparedFields, sourcePdfs: report.sourcePdfs, pdfCount: report.pdfCount,
                review: report.issues.length > 0, issueFields: report.issues.map(issue => issue.field), elapsedMs: Date.now() - started });
        } catch (error) {
            results.push({ id: sample.id, passed: false, error: error.message, elapsedMs: Date.now() - started });
        }
        console.log(JSON.stringify(results.at(-1)));
    }
    const summary = { checkedAt: new Date().toISOString(), samples: results.length, passed: results.filter(row => row.passed).length,
        comparedFields: results.reduce((count, row) => count + (row.comparedFields || 0), 0), results };
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
}

module.exports = { checkResult, validateManifest, runSuite };
if (require.main === module) {
    const { values } = parseArgs({ options: { manifest: { type: 'string' }, output: { type: 'string' } } });
    if (!values.manifest || !values.output) throw new Error('Use --manifest local-cases.json --output private-report-directory');
    const result = runSuite(values.manifest, values.output);
    if (result.passed !== result.samples) process.exitCode = 1;
}
