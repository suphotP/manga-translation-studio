export interface ZipFileInput {
	path: string;
	data: Uint8Array | string;
	modifiedAt?: Date;
}

const textEncoder = new TextEncoder();
const CRC_TABLE = buildCrcTable();
const ZIP_STORE_METHOD = 0;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP32_LIMIT = 0xffffffff;
const ZIP16_LIMIT = 0xffff;
const ZIP_VERSION_ZIP64 = 45;
const ZIP_VERSION_BASE = 20;
const ZIP64_EXTRA_TAG = 0x0001;

function buildCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
}

export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	const length = data.length;
	for (let i = 0; i < length; i += 1) {
		crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function normalizeZipPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
	// Segment-wise validation: a substring check misses trailing `..` segments
	// ("foo/..") and lone "." segments (codex-class P3 on the generic service).
	const segments = normalized.split("/");
	if (!normalized || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`Invalid zip path: ${path}`);
	}
	return normalized;
}

function toBytes(data: Uint8Array | string): Uint8Array {
	return typeof data === "string" ? textEncoder.encode(data) : data;
}

function toBuffer(data: Uint8Array): Buffer {
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function setUint64(view: DataView, offset: number, value: number): void {
	view.setBigUint64(offset, BigInt(Math.trunc(value)), true);
}

function toDosDateTime(date: Date): { date: number; time: number } {
	const year = Math.max(1980, date.getFullYear());
	const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
	const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
	return { date: dosDate, time: dosTime };
}

function makeLocalHeader(fileName: Uint8Array, data: Uint8Array, crc: number, modifiedAt: Date): Uint8Array {
	const { date, time } = toDosDateTime(modifiedAt);
	const needsZip64 = data.length >= ZIP32_LIMIT;
	const extraLength = needsZip64 ? 20 : 0;
	const header = new Uint8Array(30 + fileName.length + extraLength);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x04034b50, true);
	view.setUint16(4, needsZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_BASE, true);
	view.setUint16(6, ZIP_UTF8_FLAG, true);
	view.setUint16(8, ZIP_STORE_METHOD, true);
	view.setUint16(10, time, true);
	view.setUint16(12, date, true);
	view.setUint32(14, crc, true);
	view.setUint32(18, needsZip64 ? ZIP32_LIMIT : data.length, true);
	view.setUint32(22, needsZip64 ? ZIP32_LIMIT : data.length, true);
	view.setUint16(26, fileName.length, true);
	view.setUint16(28, extraLength, true);
	header.set(fileName, 30);
	if (needsZip64) {
		const extraOffset = 30 + fileName.length;
		view.setUint16(extraOffset, ZIP64_EXTRA_TAG, true);
		view.setUint16(extraOffset + 2, 16, true);
		setUint64(view, extraOffset + 4, data.length);
		setUint64(view, extraOffset + 12, data.length);
	}
	return header;
}

function makeCentralHeader(
	fileName: Uint8Array,
	data: Uint8Array,
	crc: number,
	modifiedAt: Date,
	localHeaderOffset: number,
): Uint8Array {
	const { date, time } = toDosDateTime(modifiedAt);
	const sizeOverflow = data.length >= ZIP32_LIMIT;
	const offsetOverflow = localHeaderOffset >= ZIP32_LIMIT;
	const needsZip64 = sizeOverflow || offsetOverflow;
	let extraDataLength = 0;
	if (sizeOverflow) extraDataLength += 16;
	if (offsetOverflow) extraDataLength += 8;
	const extraLength = needsZip64 ? 4 + extraDataLength : 0;
	const header = new Uint8Array(46 + fileName.length + extraLength);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x02014b50, true);
	view.setUint16(4, needsZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_BASE, true);
	view.setUint16(6, needsZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_BASE, true);
	view.setUint16(8, ZIP_UTF8_FLAG, true);
	view.setUint16(10, ZIP_STORE_METHOD, true);
	view.setUint16(12, time, true);
	view.setUint16(14, date, true);
	view.setUint32(16, crc, true);
	view.setUint32(20, sizeOverflow ? ZIP32_LIMIT : data.length, true);
	view.setUint32(24, sizeOverflow ? ZIP32_LIMIT : data.length, true);
	view.setUint16(28, fileName.length, true);
	view.setUint16(30, extraLength, true);
	view.setUint16(32, 0, true);
	view.setUint16(34, 0, true);
	view.setUint16(36, 0, true);
	view.setUint32(38, 0, true);
	view.setUint32(42, offsetOverflow ? ZIP32_LIMIT : localHeaderOffset, true);
	header.set(fileName, 46);
	if (needsZip64) {
		let extraOffset = 46 + fileName.length;
		view.setUint16(extraOffset, ZIP64_EXTRA_TAG, true);
		view.setUint16(extraOffset + 2, extraDataLength, true);
		extraOffset += 4;
		if (sizeOverflow) {
			setUint64(view, extraOffset, data.length);
			setUint64(view, extraOffset + 8, data.length);
			extraOffset += 16;
		}
		if (offsetOverflow) setUint64(view, extraOffset, localHeaderOffset);
	}
	return header;
}

