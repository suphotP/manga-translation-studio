import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import { crc32, createZipBuffer } from "../services/zip-writer.js";

const textEncoder = new TextEncoder();
const FIXED_DATE = new Date("2026-06-11T00:00:00.000Z");
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP32_LIMIT = 0xffffffff;
const ZIP16_LIMIT = 0xffff;
const ZIP_VERSION_ZIP64 = 45;
const ZIP_VERSION_BASE = 20;
const ZIP64_EXTRA_TAG = 0x0001;

interface ZipWriterInternals {
	makeLocalHeader(fileName: Uint8Array, data: Uint8Array, crc: number, modifiedAt: Date): Uint8Array;
	makeCentralHeader(
		fileName: Uint8Array,
		data: Uint8Array,
		crc: number,
		modifiedAt: Date,
		localHeaderOffset: number,
	): Uint8Array;
	makeZip64EndOfCentralDirectory(fileCount: number, centralSize: number, centralOffset: number): Uint8Array;
	makeZip64EndOfCentralDirectoryLocator(zip64EocdOffset: number): Uint8Array;
	makeEndOfCentralDirectory(fileCount: number, centralSize: number, centralOffset: number): Uint8Array;
}

interface ParsedLocalHeader {
	versionNeeded: number;
	flags: number;
	method: number;
	crc: number;
	compressedSize32: number;
	uncompressedSize32: number;
	extraLength: number;
	name: string;
	dataOffset: number;
	zip64Values: bigint[];
}

interface ParsedCentralHeader {
	versionMadeBy: number;
	versionNeeded: number;
	flags: number;
	method: number;
	crc: number;
	compressedSize32: number;
	uncompressedSize32: number;
	extraLength: number;
	name: string;
	localHeaderOffset32: number;
	zip64Values: bigint[];
}

interface ParsedEndOfCentralDirectory {
	diskEntryCount: number;
	totalEntryCount: number;
	centralSize32: number;
	centralOffset32: number;
	commentLength: number;
}

let internalsCache: ZipWriterInternals | undefined;

function loadZipWriterInternals(): ZipWriterInternals {
	if (internalsCache) return internalsCache;

	const source = readFileSync(join(import.meta.dir, "../services/zip-writer.ts"), "utf8");
	const exposedSource = source
		.replace(/\bexport interface\b/g, "interface")
		.replace(/\bexport function\b/g, "function");
	const javascript = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(exposedSource);
	// ZIP64 size edges are 4GiB-adjacent, so expose private header builders
	// without allocating payloads large enough to make a full archive.
	internalsCache = new Function(`${javascript}
return {
	makeLocalHeader,
	makeCentralHeader,
	makeZip64EndOfCentralDirectory,
	makeZip64EndOfCentralDirectoryLocator,
	makeEndOfCentralDirectory,
};`)() as ZipWriterInternals;
	return internalsCache;
}

function dataWithLength(length: number): Uint8Array {
	// Header builders only read `.length`; this keeps threshold tests small.
	return { length } as unknown as Uint8Array;
}

function toBuffer(bytes: Uint8Array): Buffer {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readZip64ExtraValues(buffer: Buffer, extraStart: number, extraLength: number): bigint[] {
	const extraEnd = extraStart + extraLength;
	for (let offset = extraStart; offset < extraEnd;) {
		const tag = buffer.readUInt16LE(offset);
		const size = buffer.readUInt16LE(offset + 2);
		const dataStart = offset + 4;
		const dataEnd = dataStart + size;
		expect(dataEnd).toBeLessThanOrEqual(extraEnd);
		if (tag === ZIP64_EXTRA_TAG) {
			expect(size % 8).toBe(0);
			const values: bigint[] = [];
			for (let position = dataStart; position < dataEnd; position += 8) {
				values.push(buffer.readBigUInt64LE(position));
			}
			return values;
		}
		offset = dataEnd;
	}
	return [];
}

function parseLocalHeader(bytes: Uint8Array, offset = 0): ParsedLocalHeader {
	const buffer = toBuffer(bytes);
	expect(buffer.readUInt32LE(offset)).toBe(0x04034b50);

	const fileNameLength = buffer.readUInt16LE(offset + 26);
	const extraLength = buffer.readUInt16LE(offset + 28);
	const nameStart = offset + 30;
	const nameEnd = nameStart + fileNameLength;
	const extraStart = nameEnd;
	const dataOffset = extraStart + extraLength;

	return {
		versionNeeded: buffer.readUInt16LE(offset + 4),
		flags: buffer.readUInt16LE(offset + 6),
		method: buffer.readUInt16LE(offset + 8),
		crc: buffer.readUInt32LE(offset + 14),
		compressedSize32: buffer.readUInt32LE(offset + 18),
		uncompressedSize32: buffer.readUInt32LE(offset + 22),
		extraLength,
		name: buffer.subarray(nameStart, nameEnd).toString("utf8"),
		dataOffset,
		zip64Values: readZip64ExtraValues(buffer, extraStart, extraLength),
	};
}

function parseCentralHeader(bytes: Uint8Array, offset = 0): ParsedCentralHeader {
	const buffer = toBuffer(bytes);
	expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);

	const fileNameLength = buffer.readUInt16LE(offset + 28);
	const extraLength = buffer.readUInt16LE(offset + 30);
	const nameStart = offset + 46;
	const nameEnd = nameStart + fileNameLength;
	const extraStart = nameEnd;

	return {
		versionMadeBy: buffer.readUInt16LE(offset + 4),
		versionNeeded: buffer.readUInt16LE(offset + 6),
		flags: buffer.readUInt16LE(offset + 8),
		method: buffer.readUInt16LE(offset + 10),
		crc: buffer.readUInt32LE(offset + 16),
		compressedSize32: buffer.readUInt32LE(offset + 20),
		uncompressedSize32: buffer.readUInt32LE(offset + 24),
		extraLength,
		name: buffer.subarray(nameStart, nameEnd).toString("utf8"),
		localHeaderOffset32: buffer.readUInt32LE(offset + 42),
		zip64Values: readZip64ExtraValues(buffer, extraStart, extraLength),
	};
}

