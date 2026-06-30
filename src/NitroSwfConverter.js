#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const nitroDir = path.join(root, 'nitro');
const swfDir = path.join(root, 'swf');
const downloadsDir = path.join(root, 'downloads');
const localAirDir = path.join(root, 'air-sdk');
const converter = path.join(root, 'src', 'convert-nitro.js');
const defaultAirHome = process.argv[2] || 'C:\\harman-air\\AIRSDK_51.3.1';
const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    'Accept': 'application/json,text/plain,application/octet-stream,*/*',
    'Accept-Language': 'en-US,en;q=0.9'
};

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function isUrl(value) {
    return /^https?:\/\//i.test(value);
}

function normalizeUrl(value) {
    if (value && value.startsWith('//')) return `https:${value}`;
    return value;
}

function question(rl, prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

function title() {
    console.clear();
    console.log('');
    console.log('Nitro -> SWF Converter');
    console.log('======================');
    console.log('');
}

function findAirHome(basePath) {
    if (!basePath || !basePath.trim()) return null;

    const resolved = path.resolve(basePath.trim());
    const direct = path.join(resolved, 'bin', 'mxmlc.bat');
    if (fs.existsSync(direct)) return resolved;
    if (!fs.existsSync(resolved)) return null;

    const stack = [resolved];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile() && entry.name.toLowerCase() === 'mxmlc.bat' && path.basename(path.dirname(fullPath)).toLowerCase() === 'bin') {
                return path.dirname(path.dirname(fullPath));
            }
        }
    }

    return null;
}

