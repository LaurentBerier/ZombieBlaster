/**
 * Batch-compress all .glb files under assets/ with Draco mesh compression.
 * Run from repo root: npm run compress-assets
 *
 * Replaces each file in place (writes via a .tmp sibling, then renames).
 * Requires: npm install (devDependencies).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'assets');
const cli = path.join(root, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');

if (!fs.existsSync(cli)) {
    console.error('Missing @gltf-transform/cli. Run: npm install');
    process.exit(1);
}

function* walkGlbs(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) yield* walkGlbs(full);
        else if (ent.name.toLowerCase().endsWith('.glb')) yield full;
    }
}

function mb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(2);
}

let totalBefore = 0;
let totalAfter = 0;
let ok = 0;
let fail = 0;

for (const input of walkGlbs(assetsDir)) {
    const before = fs.statSync(input).size;
    const resized = `${input}.resize.tmp.glb`;
    const tmp = `${input}.draco.tmp.glb`;
    const rel = path.relative(root, input);

    // Shrink oversized embedded textures first — most GLB weight is textures.
    // Small / already-optimized assets (weapons) skip resize — it can re-encode
    // them larger.
    const skipResize = rel.replace(/\\/g, '/').includes('assets/Weapons/');
    const dracoInput = skipResize ? input : resized;

    if (!skipResize) {
        const resizeResult = spawnSync(
            process.execPath,
            [cli, 'resize', input, resized, '--width', '2048', '--height', '2048'],
            { cwd: root, stdio: 'pipe', encoding: 'utf-8' },
        );
        if (resizeResult.status !== 0) {
            console.error(`FAIL resize ${rel}`);
            if (resizeResult.stderr) console.error(resizeResult.stderr.trim());
            if (fs.existsSync(resized)) fs.unlinkSync(resized);
            fail++;
            continue;
        }
    }

    const result = spawnSync(
        process.execPath,
        [cli, 'draco', dracoInput, tmp, '--method', 'edgebreaker'],
        { cwd: root, stdio: 'pipe', encoding: 'utf-8' },
    );
    if (fs.existsSync(resized)) fs.unlinkSync(resized);

    if (result.status !== 0) {
        console.error(`FAIL draco ${rel}`);
        if (result.stderr) console.error(result.stderr.trim());
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        fail++;
        continue;
    }

    const after = fs.statSync(tmp).size;
    fs.renameSync(tmp, input);
    totalBefore += before;
    totalAfter += after;
    ok++;
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    console.log(`${rel}: ${mb(before)} MB -> ${mb(after)} MB (${pct}% smaller)`);
}

console.log('');
console.log(`Done: ${ok} compressed, ${fail} failed`);
console.log(`Total: ${mb(totalBefore)} MB -> ${mb(totalAfter)} MB`);
