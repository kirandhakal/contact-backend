import type { FormRecord, JsonObject, MediaAttachmentInput, UploadConfig } from "./types.js";
import { normalizeExtension } from "./upload-validation.js";

export interface MediaFieldConfig {
  key: string;
  multiple: boolean;
  required: boolean;
  maxFiles: number;
  maxSizeMB?: number;
  allowedTypes?: string;
  legacy: boolean;
}

export interface MediaUploadPolicy {
  enabled: boolean;
  maxSizeBytes: number;
  maxFiles: number;
  allowedTypes: string;
}

export class MediaReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaReferenceError";
  }
}

const DEFAULT_ALLOWED_TYPES = "image/*,application/pdf,.pdf,.doc,.docx,audio/*,video/*";

export function normalizeUploadConfig(value: unknown): UploadConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const maxSizeMB = Number(raw.maxSizeMB);
  const maxFiles = Number(raw.maxFiles);
  return {
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(Number.isFinite(maxSizeMB) && maxSizeMB > 0 ? { maxSizeMB: Math.min(Math.floor(maxSizeMB), 100) } : {}),
    ...(typeof raw.allowedTypes === "string" && raw.allowedTypes.trim() ? { allowedTypes: raw.allowedTypes.trim().slice(0, 1000) } : {}),
    ...(raw.uploadType === "multiple" || raw.uploadType === "single" ? { uploadType: raw.uploadType } : {}),
    ...(Number.isFinite(maxFiles) && maxFiles > 0 ? { maxFiles: Math.min(Math.floor(maxFiles), 20) } : {})
  };
}

function propertyMediaConfig(property: JsonObject): Record<string, unknown> | null {
  const marker = property["x-contact-media"];
  if (marker && typeof marker === "object" && !Array.isArray(marker)) return marker as Record<string, unknown>;
  if (property.format === "uri" && (property.type === "string" || property.type === undefined)) return {};
  if (property.type === "array") {
    const items = property.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      const item = items as JsonObject;
      if (item.format === "uri" && (item.type === "string" || item.type === undefined)) return { multiple: true };
    }
  }
  return null;
}

export function mediaFieldsFromSchema(schema: JsonObject, defaults: UploadConfig = {}): MediaFieldConfig[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const fields: MediaFieldConfig[] = [];
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const property = raw as JsonObject;
    const marker = propertyMediaConfig(property);
    if (!marker) continue;
    const multiple = marker.multiple === true || property.type === "array";
    const maxFilesRaw = Number(marker.maxFiles ?? defaults.maxFiles);
    const maxSizeRaw = Number(marker.maxSizeMB ?? defaults.maxSizeMB);
    fields.push({
      key,
      multiple,
      required: required.has(key),
      maxFiles: Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.min(Math.floor(maxFilesRaw), 20) : 1,
      maxSizeMB: Number.isFinite(maxSizeRaw) && maxSizeRaw > 0 ? Math.min(Math.floor(maxSizeRaw), 100) : undefined,
      allowedTypes: typeof marker.allowedTypes === "string" && marker.allowedTypes.trim() ? marker.allowedTypes.trim() : defaults.allowedTypes,
      legacy: property["x-contact-media"] === undefined
    });
  }
  return fields;
}

export function formHasMediaFields(form: Pick<FormRecord, "schema" | "uploadConfig">): boolean {
  return mediaFieldsFromSchema(form.schema, form.uploadConfig).length > 0;
}

export function mediaUploadPolicy(form: FormRecord, fallbackMaxFileSizeBytes: number, field?: MediaFieldConfig): MediaUploadPolicy {
  const config = normalizeUploadConfig(form.uploadConfig);
  const legacy = mediaFieldsFromSchema(form.schema, config);
  const enabled = config.enabled === true || legacy.length > 0;
  const configuredBytes = field?.maxSizeMB ? field.maxSizeMB * 1024 * 1024 : (config.maxSizeMB ? config.maxSizeMB * 1024 * 1024 : fallbackMaxFileSizeBytes);
  return {
    enabled,
    maxSizeBytes: Math.min(configuredBytes, fallbackMaxFileSizeBytes),
    maxFiles: field?.maxFiles ?? config.maxFiles ?? 1,
    allowedTypes: field?.allowedTypes || config.allowedTypes || DEFAULT_ALLOWED_TYPES
  };
}

export function allowedTypeTokens(value: string | undefined): string[] {
  return (value || DEFAULT_ALLOWED_TYPES).split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
}

export function mediaTypeAllowed(filename: string, mime: string, allowedTypes: string | undefined): boolean {
  const tokens = allowedTypeTokens(allowedTypes);
  if (!tokens.length) return true;
  const extension = normalizeExtension(filename);
  const normalizedMime = mime.toLowerCase();
  return tokens.some((token) => {
    if (token.endsWith("/*")) return normalizedMime.startsWith(token.slice(0, -1));
    if (token.startsWith(".")) return extension === token;
    return normalizedMime === token;
  });
}

/**
 * Extracts upload references from a validated submission payload. Every value
 * must be an upload ID (or a URL previously issued for this form); arbitrary
 * URLs, base64 data URLs, and object keys are rejected.
 */
export function extractMediaAttachments(form: FormRecord, payload: JsonObject): MediaAttachmentInput[] {
  const fields = mediaFieldsFromSchema(form.schema, form.uploadConfig);
  const attachments: MediaAttachmentInput[] = [];
  for (const field of fields) {
    const raw = payload[field.key];
    const values = field.multiple
      ? Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === "" ? [] : [raw]
      : raw === undefined || raw === null || raw === "" ? [] : [raw];
    if (!values.length) {
      if (field.required) throw new MediaReferenceError(`The “${field.key}” field requires an uploaded file.`);
      continue;
    }
    if (!field.multiple && values.length !== 1) throw new MediaReferenceError(`The “${field.key}” field accepts one file.`);
    if (values.length > field.maxFiles) throw new MediaReferenceError(`The “${field.key}” field accepts at most ${field.maxFiles} files.`);
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) throw new MediaReferenceError(`The “${field.key}” field contains an invalid upload reference.`);
      if (value.startsWith("data:") || value.length > 2048) throw new MediaReferenceError(`The “${field.key}” field must reference an uploaded file, not embedded file data.`);
      attachments.push({ uploadId: value.trim(), fieldKey: field.key });
    }
  }
  return attachments;
}

export function uploadResponse(input: {
  id: string;
  url: string;
  filename: string;
  mimetype: string;
  size: number;
  expiresAt: Date;
}) {
  return {
    uploadId: input.id,
    url: input.url,
    contentUrl: `/v1/admin/uploads/${input.id}/content`,
    filename: input.filename,
    mimetype: input.mimetype,
    size: input.size,
    expiresAt: input.expiresAt.toISOString()
  };
}
