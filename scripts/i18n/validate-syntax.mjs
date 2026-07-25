#!/usr/bin/env node
// Post-translation syntax validator.
// Runs `node --check` on each translated chunk and scans for unsafe apostrophes
// inside single-quoted JS string literals.
//
// Usage:
//   node scripts/i18n/validate-syntax.mjs [--strict]

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHUNKS_DIR = join(__dirname, 'chunks');
const OUT_DIR = join(__dirname, 'out');

const STRICT = process.argv.includes('--strict');

const APOSTROPHE_CONTRACTIONS = /\b(don't|can't|won't|isn't|doesn't|it's|'s |n't)\b/i;

// Strip the 3-line chunker header so the body parses as standalone JS.
// Header = "// CHUNK...", "// DO NOT...", blank line.
function stripHeader(body) {
    const lines = body.split('\n');
    if (lines.length >= 3 && lines[0].startsWith('// CHUNK') && lines[1].startsWith('// DO NOT') && lines[2].trim() === '') {
        return lines.slice(3).join('\n');
    }
    // Fallback: header may be missing (already-stripped file), return as-is.
    return body;
}

// Write body to a tmp .mjs file, run `node --check`, return { code, stderr }.
function nodeCheck(stripped, label) {
    const tmpPath = join(tmpdir(), `askpage-validate-${label}-${process.pid}.mjs`);
    writeFileSync(tmpPath, stripped, 'utf8');
    try {
        const res = spawnSync(process.execPath, ['--check', tmpPath], { encoding: 'utf8' });
        return { code: res.status ?? 1, stderr: res.stderr || '' };
    } finally {
        try { unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
    }
}

// Find single-quoted string literals per line, then flag those containing
// an apostrophe that would break the string. Heuristic (no deps) — may
// false-positive; callers report findings as warnings unless --strict.
function scanApostrophes(stripped) {
    const findings = [];
    const lines = stripped.split('\n');
    // Matches single-quoted literals: '...', with escaped \' and \\ handled.
    const singleQuoteRe = /'(?:[^'\\]|\\.)*'/g;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comment lines (heuristic).
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        let m;
        singleQuoteRe.lastIndex = 0;
        while ((m = singleQuoteRe.exec(line)) !== null) {
            const literal = m[0];
            const content = literal.slice(1, -1);
            // Known English contractions are the most common culprit.
            if (APOSTROPHE_CONTRACTIONS.test(content)) {
                findings.push({ line: i + 1, text: line.trim(), reason: 'contraction in single-quoted string' });
                break;
            }
            // An unescaped apostrophe inside the content (between the outer quotes)
            // would have terminated the literal, so a real apostrophe surviving the
            // regex means it was escaped (\'). We additionally flag a bare apostrophe
            // that appears mid-content as suspicious.
            if (/^[^']*'[^']/.test(content)) {
                findings.push({ line: i + 1, text: line.trim(), reason: 'unescaped apostrophe in single-quoted string' });
                break;
            }
        }
    }
    return findings;
}

function globChunks() {
    if (!existsSync(CHUNKS_DIR)) return [];
    return readdirSync(CHUNKS_DIR)
        .filter((f) => f.endsWith('.en.mjs'))
        .sort()
        .map((f) => join(CHUNKS_DIR, f));
}

function globOutFiles() {
    if (!existsSync(OUT_DIR)) return [];
    return readdirSync(OUT_DIR)
        .filter((f) => /\.en\.(js|mjs)$/.test(f))
        .sort()
        .map((f) => join(OUT_DIR, f));
}

function reportApostropheFindings(findings, label) {
    if (findings.length === 0) return false;
    const level = STRICT ? 'ERROR' : 'WARN';
    console.error(`\n[${level}] ${label}: ${findings.length} apostrophe finding(s) in single-quoted strings:`);
    for (const f of findings) {
        console.error(`  L${f.line} (${f.reason}): ${f.text.slice(0, 120)}`);
    }
    return true;
}

function main() {
    const chunks = globChunks();
    const outFiles = globOutFiles();

    if (chunks.length === 0 && outFiles.length === 0) {
        console.log('No translated chunks or out/ files found — run translate.mjs first');
        return 0;
    }

    let failures = 0;
    let apostropheHits = 0;

    console.log(`Validating ${chunks.length} translated chunk(s)${STRICT ? ' [strict]' : ''}...`);
    for (const file of chunks) {
        const label = basename(file);
        const raw = readFileSync(file, 'utf8');
        const stripped = stripHeader(raw);

        const check = nodeCheck(stripped, label.replace(/[^\w.-]/g, '_'));
        if (check.code !== 0) {
            failures++;
            console.error(`\n[FAIL] ${label}: node --check exited ${check.code}`);
            const excerpt = (check.stderr || '').split('\n').slice(0, 8).join('\n');
            console.error(excerpt);
            continue;
        }

        const findings = scanApostrophes(stripped);
        if (reportApostropheFindings(findings, label)) {
            apostropheHits++;
            if (STRICT) failures++;
        }
        console.log(`  ok   ${label}`);
    }

    // Also validate small-file outputs in out/ (only .js/.mjs).
    const outFiles = globOutFiles();
    for (const file of outFiles) {
        const label = basename(file);
        const raw = readFileSync(file, 'utf8');
        const stripped = stripHeader(raw);
        const check = nodeCheck(stripped, label.replace(/[^\w.-]/g, '_'));
        if (check.code !== 0) {
            failures++;
            console.error(`\n[FAIL] out/${label}: node --check exited ${check.code}`);
            const excerpt = (check.stderr || '').split('\n').slice(0, 8).join('\n');
            console.error(excerpt);
            continue;
        }
        const findings = scanApostrophes(stripped);
        if (reportApostropheFindings(findings, `out/${label}`)) {
            apostropheHits++;
            if (STRICT) failures++;
        }
        console.log(`  ok   out/${label}`);
    }

    console.log('');
    if (failures > 0) {
        console.error(`[result] ${failures} chunk(s)/file(s) failed${STRICT ? ' (apostrophe findings counted as errors)' : ''}`);
        process.exit(1);
    }
    if (apostropheHits > 0) {
        console.log(`[result] all syntax OK; ${apostropheHits} apostrophe warning(s) (re-run with --strict to fail)`);
    } else {
        console.log('[result] all syntax OK; no apostrophe findings');
    }
    process.exit(0);
}

main();