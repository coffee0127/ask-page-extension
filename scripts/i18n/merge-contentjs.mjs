#!/usr/bin/env node
// Merge translated content.js chunks back into a single content.js.
// Usage: node scripts/i18n/merge-contentjs.mjs
// Reads:  scripts/i18n/chunks/chunk-map.json
//         scripts/i18n/chunks/content.js.chunk-N.en.mjs (translated)
// Writes: content.js (overwritten after backing up original to content.js.zh-TW.bak)

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CHUNKS_DIR = join(__dirname, 'chunks');
const MAP = join(CHUNKS_DIR, 'chunk-map.json');
const DEST = join(REPO_ROOT, 'content.js');
const BACKUP = join(REPO_ROOT, 'content.js.zh-TW.bak');

function stripHeader(text) {
    // Chunker writes exactly: header line 1, header line 2, blank line, <body>, '\n'.
    // readFileSync + split produces an array whose final element is '' due to the file's
    // trailing newline. Remove that single trailing '' (NOT legitimate blank lines inside
    // the body), then drop the 3 header lines.
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(3).join('\n');
}

function main() {
    if (!existsSync(MAP)) { throw new Error(`Missing ${MAP}. Run chunk-contentjs.mjs first.`); }
    const map = JSON.parse(readFileSync(MAP, 'utf8'));

    // Concatenate translated chunk bodies in order. The chunker guarantees contiguous,
    // non-overlapping line ranges, so concatenation reassembles the file exactly.
    const parts = [];
    for (const c of map.chunks) {
        const inFile = join(CHUNKS_DIR, c.file.replace('.mjs', '.en.mjs'));
        if (!existsSync(inFile)) {
            throw new Error(`Missing translated chunk: ${inFile}. Run translate.mjs first.`);
        }
        const raw = readFileSync(inFile, 'utf8');
        const body = stripHeader(raw);
        parts.push(body);
        console.log(`  chunk ${c.chunkIndex}: ${body.split(/\r?\n/).length} lines (expected ${c.endLine - c.startLine + 1})`);
    }
    const merged = parts.join('\n');

    // Backup original then write merged content.
    if (!existsSync(BACKUP)) {
        copyFileSync(DEST, BACKUP);
        console.log(`Backed up original content.js -> ${BACKUP}`);
    } else {
        console.log(`Backup already exists: ${BACKUP} (not overwriting)`);
    }
    writeFileSync(DEST, merged);
    console.log(`Merged ${map.chunks.length} translated chunks -> content.js`);
    console.log('Next: run "npm run lint" and load the extension in Chrome to verify.');
}

main();