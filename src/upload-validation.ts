import { extname } from "node:path";

export type AllowedMedia = {
  mime: string;
  extensions: string[];
  /** Return true when the buffer matches this type's magic bytes. */
  matches: (buffer: Buffer) => boolean;
};

const ZIP_LOCAL_FILE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_COMPOUND = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function startsWith(buffer: Buffer, signature: number[] | Buffer, offset = 0): boolean {
  const bytes = Buffer.isBuffer(signature) ? signature : Buffer.from(signature);
  if (buffer.length < offset + bytes.length) return false;
  return buffer.subarray(offset, offset + bytes.length).equals(bytes);
}

function includesAscii(buffer: Buffer, value: string, start: number, end: number): boolean {
  const slice = buffer.subarray(start, Math.min(end, buffer.length)).toString("latin1");
  return slice.includes(value);
}

/** Media types already used by the form builder / preview. */
export const ALLOWED_MEDIA: AllowedMedia[] = [
  {
    mime: "image/jpeg",
    extensions: [".jpg", ".jpeg"],
    matches: (buffer) => startsWith(buffer, [0xff, 0xd8, 0xff])
  },
  {
    mime: "image/png",
    extensions: [".png"],
    matches: (buffer) => startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  },
  {
    mime: "image/gif",
    extensions: [".gif"],
    matches: (buffer) => startsWith(buffer, Buffer.from("GIF87a")) || startsWith(buffer, Buffer.from("GIF89a"))
  },
  {
    mime: "image/webp",
    extensions: [".webp"],
    matches: (buffer) => startsWith(buffer, Buffer.from("RIFF")) && includesAscii(buffer, "WEBP", 8, 12)
  },
  {
    mime: "application/pdf",
    extensions: [".pdf"],
    matches: (buffer) => startsWith(buffer, Buffer.from("%PDF-"))
  },
  {
    mime: "application/msword",
    extensions: [".doc"],
    matches: (buffer) => startsWith(buffer, OLE_COMPOUND)
  },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    matches: (buffer) => startsWith(buffer, ZIP_LOCAL_FILE)
  },
  {
    mime: "audio/mpeg",
    extensions: [".mp3"],
    matches: (buffer) => startsWith(buffer, Buffer.from("ID3")) || startsWith(buffer, [0xff, 0xfb]) || startsWith(buffer, [0xff, 0xf3]) || startsWith(buffer, [0xff, 0xf2])
  },
  {
    mime: "audio/wav",
    extensions: [".wav"],
    matches: (buffer) => startsWith(buffer, Buffer.from("RIFF")) && includesAscii(buffer, "WAVE", 8, 12)
  },
  {
    mime: "audio/ogg",
    extensions: [".ogg"],
    matches: (buffer) => startsWith(buffer, Buffer.from("OggS"))
  },
  {
    mime: "audio/mp4",
    extensions: [".m4a", ".aac"],
    matches: (buffer) => includesAscii(buffer, "ftyp", 4, 12)
  },
  {
    mime: "audio/flac",
    extensions: [".flac"],
    matches: (buffer) => startsWith(buffer, Buffer.from("fLaC"))
  },
  {
    mime: "video/mp4",
    extensions: [".mp4", ".m4v", ".mov"],
    matches: (buffer) => includesAscii(buffer, "ftyp", 4, 12)
  },
  {
    mime: "video/webm",
    extensions: [".webm"],
    matches: (buffer) => startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])
  }
];

const MIME_BY_EXTENSION = new Map<string, AllowedMedia>();
for (const media of ALLOWED_MEDIA) {
  for (const extension of media.extensions) {
    MIME_BY_EXTENSION.set(extension, media);
  }
}

export function sanitizeUploadFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "upload";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 180) || "upload";
}

export function normalizeExtension(filename: string): string {
  return extname(filename).toLowerCase();
}

export type UploadValidationResult =
  | { ok: true; mime: string; filename: string }
  | { ok: false; status: 400 | 413; title: string; detail: string; code: string };

export function validateUploadedFile(input: {
  filename: string;
  mimetype: string;
  buffer: Buffer;
  maxFileSizeBytes: number;
}): UploadValidationResult {
  if (!input.buffer.length) {
    return { ok: false, status: 400, title: "Bad request", detail: "Uploaded file is empty.", code: "EMPTY_FILE" };
  }
  if (input.buffer.length > input.maxFileSizeBytes) {
    return {
      ok: false,
      status: 413,
      title: "Payload too large",
      detail: "Uploaded file exceeds the configured maximum size.",
      code: "FILE_TOO_LARGE"
    };
  }

  const filename = sanitizeUploadFilename(input.filename || "upload");
  const extension = normalizeExtension(filename);
  const declared = (input.mimetype || "").toLowerCase().split(";")[0].trim();
  const byExtension = MIME_BY_EXTENSION.get(extension);
  if (!byExtension) {
    return {
      ok: false,
      status: 400,
      title: "Unsupported file type",
      detail: "This file extension is not allowed.",
      code: "UNSUPPORTED_FILE_TYPE"
    };
  }

  const magicMatches = ALLOWED_MEDIA.filter((media) => media.matches(input.buffer));
  if (!magicMatches.length) {
    return {
      ok: false,
      status: 400,
      title: "Unsupported file type",
      detail: "File contents do not match an allowed media type.",
      code: "UNSUPPORTED_FILE_TYPE"
    };
  }

  // Prefer the media type that matches both magic bytes and the declared extension
  // (ISO BMFF containers like mp4/m4a/mov share the same `ftyp` signature).
  const byMagic =
    magicMatches.find((media) => media.extensions.includes(extension)) ??
    magicMatches.find((media) => media.mime === byExtension.mime) ??
    magicMatches[0];

  if (!magicMatches.some((media) => media.mime === byExtension.mime || media.extensions.includes(extension))) {
    return {
      ok: false,
      status: 400,
      title: "Unsupported file type",
      detail: "File extension does not match file contents.",
      code: "UNSUPPORTED_FILE_TYPE"
    };
  }

  const declaredMatch =
    !declared ||
    declared === "application/octet-stream" ||
    declared === byMagic.mime ||
    declared === byExtension.mime ||
    (declared.startsWith("image/") && byMagic.mime.startsWith("image/")) ||
    (declared.startsWith("audio/") && byMagic.mime.startsWith("audio/")) ||
    (declared.startsWith("video/") && byMagic.mime.startsWith("video/"));

  if (!declaredMatch) {
    return {
      ok: false,
      status: 400,
      title: "Unsupported file type",
      detail: "Declared content type does not match file contents.",
      code: "UNSUPPORTED_FILE_TYPE"
    };
  }

  return { ok: true, mime: byExtension.mime, filename };
}
