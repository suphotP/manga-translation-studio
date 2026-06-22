import { describe, expect, it } from "vitest";
import { createZipBlob, crc32 } from "$lib/project/zip-writer.js";

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readUint16(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

describe("zip writer", () => {
	it("calculates standard crc32 checksums", () => {
		expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
	});

	it("creates a stored zip with local headers, central directory, and filenames", async () => {
		const zip = await createZipBlob([
			{ path: "manifest.json", data: "{\"ok\":true}", modifiedAt: new Date("2026-05-12T00:00:00Z") },
			{ path: "pages/001_page_1_merged.png", data: new Uint8Array([1, 2, 3]), modifiedAt: new Date("2026-05-12T00:00:00Z") },
		]);
		const bytes = await blobToBytes(zip);
		const decoded = new TextDecoder().decode(bytes);
		const eocdOffset = bytes.length - 22;

		expect(zip.type).toBe("application/zip");
		expect(readUint32(bytes, 0)).toBe(0x04034b50);
		expect(readUint16(bytes, 6)).toBe(0x0800);
		expect(readUint32(bytes, eocdOffset)).toBe(0x06054b50);
		expect(readUint16(bytes, eocdOffset + 8)).toBe(2);
		expect(decoded).toContain("manifest.json");
		expect(decoded).toContain("pages/001_page_1_merged.png");
	});

	it("keeps small archives on the legacy 32-bit path (no ZIP64 records)", async () => {
		const zip = await createZipBlob([
			{ path: "a.bin", data: new Uint8Array([1, 2, 3, 4]), modifiedAt: new Date("2026-05-12T00:00:00Z") },
		]);
		const bytes = await blobToBytes(zip);
		// Legacy "version needed to extract" = 20 in the local header (offset 4); a
		// ZIP64-triggered archive would be 45.
		expect(readUint16(bytes, 4)).toBe(20);
		// No ZIP64 EOCD record (0x06064b50) or locator (0x07064b50) anywhere.
		const decoder = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let foundZip64Eocd = false;
		for (let i = 0; i + 4 <= bytes.length; i += 1) {
			const sig = decoder.getUint32(i, true);
			if (sig === 0x06064b50 || sig === 0x07064b50) foundZip64Eocd = true;
		}
		expect(foundZip64Eocd).toBe(false);
		// EOCD is the final 22 bytes for a single small entry.
		expect(readUint32(bytes, bytes.length - 22)).toBe(0x06054b50);
		expect(readUint32(bytes, bytes.length - 22 + 16)).not.toBe(0xffffffff); // central offset not sentinel
	});

	it("E5: streams Blob sources straight into parts (CRC + payload intact, no byte-copy retention)", async () => {
		// E5 memory fix: createZipBlob now pushes the ORIGINAL Blob source as a Blob part
		// (rather than flattening every page into a resident Uint8Array) and drops its
		// reference to each consumed source from the input array. This asserts the output
		// is still byte-correct: the payload bytes survive verbatim and the CRC stored in
		// the local header matches a CRC computed over those exact bytes.
		const payload = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
		const files = [
			{ path: "pages/001.png", data: new Blob([payload]), modifiedAt: new Date("2026-05-12T00:00:00Z") },
		];
		const zip = await createZipBlob(files);
		const bytes = await blobToBytes(zip);

		// Local header CRC (offset 14) equals the CRC of the original payload bytes.
		expect(readUint32(bytes, 14)).toBe(crc32(payload));
		// Uncompressed + compressed sizes (STORE) equal the payload length.
		expect(readUint32(bytes, 18)).toBe(payload.length);
		expect(readUint32(bytes, 22)).toBe(payload.length);
		// The payload bytes appear verbatim right after the local header + filename.
		const fileNameLen = readUint16(bytes, 26);
		const dataStart = 30 + fileNameLen;
		expect(Array.from(bytes.slice(dataStart, dataStart + payload.length))).toEqual(Array.from(payload));
		// Consumed source reference was released from the input array (memory release).
		expect(files[0]).toBeNull();
	});

	it("crc32 stays correct on a larger buffer (indexed loop)", () => {
		// Guards the for..of → indexed-loop perf change: result must be unchanged.
		const buf = new Uint8Array(4096);
		for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 31 + 7) & 0xff;
		// Independent reference crc32 (bit-by-bit) over the same bytes.
		let ref = 0xffffffff;
		for (let i = 0; i < buf.length; i += 1) {
			ref ^= buf[i];
			for (let k = 0; k < 8; k += 1) ref = ref & 1 ? (ref >>> 1) ^ 0xedb88320 : ref >>> 1;
		}
		ref = (ref ^ 0xffffffff) >>> 0;
		expect(crc32(buf)).toBe(ref);
	});
});