function downloadFile(url, outputFile) {
    ensureDir(path.dirname(outputFile));
    const normalizedUrl = normalizeUrl(url);
    const client = normalizedUrl.startsWith('https:') ? https : http;

    return new Promise((resolve, reject) => {
        const request = client.get(normalizedUrl, { headers: requestHeaders }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                downloadFile(new URL(response.headers.location, normalizedUrl).toString(), outputFile).then(resolve, reject);
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Download failed with HTTP ${response.statusCode}`));
                return;
            }

            const file = fs.createWriteStream(outputFile);
            response.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        });

        request.on('error', reject);
    });
}

function readTextSource(source) {
    const value = normalizeUrl(source.trim());

    if (isUrl(value)) {
        const client = value.startsWith('https:') ? https : http;

        return new Promise((resolve, reject) => {
            const request = client.get(value, { headers: requestHeaders }, response => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    readTextSource(new URL(response.headers.location, value).toString()).then(resolve, reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`Furnidata download failed with HTTP ${response.statusCode}`));
                    return;
                }

                response.setEncoding('utf8');
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => resolve(data));
            });

            request.on('error', reject);
        });
    }

    return Promise.resolve(fs.readFileSync(path.resolve(value), 'utf8'));
}

function extractZip(zipFile, outputDir) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    ensureDir(outputDir);

    const result = cp.spawnSync('tar.exe', ['-xf', zipFile, '-C', outputDir], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Failed to extract AIR SDK zip with tar.exe (exit ${result.status}).`);
}

async function resolveAirInput(inputValue) {
    const value = inputValue && inputValue.trim() ? inputValue.trim() : defaultAirHome;

    if (isUrl(value)) {
        ensureDir(downloadsDir);
        const zipPath = path.join(downloadsDir, 'air-sdk.zip');
        console.log('');
        console.log('Downloading AIR SDK...');
        await downloadFile(value, zipPath);

        console.log('Extracting AIR SDK...');
        extractZip(zipPath, localAirDir);

        const airHome = findAirHome(localAirDir);
        if (!airHome) throw new Error('Could not find bin\\mxmlc.bat after extracting AIR SDK from URL.');
        return airHome;
    }

    const airHome = findAirHome(value);
    if (!airHome) throw new Error(`Could not find bin\\mxmlc.bat under: ${value}`);
    return airHome;
}

function listNitroFiles() {
    ensureDir(nitroDir);
    return fs.readdirSync(nitroDir)
        .filter(name => name.toLowerCase().endsWith('.nitro'))
        .sort((a, b) => a.localeCompare(b));
}

function parseFurnitureData(content) {
    const data = JSON.parse(content);
    const asArray = value => {
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
    };
    const roomItems = asArray(data.roomitemtypes && data.roomitemtypes.furnitype);
    const wallItems = asArray(data.wallitemtypes && data.wallitemtypes.furnitype);
    const entries = new Map();

    for (const item of roomItems.concat(wallItems)) {
        if (!item || !item.classname) continue;

        const className = String(item.classname).split('*')[0].trim();
        if (!className) continue;

        entries.set(className, {
            className,
            revision: item.revision === undefined || item.revision === null ? '-1' : String(item.revision)
        });
    }

    return Array.from(entries.values()).sort((a, b) => a.className.localeCompare(b.className));
}

function buildNitroUrl(template, entry) {
    let url = template.trim();

    if (!url) throw new Error('Nitro URL template is required.');
    if (!/%className%|%revision%/i.test(url)) {
        const separator = url.endsWith('/') ? '' : '/';
        url = `${url}${separator}%className%.nitro`;
    }

    return normalizeUrl(url)
        .replace(/%className%/gi, encodeURIComponent(entry.className))
        .replace(/%revision%/gi, encodeURIComponent(entry.revision));
}

async function downloadFurnitureNitro(furnidataSource, nitroUrlTemplate) {
    console.log('');
    console.log('Loading furnidata...');

    const content = await readTextSource(furnidataSource);
    const entries = parseFurnitureData(content);

    if (!entries.length) throw new Error('No furniture class names found in furnidata.');

    ensureDir(nitroDir);

    console.log(`Found ${entries.length} furniture asset(s).`);
    console.log('');

    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const outputFile = path.join(nitroDir, `${entry.className}.nitro`);

        if (fs.existsSync(outputFile)) {
            skipped++;
            console.log(`[${i + 1}/${entries.length}] Skipped ${entry.className} (already exists)`);
            continue;
        }

        const url = buildNitroUrl(nitroUrlTemplate, entry);

        try {
            console.log(`[${i + 1}/${entries.length}] Downloading ${entry.className}`);
            await downloadFile(url, outputFile);
            downloaded++;
        } catch (error) {
            if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
            failed++;
            console.error(`  Failed: ${error.message}`);
        }
    }

    console.log('');
    console.log(`Download complete. Downloaded ${downloaded}, skipped ${skipped}, failed ${failed}.`);

    return { downloaded, skipped, failed, total: entries.length };
}

function runConverter(airHome, uncompressed) {
    const args = [converter, '--air-home', airHome];
    if (uncompressed) args.push('--uncompressed');
    args.push(nitroDir, swfDir);

    const result = cp.spawnSync(process.execPath, args, {
        cwd: root,
        stdio: 'inherit'
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Converter exited with code ${result.status}.`);
}

async function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
        title();
        ensureDir(nitroDir);
        ensureDir(swfDir);

        console.log('Drop .nitro files here:');
        console.log(`  ${nitroDir}`);
        console.log('');
        console.log('Converted .swf files go here:');
        console.log(`  ${swfDir}`);
        console.log('');

        console.log('Mode:');
        console.log('  1. Convert existing .nitro files');
        console.log('  2. Download furniture from furnidata.json, then convert');
        console.log('');

        const modeInput = await question(rl, 'Choose mode [1]: ');
        const mode = modeInput.trim() || '1';

        if (mode === '2') {
            const furnidataSource = await question(rl, 'Furnidata JSON URL or path: ');
            if (!furnidataSource.trim()) throw new Error('Furnidata JSON URL or path is required.');

            console.log('');
            console.log('Nitro URL can be a base folder or a template.');
            console.log('Template tokens: %className%, %revision%');
            const nitroUrlTemplate = await question(rl, 'Nitro furniture URL/base: ');
            if (!nitroUrlTemplate.trim()) throw new Error('Nitro furniture URL/base is required.');

            const startDownload = await question(rl, 'Start furniture download now? [Y/N]: ');
            if (!/^(y|yes)$/i.test(startDownload.trim())) {
                console.log('Cancelled.');
                return;
            }

            await downloadFurnitureNitro(furnidataSource, nitroUrlTemplate);
        } else if (mode !== '1') {
            throw new Error(`Unknown mode: ${mode}`);
        }

        const airInput = await question(rl, `AIR SDK path or download URL [${defaultAirHome}]: `);
        const airHome = await resolveAirInput(airInput);
        const nitroFiles = listNitroFiles();

        console.log('');
        console.log('AIR SDK:');
        console.log(`  ${airHome}`);
        console.log('');
        console.log(`Found ${nitroFiles.length} .nitro file(s).`);

        if (!nitroFiles.length) {
            console.log('Put .nitro files into the nitro folder, then launch this again.');
            return;
        }

        for (const file of nitroFiles) console.log(`  - ${file}`);

        console.log('');
        console.log('Output format:');
        console.log('  1. Compressed (CWS / zlib) - smaller, opens in RetroSprite & Flash tools');
        console.log('  2. Uncompressed (FWS) - largest, maximum tool compatibility');
        console.log('');
        const compressionInput = await question(rl, 'Choose output format [1]: ');
        const uncompressed = compressionInput.trim() === '2';

        console.log('');
        const start = await question(rl, 'Start dump now? [Y/N]: ');
        if (!/^(y|yes)$/i.test(start.trim())) {
            console.log('Cancelled.');
            return;
        }

        console.log('');
        console.log('Starting conversion...');
        runConverter(airHome, uncompressed);

        console.log('');
        console.log('Done. SWFs are in:');
        console.log(`  ${swfDir}`);
    } finally {
        rl.close();
    }
}

main().catch(error => {
    console.log('');
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
});
