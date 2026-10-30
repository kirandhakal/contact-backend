import { createHash, createHmac } from "node:crypto";
import * as objectstorage from "oci-objectstorage";
import * as common from "oci-common";
import { getConfig, type AppConfig } from "./config.js";

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

async function uploadWithS3Compatibility(config: AppConfig, body: Buffer, objectName: string, contentType: string) {
  const namespace = config.OCI_NAMESPACE!;
  const bucket = config.OCI_BUCKET!;
  const region = config.OCI_REGION!;
  const host = `${namespace}.compat.objectstorage.${region}.oraclecloud.com`;
  const path = `/${encodePath(bucket)}/${encodePath(objectName)}`;
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.OCI_SECRET_KEY}`, date), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.OCI_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`https://${host}${path}`, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp
    },
    body: new Uint8Array(body)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OCI upload failed (${response.status}). ${detail}`.trim());
  }
}

async function uploadWithApiKey(config: AppConfig, body: Buffer, objectName: string, contentType: string) {
  const objectStorageClient = getClient(config);
  await objectStorageClient.putObject({
    namespaceName: config.OCI_NAMESPACE!,
    bucketName: config.OCI_BUCKET!,
    objectName,
    putObjectBody: body,
    contentType
  });
}

export async function uploadFile(file: Buffer, fileName: string, contentType: string): Promise<string> {
  const config = getConfig();
  requireStorageConfig(config);

  const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2)}-${fileName.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
  const type = contentType || "application/octet-stream";

  if (hasApiKeyCredentials(config)) {
    await uploadWithApiKey(config, file, uniqueFileName, type);
  } else {
    await uploadWithS3Compatibility(config, file, uniqueFileName, type);
  }

  return `https://objectstorage.${config.OCI_REGION}.oraclecloud.com/n/${config.OCI_NAMESPACE}/b/${config.OCI_BUCKET}/o/${encodeURIComponent(uniqueFileName)}`;
}