function parseEndOfCentralDirectory(bytes: Uint8Array, offset = 0): ParsedEndOfCentralDirectory {
	const buffer = toBuffer(bytes);
	expect(buffer.readUInt32LE(offset)).toBe(0x06054b50);
	return {
		diskEntryCount: buffer.readUInt16LE(offset + 8),
		totalEntryCount: buffer.readUInt16LE(offset + 10),
		centralSize32: buffer.readUInt32LE(offset + 12),
		centralOffset32: buffer.readUInt32LE(offset + 16),
		commentLength: buffer.readUInt16LE(offset + 20),
	};
}

function parseZip64EndOfCentralDirectory(bytes: Uint8Array): {
	recordSize: bigint;
	versionMadeBy: number;
	versionNeeded: number;
	diskEntryCount: bigint;
	totalEntryCount: bigint;
	centralSize: bigint;
	centralOffset: bigint;
} {
	const buffer = toBuffer(bytes);
	expect(buffer.readUInt32LE(0)).toBe(0x06064b50);
	return {
		recordSize: buffer.readBigUInt64LE(4),
		versionMadeBy: buffer.readUInt16LE(12),
		versionNeeded: buffer.readUInt16LE(14),
		diskEntryCount: buffer.readBigUInt64LE(24),
		totalEntryCount: buffer.readBigUInt64LE(32),
		centralSize: buffer.readBigUInt64LE(40),
		centralOffset: buffer.readBigUInt64LE(48),
	};
}

function parseZip64Locator(bytes: Uint8Array): { zip64EocdOffset: bigint; diskCount: number } {
	const buffer = toBuffer(bytes);
	expect(buffer.readUInt32LE(0)).toBe(0x07064b50);
	return {
		zip64EocdOffset: buffer.readBigUInt64LE(8),
		diskCount: buffer.readUInt32LE(16),
	};
}

describe("crc32", () => {
	test("matches known vectors", () => {
		const vectors: Array<[string, number]> = [
			["", 0x00000000],
			["123456789", 0xcbf43926],
			["hello world", 0x0d4a1185],
			["The quick brown fox jumps over the lazy dog", 0x414fa339],
		];

		for (const [input, expected] of vectors) {
			expect(crc32(textEncoder.encode(input))).toBe(expected);
		}
	});
});