function makeZip64EndOfCentralDirectory(fileCount: number, centralSize: number, centralOffset: number): Uint8Array {
	const header = new Uint8Array(56);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x06064b50, true);
	setUint64(view, 4, 44);
	view.setUint16(12, ZIP_VERSION_ZIP64, true);
	view.setUint16(14, ZIP_VERSION_ZIP64, true);
	view.setUint32(16, 0, true);
	view.setUint32(20, 0, true);
	setUint64(view, 24, fileCount);
	setUint64(view, 32, fileCount);
	setUint64(view, 40, centralSize);
	setUint64(view, 48, centralOffset);
	return header;
}

function makeZip64EndOfCentralDirectoryLocator(zip64EocdOffset: number): Uint8Array {
	const header = new Uint8Array(20);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x07064b50, true);
	view.setUint32(4, 0, true);
	setUint64(view, 8, zip64EocdOffset);
	view.setUint32(16, 1, true);
	return header;
}

function makeEndOfCentralDirectory(fileCount: number, centralSize: number, centralOffset: number): Uint8Array {
	const countOverflow = fileCount >= ZIP16_LIMIT;
	const sizeOverflow = centralSize >= ZIP32_LIMIT;
	const offsetOverflow = centralOffset >= ZIP32_LIMIT;
	const header = new Uint8Array(22);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x06054b50, true);
	view.setUint16(4, 0, true);
	view.setUint16(6, 0, true);
	view.setUint16(8, countOverflow ? ZIP16_LIMIT : fileCount, true);
	view.setUint16(10, countOverflow ? ZIP16_LIMIT : fileCount, true);
	view.setUint32(12, sizeOverflow ? ZIP32_LIMIT : centralSize, true);
	view.setUint32(16, offsetOverflow ? ZIP32_LIMIT : centralOffset, true);
	view.setUint16(20, 0, true);
	return header;
}

export function createZipBuffer(files: ZipFileInput[]): Buffer {
	if (!files.length) throw new Error("Cannot create an empty zip");

	const localParts: Uint8Array[] = [];
	const centralParts: Uint8Array[] = [];
	const seenPaths = new Set<string>();
	let offset = 0;

	for (const file of files) {
		const normalizedPath = normalizeZipPath(file.path);
		if (seenPaths.has(normalizedPath)) {
			throw new Error(`Duplicate zip path: ${normalizedPath}`);
		}
		seenPaths.add(normalizedPath);

		const pathBytes = textEncoder.encode(normalizedPath);
		const data = toBytes(file.data);
		const crc = crc32(data);
		const modifiedAt = file.modifiedAt ?? new Date();
		const localHeader = makeLocalHeader(pathBytes, data, crc, modifiedAt);
		const centralHeader = makeCentralHeader(pathBytes, data, crc, modifiedAt, offset);
		localParts.push(localHeader, data);
		centralParts.push(centralHeader);
		offset += localHeader.length + data.length;
	}

	const centralOffset = offset;
	const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
	const endParts: Uint8Array[] = [];
	if (files.length >= ZIP16_LIMIT || centralSize >= ZIP32_LIMIT || centralOffset >= ZIP32_LIMIT) {
		const zip64EocdOffset = centralOffset + centralSize;
		endParts.push(
			makeZip64EndOfCentralDirectory(files.length, centralSize, centralOffset),
			makeZip64EndOfCentralDirectoryLocator(zip64EocdOffset),
		);
	}
	endParts.push(makeEndOfCentralDirectory(files.length, centralSize, centralOffset));

	return Buffer.concat([...localParts, ...centralParts, ...endParts].map(toBuffer));
}
