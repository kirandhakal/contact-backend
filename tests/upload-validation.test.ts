import { describe, expect, it } from "vitest";
import { sanitizeUploadFilename, validateUploadedFile } from "../src/upload-validation.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe("upload validation", () => {
  it("sanitizes path traversal from filenames", () => {
    expect(sanitizeUploadFilename("../../etc/passwd.png")).toBe("passwd.png");
    expect(sanitizeUploadFilename("C:\\temp\\photo.JPG")).toBe("photo.JPG");
  });

  it("accepts a valid PNG under the size limit", () => {
    const result = validateUploadedFile({
      filename: "logo.png",
      mimetype: "image/png",
      buffer: PNG_1X1,
      maxFileSizeBytes: 10 * 1024 * 1024
    });
    expect(result).toEqual({ ok: true, mime: "image/png", filename: "logo.png" });
  });

  it("rejects empty files", () => {
    const result = validateUploadedFile({
      filename: "empty.png",
      mimetype: "image/png",
      buffer: Buffer.alloc(0),
      maxFileSizeBytes: 10 * 1024 * 1024
    });
    expect(result).toMatchObject({ ok: false, code: "EMPTY_FILE", status: 400 });
  });

  it("rejects oversized files", () => {
    const result = validateUploadedFile({
      filename: "big.png",
      mimetype: "image/png",
      buffer: PNG_1X1,
      maxFileSizeBytes: 10
    });
    expect(result).toMatchObject({ ok: false, code: "FILE_TOO_LARGE", status: 413 });
  });

  it("rejects unsupported extensions and mismatched contents", () => {
    expect(validateUploadedFile({
      filename: "notes.exe",
      mimetype: "application/octet-stream",
      buffer: PNG_1X1,
      maxFileSizeBytes: 10 * 1024 * 1024
    })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE_TYPE", status: 400 });

    expect(validateUploadedFile({
      filename: "notes.png",
      mimetype: "image/png",
      buffer: Buffer.from("not-an-image"),
      maxFileSizeBytes: 10 * 1024 * 1024
    })).toMatchObject({ ok: false, code: "UNSUPPORTED_FILE_TYPE", status: 400 });
  });
});