describe("createZipBuffer", () => {
	test("rejects empty, dot, and dot-dot path segments", () => {
		const invalidPaths = [
			"",
			" ",
			"pages//001.png",
			"pages/./001.png",
			"pages/../001.png",
			"../escape.png",
			"pages/.",
			"pages/..",
		];

		for (const path of invalidPaths) {
			expect(() => createZipBuffer([{ path, data: "x", modifiedAt: FIXED_DATE }])).toThrow(/Invalid zip path/);
		}
	});

	test("rejects duplicate paths after zip path normalization", () => {
		expect(() => createZipBuffer([
			{ path: "pages\\001.png", data: "first", modifiedAt: FIXED_DATE },
			{ path: "/pages/001.png", data: "second", modifiedAt: FIXED_DATE },
		])).toThrow(/Duplicate zip path: pages\/001\.png/);
	});

	test("writes UTF-8 file names with UTF-8 flags in local and central headers", () => {
		const path = "pages/001-บทที่-夜.png";
		const data = Buffer.from("translated page bytes");
		const zip = createZipBuffer([{ path, data, modifiedAt: FIXED_DATE }]);
		const eocd = parseEndOfCentralDirectory(zip, zip.length - 22);
		expect(eocd.diskEntryCount).toBe(1);
		expect(eocd.totalEntryCount).toBe(1);
		expect(eocd.commentLength).toBe(0);

		const local = parseLocalHeader(zip, 0);
		expect(local.versionNeeded).toBe(ZIP_VERSION_BASE);
		expect(local.flags & ZIP_UTF8_FLAG).toBe(ZIP_UTF8_FLAG);
		expect(local.method).toBe(ZIP_STORE_METHOD);
		expect(local.crc).toBe(crc32(data));
		expect(local.compressedSize32).toBe(data.length);
		expect(local.uncompressedSize32).toBe(data.length);
		expect(local.extraLength).toBe(0);
		expect(local.name).toBe(path);
		expect(Buffer.from(zip.subarray(local.dataOffset, local.dataOffset + data.length))).toEqual(data);

		const central = parseCentralHeader(zip, eocd.centralOffset32);
		expect(central.versionNeeded).toBe(ZIP_VERSION_BASE);
		expect(central.flags & ZIP_UTF8_FLAG).toBe(ZIP_UTF8_FLAG);
		expect(central.method).toBe(ZIP_STORE_METHOD);
		expect(central.crc).toBe(crc32(data));
		expect(central.compressedSize32).toBe(data.length);
		expect(central.uncompressedSize32).toBe(data.length);
		expect(central.localHeaderOffset32).toBe(0);
		expect(central.extraLength).toBe(0);
		expect(central.name).toBe(path);
		expect(eocd.centralSize32).toBe(46 + textEncoder.encode(path).length);
	});
});

