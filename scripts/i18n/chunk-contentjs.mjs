#!/usr/bin/env node
// Chunk content.js into ~50K-token blocks split at top-level AST node boundaries.
// Usage: node scripts/i18n/chunk-contentjs.mjs
// Reads:  content.js (repo root)
// Writes: scripts/i18n/chunks/content.js.chunk-{1..N}.mjs
//         scripts/i18n/chunks/chunk-map.json
//
// Safety: boundaries are top-level AST node start lines (functions, class,
// const/let/var declarations, etc.), so no chunk splits a function body or a
// template literal. Every chunk is validated with `node --check`.
//
// Uses acorn (provided transitively by the ESLint devDependency) for parsing.
// Acorn is a pure-JS parser with no native deps; if it is unavailable, the
// script exits with a clear message rather than falling back to an unsafe
// heuristic.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

let acorn;
try {
    acorn = require('acorn');
} catch (e) {
    console.error('[chunk-contentjs] acorn is required (provided by the eslint devDependency).');
    console.error('  Run `npm install` first, then re-run this script.');
    process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SRC = join(REPO_ROOT, 'content.js');
const OUT_DIR = join(__dirname, 'chunks');

const TARGET_TOKENS = 48000;
const HARD_MAX_TOKENS = 60000;

function estimateTokens(text) {
    // Mixed zh/en/code ≈ 3 chars per token (conservative).
    return Math.ceil(text.length / 3);
}

function readLines(path) {
    const src = readFileSync(path, 'utf8');
    return src.split(/\r?\n/);
}

function sliceLines(lines, startLine, endLine) {
    // 1-based inclusive [startLine, endLine]
    return lines.slice(startLine - 1, endLine).join('\n');
}

// Parse content.js and collect top-level node start lines (1-based).
// A top-level node is any entry in ast.body; splitting between two top-level
// nodes never breaks a function body or a template literal.
function topLevelBoundaries(source) {
    const ast = acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true
    });
    return ast.body.map((node) => node.loc.start.line);
}

function buildChunks(lines, boundaries, source) {
    const totalLines = lines.length;
    // Safe split points: after line L when line L+1 begins a top-level node.
    const splitAfter = new Set();
    for (const start of boundaries) {
        if (start > 1 && start <= totalLines) splitAfter.add(start - 1);
    }
    splitAfter.add(totalLines); // EOF is always safe.

    // Warn about any single top-level node larger than HARD_MAX: it cannot be
    // split at a syntactically-safe boundary without producing un-parseable
    // fragments (splitting inside a function leaves unmatched braces). The
    // chunker keeps the node intact so every chunk still passes node --check;
    // the oversized chunk is reported but not broken.
    const ast = acorn.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        locations: true
    });
    for (const node of ast.body) {
        const nodeText = sliceLines(lines, node.loc.start.line, node.loc.end.line);
        const tokens = estimateTokens(nodeText);
        if (tokens > HARD_MAX_TOKENS) {
            console.warn(`  ⚠️  top-level ${node.type} lines ${node.loc.start.line}-${node.loc.end.line} (~${tokens} tokens) exceeds HARD_MAX (${HARD_MAX_TOKENS}); kept intact (splitting a function body produces un-parseable chunks).`);
        }
    }

    const chunks = [];
    let cursor = 1;

    while (cursor <= totalLines) {
        // Accumulate until TARGET_TOKENS, then find nearest safe boundary at/after target.
        let end = cursor;
        let acc = 0;
        while (end < totalLines && acc < TARGET_TOKENS) {
            acc += estimateTokens(lines[end - 1]) + 1;
            end++;
        }
        if (acc < TARGET_TOKENS) end = totalLines;

        // Advance end to the nearest safe boundary at/after end (but not beyond totalLines).
        let safeEnd = -1;
        for (let b = end; b <= totalLines; b++) {
            if (splitAfter.has(b)) { safeEnd = b; break; }
        }
        if (safeEnd === -1) {
            // No safe boundary at/after target: scan backwards.
            for (let b = end - 1; b > cursor; b--) {
                if (splitAfter.has(b)) { safeEnd = b; break; }
            }
        }
        if (safeEnd === -1) {
            // Only one top-level node in range; force a split to make progress.
            safeEnd = Math.min(end, totalLines);
        }

        // Enforce hard max: if the chosen safeEnd exceeds HARD_MAX tokens, walk
        // backwards to the nearest safe boundary within the hard max.
        const segText = sliceLines(lines, cursor, safeEnd);
        if (estimateTokens(segText) > HARD_MAX_TOKENS) {
            for (let b = safeEnd; b > cursor; b--) {
                if (splitAfter.has(b)) {
                    const candidate = sliceLines(lines, cursor, b);
                    if (estimateTokens(candidate) <= HARD_MAX_TOKENS) {
                        safeEnd = b;
                        break;
                    }
                }
            }
        }

        const text = sliceLines(lines, cursor, safeEnd);
        const tokens = estimateTokens(text);
        chunks.push({
            index: chunks.length + 1,
            startLine: cursor,
            endLine: safeEnd,
            tokens,
            text
        });
        cursor = safeEnd + 1;
        if (cursor > totalLines) break;
    }

    return chunks;
}

