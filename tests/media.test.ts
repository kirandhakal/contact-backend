import { describe, expect, it } from "vitest";
import {
  extractMediaAttachments,
  formHasMediaFields,
  mediaFieldsFromSchema,
  mediaTypeAllowed,
  mediaUploadPolicy,
  MediaReferenceError,
  normalizeUploadConfig
} from "../src/media.js";
import type { FormRecord } from "../src/types.js";

const form = (schema: FormRecord["schema"], uploadConfig: FormRecord["uploadConfig"] = {}): FormRecord => ({
  id: "form-id",
  tenantId: "tenant-id",
  publicKey: "form-key",
  name: "Media form",
  status: "active",
  allowedOrigins: [],
  successMessage: "ok",
  honeypotField: "_website",
  version: 1,
  schema,
  uploadConfig
});

describe("media schema helpers", () => {
  it("recognises legacy uri fields and new markers", () => {
    const fields = mediaFieldsFromSchema({
      type: "object",
      properties: {
        legacy: { type: "string", format: "uri" },
        single: { type: "string", "x-contact-media": { multiple: false } },
        many: { type: "array", items: { type: "string" }, "x-contact-media": { multiple: true } }
      }
    });
    expect(fields.map((field) => [field.key, field.multiple, field.legacy])).toEqual([
      ["legacy", false, true],
      ["single", false, false],
      ["many", true, false]
    ]);
  });

  it("normalises and caps tenant upload configuration", () => {
    expect(normalizeUploadConfig({ enabled: true, maxSizeMB: 999, maxFiles: 500, uploadType: "multiple", allowedTypes: " image/* " })).toEqual({
      enabled: true,
      maxSizeMB: 100,
      maxFiles: 20,
      uploadType: "multiple",
      allowedTypes: "image/*"
    });
  });

  it("applies per-form limits but never exceeds the server cap", () => {
    const record = form({ type: "object", properties: { file: { type: "string", "x-contact-media": {} } } }, { enabled: true, maxSizeMB: 50, allowedTypes: "image/*" });
    expect(formHasMediaFields(record)).toBe(true);
    expect(mediaUploadPolicy(record, 10 * 1024 * 1024)).toMatchObject({
      enabled: true,
      maxSizeBytes: 10 * 1024 * 1024,
      allowedTypes: "image/*"
    });
  });

  it("accepts wildcard MIME types and extensions", () => {
    expect(mediaTypeAllowed("photo.png", "image/png", "image/*")).toBe(true);
    expect(mediaTypeAllowed("brief.PDF", "application/pdf", ".pdf")).toBe(true);
    expect(mediaTypeAllowed("notes.txt", "text/plain", "image/*,application/pdf")).toBe(false);
  });

  it("extracts upload IDs and rejects embedded or oversized values", () => {
    const record = form({
      type: "object",
      properties: {
        attachment: { type: "string", "x-contact-media": {} },
        documents: { type: "array", items: { type: "string" }, "x-contact-media": { multiple: true, maxFiles: 2 } }
      }
    });
    expect(extractMediaAttachments(record, { attachment: "upload-1", documents: ["upload-2", "upload-3"] })).toEqual([
      { uploadId: "upload-1", fieldKey: "attachment" },
      { uploadId: "upload-2", fieldKey: "documents" },
      { uploadId: "upload-3", fieldKey: "documents" }
    ]);
    expect(() => extractMediaAttachments(record, { attachment: "data:image/png;base64,abc" })).toThrow(MediaReferenceError);
    expect(() => extractMediaAttachments(record, { attachment: "x".repeat(2049) })).toThrow(MediaReferenceError);
    expect(() => extractMediaAttachments(record, { documents: ["1", "2", "3"] })).toThrow(MediaReferenceError);
  });
});
