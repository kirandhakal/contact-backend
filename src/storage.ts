import * as objectstorage from "oci-objectstorage";
import * as common from "oci-common";
import { getConfig } from "./config.js";

let client: objectstorage.ObjectStorageClient | null = null;

function getClient() {
  if (client) return client;
  const config = getConfig();
  if (!config.OCI_ACCESS_KEY || !config.OCI_SECRET_KEY || !config.OCI_NAMESPACE || !config.OCI_REGION || !config.OCI_BUCKET) {
    throw new Error("OCI storage is not configured");
  }
  try {
    const provider = new common.SimpleAuthenticationDetailsProvider(
      config.OCI_TENANCY_OCID || "tenant",
      config.OCI_USER_OCID || "user",
      config.OCI_FINGERPRINT || "fingerprint",
      config.OCI_SECRET_KEY,
      null,
      (config.OCI_REGION as unknown) as common.Region
    );
    client = new objectstorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
  } catch {
    client = new objectstorage.ObjectStorageClient({
      authenticationDetailsProvider: new common.ConfigFileAuthenticationDetailsProvider()
    } as any);
  }
  return client;
}

export async function uploadFile(file: Buffer, fileName: string, contentType: string): Promise<string> {
  const config = getConfig();
  const objectStorageClient = getClient();
  const namespace = config.OCI_NAMESPACE!;
  const bucketName = config.OCI_BUCKET!;
  
  const uniqueFileName = `${Date.now()}-${Math.random().toString(36).substring(2)}-${fileName.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
  
  const putObjectRequest: objectstorage.requests.PutObjectRequest = {
    namespaceName: namespace,
    bucketName: bucketName,
    objectName: uniqueFileName,
    putObjectBody: file,
    contentType: contentType,
  };
  
  try {
    await objectStorageClient.putObject(putObjectRequest);
    return `https://objectstorage.${config.OCI_REGION}.oraclecloud.com/n/${namespace}/b/${bucketName}/o/${encodeURIComponent(uniqueFileName)}`;
  } catch (error) {
    throw error;
  }
}
