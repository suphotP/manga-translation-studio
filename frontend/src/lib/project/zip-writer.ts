export interface ZipFileInput {
	path: string;
	data: Blob | Uint8Array | string;
	modifiedAt?: Date;
}

const textEncoder = new TextEncoder();
const CRC_TABLE = buildCrcTable();
const ZIP_STORE_METHOD = 0;
const ZIP_UTF8_FLAG = 0x0800;
// 32-bit field ceiling. Any size/offset at or above this must be stored in a
// ZIP64 extra field (the legacy 32-bit field is set to the 0xffffffff sentinel).
const ZIP32_LIMIT = 0xffffffff;
// 16-bit field ceiling, used for the entry count in the End Of Central Directory.
const ZIP16_LIMIT = 0xffff;
// "Version needed to extract": 4.5 (45) signals ZIP64; 2.0 (20) is the legacy
// baseline for a stored, UTF-8-flagged entry.
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
	// Index-based loop (not for..of) — iterating a large Uint8Array with a
	// per-byte iterator is ~3× slower (measured ~1009ms vs ~317ms on 160MB),
	// which on a multi-page full-res export is a multi-hundred-ms main-thread
	// stall. A plain indexed read is the fast path.
	const length = data.length;
	for (let i = 0; i < length; i += 1) {
		crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function normalizeZipPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
	if (!normalized || normalized.includes("../") || normalized === "..") {
		throw new Error(`Invalid zip path: ${path}`);
	}
	return normalized;
}

async function toBytes(data: Blob | Uint8Array | string): Promise<Uint8Array> {
	if (typeof data === "string") return textEncoder.encode(data);
	if (data instanceof Uint8Array) return data;
	return new Uint8Array(await data.arrayBuffer());
}

// DataView.setBigUint64 needs a BigInt; sizes/offsets here come in as JS numbers
// (safe well past 4GB — Number.MAX_SAFE_INTEGER is ~9PB), so convert at the edge.
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
	// A single member ≥4GB overflows the 32-bit size fields → emit a ZIP64 extra
	// field carrying the true 64-bit compressed + uncompressed sizes (the legacy
	// fields hold the 0xffffffff sentinel). For STORE, compressed == uncompressed.
	const needsZip64 = data.length >= ZIP32_LIMIT;
	const extraLength = needsZip64 ? 20 : 0; // 4 (tag+len) + 8 + 8
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
		setUint64(view, extraOffset + 4, data.length); // uncompressed
		setUint64(view, extraOffset + 12, data.length); // compressed
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
	// The central record needs ZIP64 whenever a size OR the local-header offset
	// overflows its 32-bit field. The ZIP64 extra carries only the fields that
	// actually overflow, in the fixed order: uncompressed, compressed, offset.
	const sizeOverflow = data.length >= ZIP32_LIMIT;
	const offsetOverflow = localHeaderOffset >= ZIP32_LIMIT;
	const needsZip64 = sizeOverflow || offsetOverflow;
	let extraDataLength = 0;
	if (sizeOverflow) extraDataLength += 16; // uncompressed + compressed
	if (offsetOverflow) extraDataLength += 8; // local header offset
	const extraLength = needsZip64 ? 4 + extraDataLength : 0; // + tag + size
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
			setUint64(view, extraOffset, data.length); // uncompressed
			setUint64(view, extraOffset + 8, data.length); // compressed
			extraOffset += 16;
		}
		if (offsetOverflow) {
			setUint64(view, extraOffset, localHeaderOffset);
		}
	}
	return header;
}

