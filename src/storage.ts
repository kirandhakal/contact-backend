import { createHash, createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import * as objectstorage from "oci-objectstorage";
import * as common from "oci-common";
import { getConfig, type AppConfig } from "./config.js";
import { sanitizeUploadFilename } from "./upload-validation.js";

let client: objectstorage.ObjectStorageClient | null = null;

function hasS3Credentials(config: AppConfig) {
  return Boolean(config.OCI_ACCESS_KEY && config.OCI_SECRET_KEY);
}

function hasApiKeyCredentials(config: AppConfig) {
  return Boolean(
    config.OCI_TENANCY_OCID &&
    config.OCI_USER_OCID &&
    config.OCI_FINGERPRINT &&
    config.OCI_SECRET_KEY?.includes("BEGIN")
  );
}

function requireStorageConfig(config: AppConfig) {
  if (!config.OCI_NAMESPACE || !config.OCI_REGION || !config.OCI_BUCKET) {
    throw new Error("OCI storage is not configured. Set OCI_NAMESPACE, OCI_REGION, and OCI_BUCKET.");
  }
  if (!hasS3Credentials(config) && !hasApiKeyCredentials(config)) {
    throw new Error("OCI storage credentials are not configured. Set OCI_ACCESS_KEY and OCI_SECRET_KEY, or provide OCI_TENANCY_OCID, OCI_USER_OCID, OCI_FINGERPRINT, and an API private key in OCI_SECRET_KEY.");
  }
}

function getClient(config: AppConfig) {
  if (client) return client;
  const provider = new common.SimpleAuthenticationDetailsProvider(
    config.OCI_TENANCY_OCID!,
    config.OCI_USER_OCID!,
    config.OCI_FINGERPRINT!,
    config.OCI_SECRET_KEY!,
    null,
    config.OCI_REGION as unknown as common.Region
  );
  client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
  return client;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function encodePath(value: string) {
  return value.split("/").map((segment) =>
    encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  ).join("/");
}

/** Object keys are generated server-side; visitor filenames only appear as a suffix. */
export function buildObjectKey(tenantId: string, formId: string, filename: string): string {
  return `uploads/${tenantId}/${formId}/${randomUUID()}-${sanitizeUploadFilename(filename)}`;
}

export function objectUrl(objectKey: string): string {
  const config = getConfig();
  return `https://objectstorage.${config.OCI_REGION}.oraclecloud.com/n/${config.OCI_NAMESPACE}/b/${config.OCI_BUCKET}/o/${encodeURIComponent(objectKey)}`;
}

async function s3Request(config: AppConfig, method: "GET" | "PUT" | "DELETE", objectKey: string, body?: Buffer, contentType?: string): Promise<Response> {
  const namespace = config.OCI_NAMESPACE!;
  const bucket = config.OCI_BUCKET!;
  const region = config.OCI_REGION!;
  const host = `${namespace}.compat.objectstorage.${region}.oraclecloud.com`;
  const path = `/${encodePath(bucket)}/${encodePath(objectKey)}`;
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const payloadHash = sha256(body ?? new Uint8Array());
  const includeContentType = method === "PUT";
  const canonicalHeaders = `${includeContentType ? `content-type:${contentType}\n` : ""}host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = `${includeContentType ? "content-type;" : ""}host;x-amz-content-sha256;x-amz-date`;
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.OCI_SECRET_KEY}`, date), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.OCI_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${host}${path}`, {
    method,
    headers: {
      Authorization: authorization,
      ...(includeContentType ? { "Content-Type": contentType! } : {}),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp
    },
    ...(body ? { body: new Uint8Array(body) } : {})
  });
}

async function streamToBuffer(value: Readable | ReadableStream): Promise<Buffer> {
  if (value instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of value) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  const reader = value.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function uploadFile(file: Buffer, objectKey: string, contentType: string): Promise<{ objectKey: string; url: string }> {
  const config = getConfig();
  requireStorageConfig(config);
  const type = contentType || "application/octet-stream";

  if (hasApiKeyCredentials(config)) {
    const objectStorageClient = getClient(config);
    await objectStorageClient.putObject({
      namespaceName: config.OCI_NAMESPACE!,
      bucketName: config.OCI_BUCKET!,
      objectName: objectKey,
      putObjectBody: file,
      contentType: type
    });
  } else {
    const response = await s3Request(config, "PUT", objectKey, file, type);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OCI upload failed (${response.status}). ${detail}`.trim());
    }
  }

  return { objectKey, url: objectUrl(objectKey) };
}

export async function deleteFile(objectKey: string): Promise<void> {
  const config = getConfig();
  requireStorageConfig(config);
  if (hasApiKeyCredentials(config)) {
    await getClient(config).deleteObject({
      namespaceName: config.OCI_NAMESPACE!,
      bucketName: config.OCI_BUCKET!,
      objectName: objectKey
    });
    return;
  }
  const response = await s3Request(config, "DELETE", objectKey);
  if (!response.ok && response.status !== 404) {
    throw new Error(`OCI delete failed (${response.status}).`);
  }
}

export async function downloadFile(objectKey: string): Promise<{ body: Buffer; contentType?: string }> {
  const config = getConfig();
  requireStorageConfig(config);
  if (hasApiKeyCredentials(config)) {
    const result = await getClient(config).getObject({
      namespaceName: config.OCI_NAMESPACE!,
      bucketName: config.OCI_BUCKET!,
      objectName: objectKey
    });
    return { body: await streamToBuffer(result.value), contentType: result.contentType };
  }
  const response = await s3Request(config, "GET", objectKey);
  if (!response.ok) throw new Error(`OCI download failed (${response.status}).`);
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? undefined
  };
}
