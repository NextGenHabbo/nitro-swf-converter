#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const cp = require('child_process');

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
})();

function usage() {
    console.log('Usage:');
    console.log('  convert-nitro.js --air-home C:\\harman-air\\AIRSDK_51.3.1 input.nitro [output.swf]');
    console.log('  convert-nitro.js --air-home C:\\harman-air\\AIRSDK_51.3.1 input-folder output-folder');
}

function parseArgs(argv) {
    const args = argv.slice(2);
    let airHome = process.env.AIR_HOME || 'C:\\harman-air\\AIRSDK_51.3.1';
    let renameMap = null;
    let uncompressed = false;
    const rest = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--air-home') {
            airHome = args[++i];
        } else if (args[i] === '--rename-map') {
            renameMap = args[++i];
        } else if (args[i] === '--uncompressed') {
            uncompressed = true;
        } else {
            rest.push(args[i]);
        }
    }

    if (!rest.length) {
        usage();
        process.exit(1);
    }

    return {
        airHome,
        input: path.resolve(rest[0]),
        output: rest[1] ? path.resolve(rest[1]) : null,
        renameMap,
        uncompressed
    };
}

function loadRenameMap(explicitPath) {
    const file = explicitPath
        ? path.resolve(explicitPath)
        : path.join(path.dirname(__dirname), 'renames.txt');

    const map = new Map();
    const strips = [];
    if (!fs.existsSync(file)) return { map, strips };

    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;

        const eq = line.indexOf('=');
        if (eq === -1) {
            // No '=': treat the whole line as text to strip from every name.
            strips.push(line);
            continue;
        }

        const from = line.slice(0, eq).trim();
        const to = line.slice(eq + 1).trim();
        if (from && to) map.set(from, to);
    }

    const ruleCount = map.size + strips.length;
    if (ruleCount) console.log(`Loaded ${map.size} rename rule(s) and ${strips.length} strip rule(s) from ${file}`);
    return { map, strips };
}

function renameInValue(value, from, to) {
    if (typeof value === 'string') return value.split(from).join(to);
    if (Array.isArray(value)) return value.map(item => renameInValue(item, from, to));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) {
            out[key.split(from).join(to)] = renameInValue(child, from, to);
        }
        return out;
    }
    return value;
}

function resolveNewName(rename, originalName, fileBaseName) {
    const { map, strips } = rename;

    // Explicit old=new rules win.
    if (map.has(originalName)) return map.get(originalName);
    if (map.has(fileBaseName)) return map.get(fileBaseName);

    // Otherwise apply all strip tokens to the name (case-insensitive).
    let name = originalName;
    for (const token of strips) {
        const pattern = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        name = name.replace(pattern, '');
    }
    return name || originalName;
}

function readI16BE(buffer, offset) {
    return buffer.readInt16BE(offset);
}

function readI32BE(buffer, offset) {
    return buffer.readInt32BE(offset);
}

function decompressNitroEntry(data, name) {
    try {
        return zlib.inflateSync(data);
    } catch (inflateError) {
        try {
            return zlib.gunzipSync(data);
        } catch {
            throw new Error(`Could not decompress ${name}: ${inflateError.message}`);
        }
    }
}