// Run `node --check` on a chunk body. Returns { ok, stderr }.
function nodeCheck(text, label) {
    const tmpPath = join(OUT_DIR, `__check-${label}.mjs`);
    writeFileSync(tmpPath, text, 'utf8');
    try {
        const res = spawnSync(process.execPath, ['--check', tmpPath], { encoding: 'utf8' });
        return { ok: (res.status ?? 1) === 0, stderr: res.stderr || '' };
    } finally {
        try { unlinkSync(tmpPath); } catch (_) { /* best-effort */ }
    }
}

function anchorFor(lines, startLine) {
    const DECL_RE = /(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=/;
    const isBlankOrComment = (ln) => /^\s*$/.test(ln) || /^\s*\/\//.test(ln) || /^\s*\/\*/.test(ln);
    let anchor = '';
    for (let off = 0; off < 5 && startLine - 1 + off < lines.length; off++) {
        const ln = lines[startLine - 1 + off];
        const m = ln.match(DECL_RE);
        if (m) { anchor = m[1] || m[2]; break; }
        if (!isBlankOrComment(ln)) break;
    }
    if (!anchor) anchor = startLine === 1 ? '(file start)' : '(top-level node)';
    return anchor;
}

function main() {
    mkdirSync(OUT_DIR, { recursive: true });
    const lines = readLines(SRC);
    const source = lines.join('\n');
    console.log(`content.js: ${lines.length} lines, ~${estimateTokens(source)} tokens`);

    const boundaries = topLevelBoundaries(source);
    console.log(`Top-level AST nodes: ${boundaries.length}`);

    const chunks = buildChunks(lines, boundaries, source);

    const map = [];
    let syntaxFailures = 0;
    chunks.forEach((c) => {
        const anchor = anchorFor(lines, c.startLine);
        const outFile = join(OUT_DIR, `content.js.chunk-${c.index}.mjs`);
        const header = `// CHUNK ${c.index} of ${chunks.length} (content.js lines ${c.startLine}-${c.endLine}, ~${c.tokens} tokens, anchor: ${anchor})\n// DO NOT translate code comments or structure. Translate only zh-TW UI strings per glossary.\n\n`;
        writeFileSync(outFile, header + c.text + '\n');

        const check = nodeCheck(c.text, `chunk-${c.index}`);
        if (!check.ok) {
            syntaxFailures++;
            console.error(`  ✗ chunk ${c.index}: node --check FAILED`);
            console.error(check.stderr.split('\n').slice(0, 8).join('\n'));
        }

        map.push({
            chunkIndex: c.index,
            startLine: c.startLine,
            endLine: c.endLine,
            tokenEstimate: c.tokens,
            anchorFunction: anchor,
            file: `content.js.chunk-${c.index}.mjs`
        });
        console.log(`  chunk ${c.index}: lines ${c.startLine}-${c.endLine} (~${c.tokens} tokens, anchor: ${anchor})`);
    });

    // Authoritative safety gate: reconstruction must equal the original file body.
    const reconstructed = chunks.map((c) => c.text).join('\n');
    if (reconstructed !== source) {
        const tmpRecon = join(OUT_DIR, '__reconstructed_check.txt');
        writeFileSync(tmpRecon, reconstructed);
        throw new Error(`Reconstruction mismatch! Wrote ${tmpRecon} for diff against content.js. Chunk boundaries are unsafe.`);
    }

    if (syntaxFailures > 0) {
        console.error(`\n${syntaxFailures} chunk(s) failed node --check — chunk boundaries are unsafe.`);
        process.exit(1);
    }

    writeFileSync(join(OUT_DIR, 'chunk-map.json'), JSON.stringify({ source: 'content.js', totalLines: lines.length, chunks: map }, null, 2) + '\n');
    console.log(`\nWrote ${chunks.length} chunks + chunk-map.json to ${OUT_DIR}`);
    console.log('Reconstruction check: PASSED (chunks reassemble to original content.js)');
    console.log('Syntax check: PASSED (every chunk parses as standalone JS)');
}

main();