import type { JSONSchemaType } from "ajv";

export type JsonObject = Record<string, unknown>;
export type DestinationKind = "email" | "webhook" | "sms" | "discord" | "slack" | "whatsapp";
export type SubmissionStatus = "accepted" | "spam" | "deleted";
export type AdminRole = "sudo" | "super" | "tenant";

export type UploadType = "single" | "multiple";

export interface UploadConfig {
  enabled?: boolean;
  maxSizeMB?: number;
  allowedTypes?: string;
  uploadType?: UploadType;
  maxFiles?: number;
}

export type UploadStatus = "pending" | "attached" | "deleted";

export interface UploadRecord {
  id: string;
  tenantId: string;
  formId: string;
  objectKey: string;
  url: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  status: UploadStatus;
  submissionId?: string;
  fieldKey?: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateUploadInput {
  tenantId: string;
  formId: string;
  objectKey: string;
  url: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface MediaAttachmentInput {
  uploadId: string;
  fieldKey: string;
}

export interface TenantLimits {
  maxOriginsPerForm: number;
  maxForms: number;
  maxTotalSubmissions: number;
  maxDailySubmissions: number;
}

export interface TenantSummary extends TenantLimits {
  id: string;
  name: string;
  formCount: number;
  totalSubmissions: number;
  dailySubmissions: number;
}

export interface TenantUsage extends TenantLimits {
  formCount: number;
  totalSubmissions: number;
  dailySubmissions: number;
}

export interface AdminRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: AdminRole;
  tenantId: string | null;
}

export interface DestinationInput {
  kind: DestinationKind;
  config: JsonObject;
  secret?: string;
}

export interface CreateFormInput {
  tenantName: string;
  tenantId?: string;
  name: string;
  allowedOrigins: string[];
  successMessage?: string;
  honeypotField?: string;
  schema: JSONSchemaType<unknown> | JsonObject;
  uploadConfig?: UploadConfig;
  destinations?: DestinationInput[];
}

export interface FormRecord {
  id: string;
  tenantId: string;
  publicKey: string;
  name: string;
  status: "active" | "disabled";
  allowedOrigins: string[];
  successMessage: string;
  honeypotField: string;
  version: number;
  schema: JsonObject;
  uploadConfig: UploadConfig;
}

export interface DestinationRecord {
  id: string;
  formId: string;
  kind: DestinationKind;
  config: JsonObject;
  secret?: string | null;
  active: boolean;
}

export interface SubmissionRecord {
  id: string;
  tenantId: string;
  formId: string;
  formVersion: number;
  payload: JsonObject;
  status: SubmissionStatus;
  sourceOrigin?: string;
  sourceIpHash: string;
  idempotencyKey?: string;
  expiresAt: string;
  createdAt: string;
}

export interface SubmissionResult {
  submission: SubmissionRecord;
  duplicate: boolean;
}

/**
 * Admin-only counts used to compare traffic between independent frontends.
 * A form has one public key, so its counts and submissions are isolated from
 * every other frontend or form type (for example, contact vs. enrolment).
 */
export interface FormSummary {
  tenantId: string;
  tenantName: string;
  publicKey: string;
  name: string;
  status: "active" | "disabled";
  allowedOrigins: string[];
  submissionCount: number;
  acceptedCount: number;
  spamCount: number;
  lastSubmittedAt?: string;
  sourceOriginCounts: Record<string, number>;
  successMessage: string;
  schema: JsonObject;
}

export interface OutboxJob {
  id: string;
  submission: SubmissionRecord;
  form: Pick<FormRecord, "id" | "name">;
  destination: DestinationRecord;
  attempts: number;
  /** Present on freshly claimed jobs; required to acknowledge ownership safely. */
  leaseId?: string;
}

export interface UploadDeletionJob {
  uploadId: string;
  objectKey: string;
  attempts: number;
  leaseId: string;
}

export interface SiteContactMessage {
  id: string;
  name: string;
  email: string;
  message: string;
  createdAt: string;
}


export type AuthPurpose = "signup" | "password_reset";
export type AuthOutcome = "ok" | "invalid" | "expired" | "locked" | "not_found" | "cooldown";

export interface StartSignupChallengeInput {
  challengeId: string;
  workspaceName: string;
  email: string;
  passwordHash: string;
  phone?: string | null;
  otpHash: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  maxAttempts: number;
  now: Date;
}

export interface StartPasswordResetChallengeInput {
  challengeId: string;
  email: string;
  otpHash: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  maxAttempts: number;
  now: Date;
}

export interface AuthChallenge {
  id: string;
  purpose: AuthPurpose;
  email: string;
  pendingSignupId: string | null;
  adminId: string | null;
  expiresAt: Date;
  resendAvailableAt: Date;
  consumedAt: Date | null;
}

export interface AuthChallengeResult {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  shouldSend: boolean;
  eligible: boolean;
}

export interface RotateAuthChallengeResult {
  status: AuthOutcome;
  email?: string;
  expiresAt?: Date;
  resendAvailableAt?: Date;
  shouldSend?: boolean;
  retryAfterSeconds?: number;
}

export interface VerifyAuthChallengeResult {
  status: AuthOutcome;
  attemptsRemaining: number;
  retryAfterSeconds: number;
  tenantId?: string;
  email?: string;
  adminId?: string;
}

export interface Store {
  saveSiteContact(input: { name: string; email: string; message: string }, key: string): Promise<void>;
  listSiteContacts(page: number, limit: number): Promise<{ messages: SiteContactMessage[]; total: number }>;
  deleteSiteContact(id: string): Promise<boolean>;
  getSiteContactDestinations(): Promise<DestinationRecord[]>;
  updateSiteContactDestinations(destinations: DestinationInput[]): Promise<void>;
  claimSiteContactJobs(limit: number, workerId?: string, leaseSeconds?: number): Promise<OutboxJob[]>;
  markSiteContactJobDelivered(id: string, leaseId: string): Promise<boolean>;
  markSiteContactJobFailed(id: string, attempts: number, error: string, leaseId: string): Promise<boolean>;
  renewSiteContactJobLease(id: string, leaseId: string, leaseSeconds: number): Promise<boolean>;
  siteContactDeliveryStatus(messageId: string): Promise<JsonObject[]>;
  findReplySubmissions(publicKey: string, filters: import("./management.js").ReplyFilters): Promise<string[]>;
  queueReplies(publicKey: string, submissionIds: string[], destinationIds: string[], message: string, requestId: string, subject?: string): Promise<number>;
  deliveryStatus(publicKey: string, submissionId: string): Promise<JsonObject[]>;
  getFormDestinations(publicKey: string): Promise<DestinationRecord[]>;
  withLoginState<T>(key: string, action: (state: import("./login-lockout.js").LoginState) => Promise<T>): Promise<T>;
  managementPage(resource: "forms" | "tenants" | "submissions", query: import("./management.js").ListQuery, publicKey?: string): Promise<import("./management.js").PageResult>;
  analytics(tenantId?: string, from?: string, to?: string): Promise<JsonObject>;
  ready(): Promise<boolean>;
  createSiteAccount(tenantName: string, email: string, passwordHash: string): Promise<{ tenantId: string }>;
  checkAuthRateLimit(key: string, windowSeconds: number, max: number, now: Date): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  startSignupChallenge(input: StartSignupChallengeInput): Promise<AuthChallengeResult>;
  startPasswordResetChallenge(input: StartPasswordResetChallengeInput): Promise<AuthChallengeResult>;
  getAuthChallenge(challengeId: string): Promise<AuthChallenge | null>;
  rotateAuthChallenge(input: {
    challengeId: string;
    otpHash: string;
    expiresAt: Date;
    resendAvailableAt: Date;
    now: Date;
  }): Promise<RotateAuthChallengeResult>;
  verifySignupChallenge(input: { challengeId: string; otpHash: string; now: Date }): Promise<VerifyAuthChallengeResult>;
  verifyPasswordResetChallenge(input: {
    challengeId: string;
    otpHash: string;
    resetTokenHash: string;
    resetTokenExpiresAt: Date;
    now: Date;
  }): Promise<VerifyAuthChallengeResult>;
  resetPasswordWithToken(input: {
    tokenHash: string;
    passwordHash: string;
    now: Date;
  }): Promise<{ email: string; adminId: string } | null>;
  deleteExpiredAuthData(now: Date): Promise<number>;
  createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord>;
  getActiveForm(publicKey: string): Promise<FormRecord | null>;
  createSubmission(args: {
    skipAutomatic?: boolean;
    form: FormRecord;
    payload: JsonObject;
    status: SubmissionStatus;
    sourceOrigin?: string;
    sourceIpHash: string;
    idempotencyKey?: string;
    accessTokenHash: string;
    expiresAt: Date;
    media?: MediaAttachmentInput[];
  }): Promise<SubmissionResult>;
  createUpload(input: CreateUploadInput): Promise<UploadRecord>;
  getUpload(uploadId: string): Promise<UploadRecord | null>;
  getUploadForForm(uploadId: string, formId: string): Promise<UploadRecord | null>;
  listUploadsForSubmission(submissionId: string): Promise<UploadRecord[]>;
  getTenantStorageBytes(tenantId: string): Promise<number>;
  deleteExpiredUploads(now: Date, limit?: number): Promise<UploadRecord[]>;
  enqueueUploadDeletion(objectKey: string): Promise<void>;
  claimUploadDeletionJobs(limit: number, workerId?: string, leaseSeconds?: number): Promise<UploadDeletionJob[]>;
  markUploadDeleted(uploadId: string, leaseId: string): Promise<boolean>;
  markUploadDeletionFailed(uploadId: string, leaseId: string, attempts: number, error: string): Promise<boolean>;
  getSubmissionByAccessToken(submissionId: string, accessTokenHash: string): Promise<{
    submission: SubmissionRecord;
    allowedOrigins: string[];
  } | null>;
  createAdmin(email: string, passwordHash: string, role: AdminRole, tenantId: string | null): Promise<void>;
  getAdminByEmail(email: string): Promise<AdminRecord | null>;
  createAdminSession(adminId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  getAdminBySession(tokenHash: string): Promise<Omit<AdminRecord, "passwordHash"> | null>;
  deleteAdminSession(tokenHash: string): Promise<void>;
  updateAdminPassword(adminId: string, passwordHash: string): Promise<void>;
  createTenant(name: string): Promise<string>;
  listTenants(): Promise<TenantSummary[]>;
  getTenantLimits(tenantId: string): Promise<TenantUsage | null>;
  updateTenantLimits(tenantId: string, limits: TenantLimits): Promise<boolean>;
  getForm(publicKey: string): Promise<FormRecord | null>;
  updateForm(publicKey: string, input: Partial<Pick<CreateFormInput, "name" | "allowedOrigins" | "successMessage" | "schema" | "destinations" | "uploadConfig">> & { status?: "active" | "disabled" }): Promise<FormRecord | null>;
  deleteForm(publicKey: string): Promise<boolean>;
  deleteSubmission(submissionId: string): Promise<boolean>;
  updateSubmission(submissionId: string, payload: JsonObject, status: SubmissionStatus): Promise<boolean>;
  getTenantIdForSubmission(submissionId: string): Promise<string | null>;
  getTenantIdForForm(publicKey: string): Promise<string | null>;
  setFormStatus(publicKey: string, status: "active" | "disabled"): Promise<boolean>;
  listSubmissions(publicKey: string, limit: number): Promise<SubmissionRecord[]>;
  listFormSummaries(): Promise<FormSummary[]>;
  claimJobs(limit: number, workerId?: string, leaseSeconds?: number): Promise<OutboxJob[]>;
  markJobDelivered(id: string, leaseId: string): Promise<boolean>;
  markJobFailed(id: string, attempts: number, error: string, leaseId: string): Promise<boolean>;
  renewJobLease(id: string, leaseId: string, leaseSeconds: number): Promise<boolean>;
  deleteExpiredSubmissions(now: Date): Promise<number>;
  close(): Promise<void>;
}