function unpackNitro(file) {
    const buffer = fs.readFileSync(file);
    let offset = 0;
    const count = readI16BE(buffer, offset); offset += 2;
    let json = null;
    let png = null;

    for (let i = 0; i < count; i++) {
        const nameLength = readI16BE(buffer, offset); offset += 2;
        const name = buffer.subarray(offset, offset + nameLength).toString('utf8'); offset += nameLength;
        const length = readI32BE(buffer, offset); offset += 4;
        const data = decompressNitroEntry(buffer.subarray(offset, offset + length), name); offset += length;

        if (name.toLowerCase().endsWith('.json')) json = JSON.parse(data.toString('utf8'));
        else if (name.toLowerCase().endsWith('.png')) png = data;
    }

    if (!json) throw new Error(`No JSON file found in ${file}`);
    if (!png) throw new Error(`No PNG atlas found in ${file}`);

    return { json, png };
}

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function safeClassName(value) {
    return String(value).replace(/[^A-Za-z0-9_$]/g, '_').replace(/^[^A-Za-z_$]/, '_$&');
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, content) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, content.replace(/\n/g, os.EOL));
}

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBuffer.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
    return chunk;
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function decodePng(buffer) {
    if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
        throw new Error('Atlas is not a PNG file.');
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat = [];

    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset); offset += 4;
        const type = buffer.subarray(offset, offset + 4).toString('ascii'); offset += 4;
        const data = buffer.subarray(offset, offset + length); offset += length + 4;

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
    }

    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}.`);
    }

    const channels = colorType === 6 ? 4 : 3;
    const bytesPerPixel = channels;
    const stride = width * channels;
    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const raw = Buffer.alloc(width * height * channels);
    let inOffset = 0;
    let outOffset = 0;

    for (let y = 0; y < height; y++) {
        const filter = inflated[inOffset++];
        const rowStart = outOffset;

        for (let x = 0; x < stride; x++) {
            const value = inflated[inOffset++];
            const left = x >= bytesPerPixel ? raw[outOffset - bytesPerPixel] : 0;
            const up = y > 0 ? raw[outOffset - stride] : 0;
            const upLeft = (y > 0 && x >= bytesPerPixel) ? raw[outOffset - stride - bytesPerPixel] : 0;

            switch (filter) {
                case 0:
                    raw[outOffset] = value;
                    break;
                case 1:
                    raw[outOffset] = (value + left) & 0xFF;
                    break;
                case 2:
                    raw[outOffset] = (value + up) & 0xFF;
                    break;
                case 3:
                    raw[outOffset] = (value + Math.floor((left + up) / 2)) & 0xFF;
                    break;
                case 4:
                    raw[outOffset] = (value + paethPredictor(left, up, upLeft)) & 0xFF;
                    break;
                default:
                    throw new Error(`Unsupported PNG filter: ${filter}.`);
            }
            outOffset++;
        }

        if (outOffset - rowStart !== stride) throw new Error('PNG decode row length mismatch.');
    }

    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0, j = 0; i < raw.length; i += channels, j += 4) {
        rgba[j] = raw[i];
        rgba[j + 1] = raw[i + 1];
        rgba[j + 2] = raw[i + 2];
        rgba[j + 3] = channels === 4 ? raw[i + 3] : 0xFF;
    }

    return { width, height, rgba };
}

function encodePng(width, height, rgba) {
    const scanlineLength = 1 + width * 4;
    const raw = Buffer.alloc(scanlineLength * height);

    for (let y = 0; y < height; y++) {
        const row = y * scanlineLength;
        raw[row] = 0;
        rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND')
    ]);
}

function cropAndScale(image, frame, scale) {
    const sourceWidth = Number(frame.w);
    const sourceHeight = Number(frame.h);
    const sourceX = Number(frame.x);
    const sourceY = Number(frame.y);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const out = Buffer.alloc(width * height * 4);

    for (let y = 0; y < height; y++) {
        const sy = sourceY + Math.min(sourceHeight - 1, Math.floor(y / scale));
        for (let x = 0; x < width; x++) {
            const sx = sourceX + Math.min(sourceWidth - 1, Math.floor(x / scale));
            const src = ((sy * image.width) + sx) * 4;
            const dst = ((y * width) + x) * 4;
            image.rgba.copy(out, dst, src, src + 4);
        }
    }

    return { width, height, rgba: out };
}

function xmlHeader() {
    return '<?xml version="1.0" encoding="ISO-8859-1" ?>';
}

function scaledCoordinate(value) {
    const scaled = Number(value || 0) / 2;
    return scaled < 0 ? Math.floor(scaled) : Math.round(scaled);
}

function normalizedAssets(json) {
    const assets = new Map(Object.entries(json.assets || {}).map(([name, asset]) => [name, { ...asset }]));

    for (const [name, asset] of Array.from(assets.entries())) {
        if (!name.includes('_64_')) continue;
        const smallName = name.replace('_64_', '_32_');
        if (assets.has(smallName)) continue;

        const small = { ...asset };
        small.x = scaledCoordinate(asset.x);
        small.y = scaledCoordinate(asset.y);
        if (small.source) small.source = String(small.source).replace('_64_', '_32_');
        assets.set(smallName, small);
    }

    return Array.from(assets.entries()).sort((a, b) => {
        const scaleA = a[0].includes('_32_') ? 0 : a[0].includes('_64_') ? 1 : 2;
        const scaleB = b[0].includes('_32_') ? 0 : b[0].includes('_64_') ? 1 : 2;
        return scaleA === scaleB ? a[0].localeCompare(b[0]) : scaleA - scaleB;
    });
}

function assetXml(json) {
    const lines = [xmlHeader(), '<assets>'];
    const assets = normalizedAssets(json);

    for (const [name, asset] of assets) {
        const attrs = [
            `name="${xmlEscape(name)}"`,
            `x="${asset.x || 0}"`,
            `y="${asset.y || 0}"`
        ];

        if (asset.source) attrs.push(`source="${xmlEscape(asset.source)}"`);
        if (asset.flipH) attrs.push('flipH="1"');
        if (asset.flipV) attrs.push('flipV="1"');

        lines.push(`  <asset ${attrs.join(' ')} />`);
    }

    lines.push('</assets>');
    return lines.join('\n');
}

function logicXml(json) {
    const logic = json.logic || {};
    const model = logic.model || {};
    const dimensions = model.dimensions || {};
    const directions = model.directions || [];
    const lines = [xmlHeader(), `<objectData type="${xmlEscape(json.name)}">`, '  <model>'];

    if (dimensions) {
        lines.push(`    <dimensions x="${dimensions.x || 0}" y="${dimensions.y || 0}" z="${dimensions.z || 0}" />`);
    }

    if (directions.length) {
        lines.push('    <directions>');
        for (const direction of directions) lines.push(`      <direction id="${direction}" />`);
        lines.push('    </directions>');
    }

    lines.push('  </model>');
    lines.push('</objectData>');
    return lines.join('\n');
}

function normalizedVisualizations(json) {
    const visualizations = (json.visualizations || []).map(visualization => ({
        ...visualization,
        layers: visualization.layers || {},
        directions: visualization.directions || {}
    }));
    const has32 = visualizations.some(visualization => Number(visualization.size) === 32);
    const visual64 = visualizations.find(visualization => Number(visualization.size) === 64);
    if (!has32 && visual64) {
        visualizations.push({ ...visual64, size: 32 });
    }

    return visualizations.sort((a, b) => {
        const sizeA = Number(a.size || 0);
        const sizeB = Number(b.size || 0);
        const orderA = sizeA === 32 ? 0 : sizeA === 64 ? 1 : 2;
        const orderB = sizeB === 32 ? 0 : sizeB === 64 ? 1 : 2;
        return orderA === orderB ? sizeA - sizeB : orderA - orderB;
    });
}

function visualizationXml(json) {
    const lines = [xmlHeader(), `<visualizationData type="${xmlEscape(json.name)}"><graphics>`];

    for (const visualization of normalizedVisualizations(json)) {
        const attrs = [
            `size="${visualization.size || 0}"`,
            `layerCount="${visualization.layerCount || 0}"`,
            `angle="${visualization.angle || 0}"`
        ];
        lines.push(`  <visualization ${attrs.join(' ')}>`);

        const layers = visualization.layers || {};
        if (Object.keys(layers).length) {
            lines.push('    <layers>');
            for (const [id, layer] of Object.entries(layers)) {
                const layerAttrs = [`id="${xmlEscape(id)}"`];
                for (const [key, value] of Object.entries(layer)) layerAttrs.push(`${key}="${xmlEscape(value)}"`);
                lines.push(`      <layer ${layerAttrs.join(' ')} />`);
            }
            lines.push('    </layers>');
        }

        const directions = visualization.directions || {};
        if (Object.keys(directions).length) {
            lines.push('    <directions>');
            for (const [id, direction] of Object.entries(directions)) {
                lines.push(`      <direction id="${xmlEscape(id)}">`);
                const dirLayers = direction.layers || {};
                for (const [layerId, layer] of Object.entries(dirLayers)) {
                    const layerAttrs = [`id="${xmlEscape(layerId)}"`];
                    for (const [key, value] of Object.entries(layer)) layerAttrs.push(`${key}="${xmlEscape(value)}"`);
                    lines.push(`        <layer ${layerAttrs.join(' ')} />`);
                }
                lines.push('      </direction>');
            }
            lines.push('    </directions>');
        }

        const colors = visualization.colors || {};
        if (Object.keys(colors).length) {
            lines.push('    <colors>');
            for (const [id, color] of Object.entries(colors)) {
                lines.push(`      <color id="${xmlEscape(id)}">`);
                const colorLayers = (color && color.layers) || {};
                for (const [layerId, layer] of Object.entries(colorLayers)) {
                    const layerAttrs = [`id="${xmlEscape(layerId)}"`];
                    for (const [key, value] of Object.entries(layer)) layerAttrs.push(`${key}="${xmlEscape(value)}"`);
                    lines.push(`        <colorLayer ${layerAttrs.join(' ')} />`);
                }
                lines.push('      </color>');
            }
            lines.push('    </colors>');
        }

        const animations = visualization.animations || {};
        if (Object.keys(animations).length) {
            lines.push('    <animations>');
            for (const [id, animation] of Object.entries(animations)) {
                const animAttrs = [`id="${xmlEscape(id)}"`];
                if (animation && animation.transitionTo !== undefined) animAttrs.push(`transitionTo="${xmlEscape(animation.transitionTo)}"`);
                if (animation && animation.transitionFrom !== undefined) animAttrs.push(`transitionFrom="${xmlEscape(animation.transitionFrom)}"`);
                if (animation && animation.immediateChangeFrom !== undefined) animAttrs.push(`immediateChangeFrom="${xmlEscape(animation.immediateChangeFrom)}"`);
                if (animation && animation.randomStart !== undefined) animAttrs.push(`randomStart="${xmlEscape(animation.randomStart)}"`);
                lines.push(`      <animation ${animAttrs.join(' ')}>`);
                const animLayers = (animation && animation.layers) || {};
                for (const [layerId, layer] of Object.entries(animLayers)) {
                    const layerAttrs = [`id="${xmlEscape(layerId)}"`];
                    for (const [key, value] of Object.entries(layer)) {
                        if (key === 'frameSequences') continue;
                        layerAttrs.push(`${key}="${xmlEscape(value)}"`);
                    }
                    const frameSequences = (layer && layer.frameSequences) || {};
                    if (!Object.keys(frameSequences).length) {
                        lines.push(`        <animationLayer ${layerAttrs.join(' ')} />`);
                        continue;
                    }
                    lines.push(`        <animationLayer ${layerAttrs.join(' ')}>`);
                    for (const [seqId, sequence] of Object.entries(frameSequences)) {
                        const seqAttrs = [`id="${xmlEscape(seqId)}"`];
                        for (const [key, value] of Object.entries(sequence)) {
                            if (key === 'frames') continue;
                            seqAttrs.push(`${key}="${xmlEscape(value)}"`);
                        }
                        const seqFrames = (sequence && sequence.frames) || {};
                        if (!Object.keys(seqFrames).length) {
                            lines.push(`          <frameSequence ${seqAttrs.join(' ')} />`);
                            continue;
                        }
                        lines.push(`          <frameSequence ${seqAttrs.join(' ')}>`);
                        for (const [frameId, frame] of Object.entries(seqFrames)) {
                            const frameAttrs = [];
                            if (frame && typeof frame === 'object') {
                                for (const [key, value] of Object.entries(frame)) frameAttrs.push(`${key}="${xmlEscape(value)}"`);
                            } else {
                                frameAttrs.push(`id="${xmlEscape(frame)}"`);
                            }
                            lines.push(`            <frame ${frameAttrs.join(' ')} />`);
                        }
                        lines.push('          </frameSequence>');
                    }
                    lines.push('        </animationLayer>');
                }
                lines.push('      </animation>');
            }
            lines.push('    </animations>');
        }

        lines.push('  </visualization>');
    }

    lines.push('</graphics></visualizationData>');
    return lines.join('\n');
}

// Figure parts (avatar hair/clothing) carry only image frames + a spritesheet.
// Furni additionally carry visualizations + logic. Detect by their absence so
// the figure path stays scoped and furni output is never touched.
function isFigurePart(json) {
    return !json.visualizations && !json.logic;
}

function manifestXml(json, frames, figurePart) {
    // The Flash avatar/furni renderer reads each asset's registration offset from
    // the MANIFEST (<param key="offset">), NOT from assets.xml. Without it figure
    // parts (hair/clothes) have no placement and render nowhere (bald head / asset
    // on the floor). Pull the offsets from the same source assets.xml uses and
    // emit the param. Additive — genuine Habbo furni/pet swfs carry these too.
    const offsetMap = new Map(normalizedAssets(json));

    const lines = [
        xmlHeader(),
        '<manifest>',
        `   <library name="${xmlEscape(json.name)}" version="0.1">`,
        '      <assets>'
    ];

    // Furni need the index/visualization/assets/logic binaryData; figure parts
    // only register their frame images. Emitting the furni binaries on a figure
    // part is incorrect and bloats the swf.
    if (!figurePart) {
        lines.push('         <asset name="index" mimeType="text/xml"/>');
        lines.push(`         <asset name="${xmlEscape(json.name)}_visualization" mimeType="text/xml"/>`);
        lines.push(`         <asset name="${xmlEscape(json.name)}_assets" mimeType="text/xml"/>`);
        lines.push(`         <asset name="${xmlEscape(json.name)}_logic" mimeType="text/xml"/>`);
    }

    for (const frame of frames) {
        const asset = offsetMap.get(frame.name);
        const x = asset ? (asset.x || 0) : 0;
        const y = asset ? (asset.y || 0) : 0;
        lines.push(`         <asset name="${xmlEscape(frame.name)}" mimeType="image/png">`);
        lines.push(`            <param key="offset" value="${x},${y}"/>`);
        lines.push('         </asset>');
    }

    lines.push('      </assets>');
    lines.push('   </library>');
    lines.push('</manifest>');
    return lines.join('\n');
}

function indexXml(json) {
    return [
        xmlHeader(),
        `<object type="${xmlEscape(json.name)}" visualization="${xmlEscape(json.visualizationType || '')}" logic="${xmlEscape(json.logicType || '')}"/>`
    ].join('\n');
}

function framesForExport(json) {
    const frames = json.spritesheet && json.spritesheet.frames ? json.spritesheet.frames : {};
    const exports = new Map();

    for (const [fullFrameName, frameData] of Object.entries(frames)) {
        let assetName = fullFrameName.startsWith(`${json.name}_`) ? fullFrameName.slice(json.name.length + 1) : fullFrameName;
        assetName = assetName.replace(/\.png$/i, '');
        exports.set(assetName, {
            name: assetName,
            sourceFrame: fullFrameName,
            frame: frameData.frame,
            scale: 1
        });
    }

    for (const assetName of Array.from(exports.keys())) {
        const match = assetName.match(/^(.*)_64_(.*)$/);
        if (!match) continue;
        const smallName = `${match[1]}_32_${match[2]}`;
        if (!exports.has(smallName)) {
            const base = exports.get(assetName);
            exports.set(smallName, {
                name: smallName,
                sourceFrame: base.sourceFrame,
                frame: base.frame,
                scale: 0.5
            });
        }
    }

    return Array.from(exports.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function runNodeCrop(atlasFile, frameFile, outputDir) {
    const atlas = decodePng(fs.readFileSync(atlasFile));
    const frames = JSON.parse(fs.readFileSync(frameFile, 'utf8'));

    for (const item of frames) {
        const bitmap = cropAndScale(atlas, item.frame, Number(item.scale || 1));
        fs.writeFileSync(path.join(outputDir, `${item.name}.png`), encodePng(bitmap.width, bitmap.height, bitmap.rgba));
    }
}

function writeAsProject(workDir, json, png) {
    const name = safeClassName(json.name);
    const srcDir = path.join(workDir, 'src');
    const dataDir = path.join(workDir, 'data');
    ensureDir(srcDir);
    ensureDir(dataDir);

    const atlasFile = path.join(dataDir, `${name}.png`);
    fs.writeFileSync(atlasFile, png);

    const frames = framesForExport(json);
    const figurePart = isFigurePart(json);

    const binaries = [
        { className: `${name}_manifest`, file: `${name}_manifest.bin`, data: manifestXml(json, frames, figurePart), rootProperty: 'manifest', kind: 'const' }
    ];

    // Furni need index/visualization/assets/logic binaryData; figure parts do not.
    if (!figurePart) {
        binaries.push(
            { className: `${name}_index`, file: `${name}_index.bin`, data: indexXml(json), rootProperty: 'index', kind: 'const' },
            { className: `${name}_${name}_assets`, file: `${name}_assets.bin`, data: assetXml(json), rootProperty: `${name}_assets`, kind: 'const' },
            { className: `${name}_${name}_logic`, file: `${name}_logic.bin`, data: logicXml(json), rootProperty: `${name}_logic`, kind: 'const' },
            { className: `${name}_${name}_visualization`, file: `${name}_visualization.bin`, data: visualizationXml(json), rootProperty: `${name}_visualization`, kind: 'const' }
        );
    }

    for (const binary of binaries) {
        fs.writeFileSync(path.join(dataDir, binary.file), Buffer.from(binary.data, 'utf8'));
        writeText(path.join(srcDir, `${binary.className}.as`), `package
{
    import mx.core.ByteArrayAsset;

    [Embed(source="../data/${binary.file}", mimeType="application/octet-stream")]
    public class ${binary.className} extends ByteArrayAsset
    {
    }
}
`);
    }

    const framesFile = path.join(dataDir, 'frames.json');
    fs.writeFileSync(framesFile, JSON.stringify(frames, null, 2));
    runNodeCrop(atlasFile, framesFile, dataDir);

    for (const frame of frames) {
        const className = `${name}_${safeClassName(frame.name)}`;
        writeText(path.join(srcDir, `${className}.as`), `package
{
    import mx.core.BitmapAsset;

    [Embed(source="../data/${frame.name}.png", mimeType="image/png")]
    public class ${className} extends BitmapAsset
    {
    }
}
`);
    }

    const rootLines = [];
    rootLines.push('package');
    rootLines.push('{');
    rootLines.push('    import flash.display.Sprite;');
    rootLines.push('');
    rootLines.push(`    public class ${name} extends Sprite`);
    rootLines.push('    {');
    for (const binary of binaries) {
        rootLines.push(`        public static const ${binary.rootProperty}:Class = ${binary.className};`);
    }
    for (const frame of frames) {
        const property = safeClassName(frame.name);
        const className = `${name}_${property}`;
        rootLines.push(`        public static var ${property}:Class = ${className};`);
    }
    rootLines.push('');
    rootLines.push(`        public function ${name}()`);
    rootLines.push('        {');
    rootLines.push('        }');
    rootLines.push('    }');
    rootLines.push('}');
    writeText(path.join(srcDir, `${name}.as`), rootLines.join('\n'));

    return { main: path.join(srcDir, `${name}.as`), name, figurePart, dataDir, frames };
}

function swfTagHeader(code, length) {
    if (length < 0x3f) {
        const header = Buffer.alloc(2);
        header.writeUInt16LE((code << 6) | length, 0);
        return header;
    }
    const header = Buffer.alloc(6);
    header.writeUInt16LE((code << 6) | 0x3f, 0);
    header.writeUInt32LE(length, 2);
    return header;
}

// DefineBitsLossless2 (tag 36), BitmapFormat 5 (32-bit). The pixel data is ARGB
// with the RGB channels premultiplied by alpha, zlib-compressed, row-major,
// no row padding (32-bit rows are already aligned).
function buildLossless2Tag(charId, width, height, rgba) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 4) {
        const a = rgba[i + 3];
        pixels[j] = a;
        pixels[j + 1] = Math.round((rgba[i] * a) / 255);
        pixels[j + 2] = Math.round((rgba[i + 1] * a) / 255);
        pixels[j + 3] = Math.round((rgba[i + 2] * a) / 255);
    }

    const zlibData = zlib.deflateSync(pixels);
    const body = Buffer.alloc(7 + zlibData.length);
    body.writeUInt16LE(charId, 0);
    body.writeUInt8(5, 2);
    body.writeUInt16LE(width, 3);
    body.writeUInt16LE(height, 5);
    zlibData.copy(body, 7);
    return Buffer.concat([swfTagHeader(36, body.length), body]);
}

// Build a character id -> exported class name map from the SWF's SymbolClass
// tags (tag 76).
function readSymbolClasses(tags) {
    const charToClass = new Map();
    for (const tag of tags) {
        if (tag.code !== 76) continue;
        const sb = tag.body;
        let q = 0;
        const count = sb.readUInt16LE(q); q += 2;
        for (let i = 0; i < count; i++) {
            const charId = sb.readUInt16LE(q); q += 2;
            let end = q;
            while (end < sb.length && sb[end] !== 0) end++;
            charToClass.set(charId, sb.subarray(q, end).toString('latin1'));
            q = end + 1;
        }
    }
    return charToClass;
}

// Repack the mxmlc output as CWS (zlib) so it opens in RetroSprite and other
// Flash tooling, which reject the ZWS/LZMA signature. For figure parts, every
// DefineBitsJPEG2 (tag 21, no alpha) frame bitmap mxmlc produced is rewritten
// to a DefineBitsLossless2 (tag 36, RGBA) built from the original PNG (which
// still has alpha), matched to its SWF character via the SymbolClass name.
// Returns the number of bitmaps whose alpha was restored.
function repackSwf(swfFile, project) {
    const raw = fs.readFileSync(swfFile);
    const sig = raw.subarray(0, 3).toString('ascii');
    const version = raw[3];

    let body;
    if (sig === 'FWS') body = raw.subarray(8);
    else if (sig === 'CWS') body = zlib.inflateSync(raw.subarray(8));
    else throw new Error(`Cannot repack ${sig} SWF (need FWS/CWS); build with -compress=false.`);

    // Skip the movie header: RECT (frame size) + frame rate (2) + frame count (2).
    const nbits = body[0] >> 3;
    const rectBytes = Math.ceil((5 + nbits * 4) / 8);
    const tagsStart = rectBytes + 4;

    // Parse all tags (bodies copied verbatim; nested tags stay opaque).
    const tags = [];
    let p = tagsStart;
    while (p < body.length) {
        const rh = body.readUInt16LE(p); p += 2;
        const code = rh >> 6;
        let len = rh & 0x3f;
        if (len === 0x3f) { len = body.readUInt32LE(p); p += 4; }
        tags.push({ code, body: body.subarray(p, p + len) });
        p += len;
        if (code === 0) break;
    }

    // Figure parts: map each frame class name -> source PNG (with alpha) on disk.
    let charToPng = null;
    if (project.figurePart) {
        const charToClass = readSymbolClasses(tags);
        const classToPng = new Map();
        for (const frame of project.frames) {
            classToPng.set(`${project.name}_${safeClassName(frame.name)}`, path.join(project.dataDir, `${frame.name}.png`));
        }
        charToPng = new Map();
        for (const [charId, className] of charToClass) {
            const pngFile = classToPng.get(className);
            if (pngFile) charToPng.set(charId, pngFile);
        }
    }

    let replaced = 0;
    const rebuilt = [];
    for (const tag of tags) {
        if (tag.code === 21 && charToPng) {
            const charId = tag.body.readUInt16LE(0);
            const pngFile = charToPng.get(charId);
            if (pngFile && fs.existsSync(pngFile)) {
                const image = decodePng(fs.readFileSync(pngFile));
                rebuilt.push(buildLossless2Tag(charId, image.width, image.height, image.rgba));
                replaced++;
                continue;
            }
        }
        rebuilt.push(Buffer.concat([swfTagHeader(tag.code, tag.body.length), tag.body]));
    }

    const newBody = Buffer.concat([body.subarray(0, tagsStart), ...rebuilt]);
    const header = Buffer.alloc(8);
    // FileLength is the uncompressed total (8-byte header + body) for both forms.
    header.writeUInt8(version, 3);
    header.writeUInt32LE(8 + newBody.length, 4);

    if (project.uncompressed) {
        header.write('FWS', 0, 'ascii');
        fs.writeFileSync(swfFile, Buffer.concat([header, newBody]));
    } else {
        header.write('CWS', 0, 'ascii');
        fs.writeFileSync(swfFile, Buffer.concat([header, zlib.deflateSync(newBody)]));
    }
    return replaced;
}

function convertOne(inputFile, outputFile, airHome, tmpRoot, newName, uncompressed) {
    const unpacked = unpackNitro(inputFile);
    let json = unpacked.json;
    const png = unpacked.png;

    const originalName = json.name || path.basename(inputFile, '.nitro');
    if (newName && newName !== originalName) {
        json = renameInValue(json, originalName, newName);
        if (!json.name) json.name = newName;
        console.log(`Renamed ${originalName} -> ${newName}`);
    }

    const name = safeClassName(json.name || newName || path.basename(inputFile, '.nitro'));
    const workDir = path.join(tmpRoot, name);
    fs.rmSync(workDir, { recursive: true, force: true });
    ensureDir(workDir);

    const project = writeAsProject(workDir, json, png);
    project.uncompressed = !!uncompressed;
    ensureDir(path.dirname(outputFile));

    const mxmlc = path.join(airHome, 'bin', 'mxmlc.bat');
    if (!fs.existsSync(mxmlc)) throw new Error(`mxmlc.bat not found: ${mxmlc}`);

    const result = cp.spawnSync('cmd.exe', [
        '/c',
        mxmlc,
        '-static-link-runtime-shared-libraries=true',
        '-use-network=false',
        // Emit an uncompressed SWF (FWS). Node has no LZMA to read mxmlc's
        // default ZWS output; we repack to CWS (zlib) ourselves below.
        '-compress=false',
        `-source-path+=${path.join(workDir, 'src')}`,
        `-output=${outputFile}`,
        project.main
    ], { encoding: 'utf8' });

    writeCompilerOutput(result.stdout);
    writeCompilerOutput(result.stderr);

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`mxmlc failed with exit code ${result.status}`);

    // Repack to CWS (zlib) so the output opens in RetroSprite and other Flash
    // tooling (which reject ZWS/LZMA). For figure parts this also rewrites the
    // alpha-less DefineBitsJPEG2 frames mxmlc produced back to DefineBitsLossless2.
    const fixed = repackSwf(outputFile, project);
    if (fixed) console.log(`Restored alpha on ${fixed} frame bitmap(s) in ${outputFile}`);

    console.log(`Wrote ${outputFile}`);
}

function writeCompilerOutput(text) {
    if (!text) return;

    const lines = text.split(/\r?\n/);
    const filtered = lines.filter(line => {
        const trimmed = line.trim();

        if (!trimmed) return false;
        if (trimmed === 'command line') return false;
        if (trimmed === "Warning: 'static-link-runtime-shared-libraries' is not fully supported.") return false;

        return true;
    });

    if (filtered.length) console.log(filtered.join(os.EOL));
}

function main() {
    const { airHome, input, output, renameMap: renameMapPath, uncompressed } = parseArgs(process.argv);
    const stat = fs.statSync(input);
    const tmpRoot = path.join(path.dirname(__dirname), '.tmp');
    ensureDir(tmpRoot);

    const renameMap = loadRenameMap(renameMapPath);
    console.log(`Output compression: ${uncompressed ? 'uncompressed (FWS)' : 'compressed (CWS/zlib)'}`);

    if (stat.isDirectory()) {
        if (!output) throw new Error('Output folder is required when input is a folder.');
        ensureDir(output);
        const files = fs.readdirSync(input)
            .filter(file => file.toLowerCase().endsWith('.nitro'))
            .map(file => path.join(input, file));

        if (!files.length) throw new Error(`No .nitro files found in ${input}`);

        for (const file of files) {
            const baseName = path.basename(file, '.nitro');
            const newName = resolveNewName(renameMap, baseName, baseName);
            const outFile = path.join(output, `${newName}.swf`);
            convertOne(file, outFile, airHome, tmpRoot, newName, uncompressed);
        }
    } else {
        const baseName = path.basename(input, '.nitro');
        const newName = resolveNewName(renameMap, baseName, baseName);
        const outFile = output || path.join(path.dirname(input), `${newName}.swf`);
        convertOne(input, outFile, airHome, tmpRoot, newName, uncompressed);
    }
}

try {
    main();
} catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
}
