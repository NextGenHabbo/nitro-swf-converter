# Nitro SWF Converter

![Node.js](https://img.shields.io/badge/Node.js-14%2B-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)
![GitHub release](https://img.shields.io/github/v/release/NextGenHabbo/nitro-swf-converter?sort=semver)

Convert Habbo/Nitro furniture assets (`.nitro`) into legacy Flash (`.swf`) libraries using the Adobe AIR SDK.

## Overview

This project contains two tools:

### NitroSwfConverter.js

An interactive command-line utility that:

* Converts existing `.nitro` files into `.swf`
* Downloads furniture assets directly from a Furnidata JSON source
* Downloads and extracts an AIR SDK automatically (optional)
* Batch processes large furniture libraries

### convert-nitro.js

The core converter responsible for:

* Reading Nitro asset containers
* Extracting embedded JSON metadata and PNG atlases
* Generating Habbo-compatible XML manifests
* Creating ActionScript classes dynamically
* Compiling everything into a SWF using Adobe AIR's `mxmlc`

---

## Features

* Batch conversion of `.nitro` files
* Automatic furniture asset downloading from Furnidata
* Automatic AIR SDK download and extraction
* Generates:

  * manifest.xml
  * assets.xml
  * logic.xml
  * visualization.xml
  * index.xml
* Extracts and crops sprite atlases automatically
* Automatically generates 32px assets from 64px sources if 32px versions are missing
* Pure Node.js implementation
* No external image libraries required

---

## Requirements

### Software

- [Node.js 14+](https://nodejs.org/en/download)
- [Adobe AIR SDK 51.1.3.1](https://airsdk.harman.com/download/51.1.3.1)

### Windows

The project currently targets Windows and requires:

- `cmd.exe`
- `tar.exe`

These are included with modern Windows installations.

---

## Project Structure

```text
project/
│
├─ src/
│  └─ convert-nitro.js
│
├─ nitro/
│  └─ *.nitro
│
├─ swf/
│  └─ *.swf
│
├─ downloads/
│
├─ air-sdk/
│
└─ NitroSwfConverter.js
```

### Folders

| Folder    | Purpose                 |
| --------- | ----------------------- |
| nitro     | Input Nitro files       |
| swf       | Generated SWF files     |
| downloads | Temporary downloads     |
| air-sdk   | Extracted AIR SDK       |
| src       | Core conversion scripts |

---

## Installation

Clone the repository:

```bash
git clone https://github.com/NextGenHabbo/nitro-swf-converter.git
cd NitroSwfConverter
```

Install dependencies:

```bash
npm install
```

---

## Interactive Usage

Launch the converter:

```bash
node NitroSwfConverter.js
```

or

```bash
node NitroSwfConverter.js "C:\harman-air\AIRSDK_51.3.1"
```

---

## Mode 1 — Convert Existing Nitro Files

Place Nitro files into:

```text
nitro/
```

Run:

```bash
node NitroSwfConverter.js
```

Choose:

```text
1. Convert existing .nitro files
```

Converted files will be written to:

```text
swf/
```

---

## Mode 2 — Download Furniture From Furnidata

Choose:

```text
2. Download furniture from furnidata.json, then convert
```

Provide:

### Furnidata JSON

Example:

```text
https://example.com/furnidata.json
```

or

```text
C:\data\furnidata.json
```

### Nitro URL Template

Simple base URL:

```text
https://example.com/nitro/
```

This automatically resolves to:

```text
https://example.com/nitro/%className%.nitro
```

Custom template:

```text
https://example.com/nitro/%revision%/%className%.nitro
```

Available tokens:

| Token       | Description         |
| ----------- | ------------------- |
| %className% | Furniture classname |
| %revision%  | Furniture revision  |

---

# Direct Converter Usage

The underlying converter can also be used directly.

## Single File

```bash
node src/convert-nitro.js --air-home "C:\harman-air\AIRSDK_51.3.1" chair_basic.nitro
```

Output:

```text
chair_basic.swf
```

---

## Single File With Custom Output

```bash
node src/convert-nitro.js --air-home "C:\harman-air\AIRSDK_51.3.1" chair_basic.nitro output.swf
```

---

## Folder Conversion

```bash
node src/convert-nitro.js --air-home "C:\harman-air\AIRSDK_51.3.1" nitro swf
```

Every `.nitro` file inside the input folder will be converted.

---

# How Conversion Works

For each Nitro file:

1. Read Nitro container
2. Extract compressed JSON metadata
3. Extract PNG atlas
4. Decode atlas internally
5. Generate sprite PNGs
6. Generate XML resources
7. Generate ActionScript source
8. Compile with AIR SDK (`mxmlc`)
9. Output a Flash SWF library

---

# Generated Assets

Each SWF contains embedded equivalents of:

```text
manifest.xml
index.xml
assets.xml
logic.xml
visualization.xml
```

along with all sprite textures extracted from the Nitro atlas.

---

# AIR SDK

The tool searches for:

```text
bin/mxmlc.bat
```

inside the supplied AIR SDK directory.

Default path:

```text
C:\harman-air\AIRSDK_51.3.1
```

You may also provide a ZIP download URL and the tool will:

1. Download the SDK
2. Extract it
3. Locate `mxmlc.bat`
4. Continue automatically

---

# Notes

* Existing Nitro files are skipped during downloads.
* Failed downloads are reported and do not stop the batch.
* Temporary compilation files are generated inside `.tmp`.
* AIR SDK compilation warnings are filtered for cleaner output.

---

# License

MIT License

Feel free to modify, redistribute, and integrate into your own Nitro tooling projects.