// ZIP64 End Of Central Directory record (56 bytes) — emitted before the locator
// + legacy EOCD whenever the entry count, central-directory size, or its offset
// overflow their legacy 16/32-bit fields. Without this, a >4GB archive's EOCD
// silently truncates the central offset → a corrupt, unreadable ZIP.
function makeZip64EndOfCentralDirectory(fileCount: number, centralSize: number, centralOffset: number): Uint8Array {
	const header = new Uint8Array(56);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x06064b50, true); // ZIP64 EOCD signature
	setUint64(view, 4, 44); // size of remaining ZIP64 EOCD record
	view.setUint16(12, ZIP_VERSION_ZIP64, true); // version made by
	view.setUint16(14, ZIP_VERSION_ZIP64, true); // version needed
	view.setUint32(16, 0, true); // this disk number
	view.setUint32(20, 0, true); // disk with central dir
	setUint64(view, 24, fileCount); // entries on this disk
	setUint64(view, 32, fileCount); // total entries
	setUint64(view, 40, centralSize);
	setUint64(view, 48, centralOffset);
	return header;
}

function makeZip64EndOfCentralDirectoryLocator(zip64EocdOffset: number): Uint8Array {
	const header = new Uint8Array(20);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x07064b50, true); // ZIP64 EOCD locator signature
	view.setUint32(4, 0, true); // disk with ZIP64 EOCD
	setUint64(view, 8, zip64EocdOffset);
	view.setUint32(16, 1, true); // total number of disks
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

export async function createZipBlob(files: ZipFileInput[]): Promise<Blob> {
	if (!files.length) throw new Error("Cannot create an empty zip");

	// E5 — memory: the Blob constructor streams its parts, so the file payloads do
	// NOT need to be flattened into one giant resident Uint8Array. We compute the
	// CRC from a freshly-read view of each entry's bytes, then push the ORIGINAL
	// source (the page Blob) — not a retained byte copy — as the payload part, and
	// drop our reference to the source from `files` as it's consumed. This avoids
	// holding ~2-3× the total export size resident at once (source blobs + a byte
	// copy + the final concatenation) which OOM'd / froze large chapters.
	const localParts: (Uint8Array | Blob)[] = [];
	const centralParts: Uint8Array[] = [];
	let offset = 0;

	for (let i = 0; i < files.length; i += 1) {
		const file = files[i];
		const pathBytes = textEncoder.encode(normalizeZipPath(file.path));
		const data = await toBytes(file.data);
		const crc = crc32(data);
		const modifiedAt = file.modifiedAt ?? new Date();
		const localHeader = makeLocalHeader(pathBytes, data, crc, modifiedAt);
		const centralHeader = makeCentralHeader(pathBytes, data, crc, modifiedAt, offset);

		// Prefer the original Blob source as the payload part so the browser can keep
		// it backed by its existing (possibly on-disk) storage rather than us pinning
		// a second in-memory byte copy. Non-Blob inputs fall back to the read bytes.
		const payload: Uint8Array | Blob = file.data instanceof Blob ? file.data : data;
		localParts.push(localHeader, payload);
		centralParts.push(centralHeader);
		offset += localHeader.length + data.length;
		// Release the consumed source so it can be GC'd before we read the next page
		// (the part list now owns what it needs).
		files[i] = null as unknown as ZipFileInput;
	}

	const centralOffset = offset;
	const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

	// Emit the ZIP64 EOCD record + locator (before the legacy EOCD, which then
	// carries sentinels) whenever the entry count, central-directory size, or its
	// offset overflow their legacy fields. The per-entry headers already switched
	// to ZIP64 extras above, so this completes a spec-correct >4GB archive instead
	// of silently truncating to a corrupt one.
	const needsZip64Eocd =
		files.length >= ZIP16_LIMIT || centralSize >= ZIP32_LIMIT || centralOffset >= ZIP32_LIMIT;
	const endParts: Uint8Array[] = [];
	if (needsZip64Eocd) {
		const zip64EocdOffset = centralOffset + centralSize;
		endParts.push(
			makeZip64EndOfCentralDirectory(files.length, centralSize, centralOffset),
			makeZip64EndOfCentralDirectoryLocator(zip64EocdOffset),
		);
	}
	endParts.push(makeEndOfCentralDirectory(files.length, centralSize, centralOffset));

	return new Blob([...localParts, ...centralParts, ...endParts], { type: "application/zip" });
}