describe("ZIP64 header thresholds", () => {
	test("keeps 32-bit size and offset fields below ZIP64 sentinels", () => {
		const internals = loadZipWriterInternals();
		const name = textEncoder.encode("edge.bin");
		const crc = 0x12345678;

		const local = parseLocalHeader(
			internals.makeLocalHeader(name, dataWithLength(ZIP32_LIMIT - 1), crc, FIXED_DATE),
		);
		expect(local.versionNeeded).toBe(ZIP_VERSION_BASE);
		expect(local.compressedSize32).toBe(ZIP32_LIMIT - 1);
		expect(local.uncompressedSize32).toBe(ZIP32_LIMIT - 1);
		expect(local.extraLength).toBe(0);
		expect(local.zip64Values).toEqual([]);

		const central = parseCentralHeader(
			internals.makeCentralHeader(name, dataWithLength(ZIP32_LIMIT - 1), crc, FIXED_DATE, ZIP32_LIMIT - 1),
		);
		expect(central.versionMadeBy).toBe(ZIP_VERSION_BASE);
		expect(central.versionNeeded).toBe(ZIP_VERSION_BASE);
		expect(central.compressedSize32).toBe(ZIP32_LIMIT - 1);
		expect(central.uncompressedSize32).toBe(ZIP32_LIMIT - 1);
		expect(central.localHeaderOffset32).toBe(ZIP32_LIMIT - 1);
		expect(central.extraLength).toBe(0);
		expect(central.zip64Values).toEqual([]);
	});

	test("uses ZIP64 local header size fields at the 0xffffffff threshold", () => {
		const internals = loadZipWriterInternals();
		const name = textEncoder.encode("edge.bin");
		const crc = 0x12345678;
		const local = parseLocalHeader(internals.makeLocalHeader(name, dataWithLength(ZIP32_LIMIT), crc, FIXED_DATE));

		expect(local.versionNeeded).toBe(ZIP_VERSION_ZIP64);
		expect(local.flags & ZIP_UTF8_FLAG).toBe(ZIP_UTF8_FLAG);
		expect(local.method).toBe(ZIP_STORE_METHOD);
		expect(local.crc).toBe(crc);
		expect(local.compressedSize32).toBe(ZIP32_LIMIT);
		expect(local.uncompressedSize32).toBe(ZIP32_LIMIT);
		expect(local.extraLength).toBe(20);
		expect(local.zip64Values).toEqual([BigInt(ZIP32_LIMIT), BigInt(ZIP32_LIMIT)]);
	});

	test("uses ZIP64 central extra fields for size and offset overflows independently", () => {
		const internals = loadZipWriterInternals();
		const name = textEncoder.encode("edge.bin");
		const crc = 0x12345678;

		const sizeOverflow = parseCentralHeader(
			internals.makeCentralHeader(name, dataWithLength(ZIP32_LIMIT), crc, FIXED_DATE, 123),
		);
		expect(sizeOverflow.versionMadeBy).toBe(ZIP_VERSION_ZIP64);
		expect(sizeOverflow.versionNeeded).toBe(ZIP_VERSION_ZIP64);
		expect(sizeOverflow.compressedSize32).toBe(ZIP32_LIMIT);
		expect(sizeOverflow.uncompressedSize32).toBe(ZIP32_LIMIT);
		expect(sizeOverflow.localHeaderOffset32).toBe(123);
		expect(sizeOverflow.extraLength).toBe(20);
		expect(sizeOverflow.zip64Values).toEqual([BigInt(ZIP32_LIMIT), BigInt(ZIP32_LIMIT)]);

		const offsetOverflow = parseCentralHeader(
			internals.makeCentralHeader(name, dataWithLength(1), crc, FIXED_DATE, ZIP32_LIMIT),
		);
		expect(offsetOverflow.versionMadeBy).toBe(ZIP_VERSION_ZIP64);
		expect(offsetOverflow.versionNeeded).toBe(ZIP_VERSION_ZIP64);
		expect(offsetOverflow.compressedSize32).toBe(1);
		expect(offsetOverflow.uncompressedSize32).toBe(1);
		expect(offsetOverflow.localHeaderOffset32).toBe(ZIP32_LIMIT);
		expect(offsetOverflow.extraLength).toBe(12);
		expect(offsetOverflow.zip64Values).toEqual([BigInt(ZIP32_LIMIT)]);

		const bothOverflow = parseCentralHeader(
			internals.makeCentralHeader(name, dataWithLength(ZIP32_LIMIT), crc, FIXED_DATE, ZIP32_LIMIT),
		);
		expect(bothOverflow.compressedSize32).toBe(ZIP32_LIMIT);
		expect(bothOverflow.uncompressedSize32).toBe(ZIP32_LIMIT);
		expect(bothOverflow.localHeaderOffset32).toBe(ZIP32_LIMIT);
		expect(bothOverflow.extraLength).toBe(28);
		expect(bothOverflow.zip64Values).toEqual([
			BigInt(ZIP32_LIMIT),
			BigInt(ZIP32_LIMIT),
			BigInt(ZIP32_LIMIT),
		]);
	});

	test("writes EOCD sentinels and ZIP64 end records at threshold edges", () => {
		const internals = loadZipWriterInternals();
		const below = parseEndOfCentralDirectory(
			internals.makeEndOfCentralDirectory(ZIP16_LIMIT - 1, ZIP32_LIMIT - 1, ZIP32_LIMIT - 1),
		);
		expect(below.diskEntryCount).toBe(ZIP16_LIMIT - 1);
		expect(below.totalEntryCount).toBe(ZIP16_LIMIT - 1);
		expect(below.centralSize32).toBe(ZIP32_LIMIT - 1);
		expect(below.centralOffset32).toBe(ZIP32_LIMIT - 1);

		const threshold = parseEndOfCentralDirectory(
			internals.makeEndOfCentralDirectory(ZIP16_LIMIT, ZIP32_LIMIT, ZIP32_LIMIT),
		);
		expect(threshold.diskEntryCount).toBe(ZIP16_LIMIT);
		expect(threshold.totalEntryCount).toBe(ZIP16_LIMIT);
		expect(threshold.centralSize32).toBe(ZIP32_LIMIT);
		expect(threshold.centralOffset32).toBe(ZIP32_LIMIT);

		const zip64End = parseZip64EndOfCentralDirectory(
			internals.makeZip64EndOfCentralDirectory(ZIP16_LIMIT, ZIP32_LIMIT, ZIP32_LIMIT),
		);
		expect(zip64End.recordSize).toBe(44n);
		expect(zip64End.versionMadeBy).toBe(ZIP_VERSION_ZIP64);
		expect(zip64End.versionNeeded).toBe(ZIP_VERSION_ZIP64);
		expect(zip64End.diskEntryCount).toBe(BigInt(ZIP16_LIMIT));
		expect(zip64End.totalEntryCount).toBe(BigInt(ZIP16_LIMIT));
		expect(zip64End.centralSize).toBe(BigInt(ZIP32_LIMIT));
		expect(zip64End.centralOffset).toBe(BigInt(ZIP32_LIMIT));

		const locator = parseZip64Locator(internals.makeZip64EndOfCentralDirectoryLocator(ZIP32_LIMIT));
		expect(locator.zip64EocdOffset).toBe(BigInt(ZIP32_LIMIT));
		expect(locator.diskCount).toBe(1);
	});
});
