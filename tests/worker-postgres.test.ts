import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresStore } from "../src/db/postgres-store.js";
import type { OutboxJob } from "../src/types.js";

type JobTable = "outbox" | "site";

const tableNames: Record<JobTable, string> = {
  outbox: "outbox_jobs",
  site: "site_contact_outbox_jobs"
};

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL worker leases and object deletion integration", () => {
  const schema = `worker_${randomUUID().replaceAll("-", "")}`;
  let pool: pg.Pool;
  let storeA: PostgresStore;
  let storeB: PostgresStore;
  const tenantIds: string[] = [];
  const siteMessages: string[] = [];
  const siteDestinations: string[] = [];
  const uploadIds: string[] = [];

  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const setup = new pg.Client({ connectionString: url.toString() });
    await setup.connect();
    await setup.query(`create schema ${schema}`);
    await setup.end();
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    storeA = new PostgresStore(url.toString(), "b".repeat(64));
    storeB = new PostgresStore(url.toString(), "b".repeat(64));
    for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
  });

  afterEach(async () => {
    if (uploadIds.length) await pool.query("DELETE FROM upload_deletion_jobs WHERE upload_id = ANY($1::uuid[])", [uploadIds.splice(0)]);
    if (siteMessages.length) await pool.query("DELETE FROM site_contact_messages WHERE id = ANY($1::uuid[])", [siteMessages.splice(0)]);
    if (siteDestinations.length) await pool.query("DELETE FROM site_contact_destinations WHERE id = ANY($1::uuid[])", [siteDestinations.splice(0)]);
    if (tenantIds.length) await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenantIds.splice(0)]);
  });

  afterAll(async () => {
    await storeA?.close();
    await storeB?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });

  async function createOutboxFixture(count: number) {
    const tenantId = await storeA.createTenant(`Worker ${randomUUID()}`);
    tenantIds.push(tenantId);
    const form = await storeA.createForm({
      tenantName: `Worker ${tenantId}`,
      tenantId,
      name: `Form ${randomUUID()}`,
      allowedOrigins: ["https://example.com"],
      schema: { type: "object" }
    }, `cf_${randomUUID()}`);
    const destination = await pool.query(
      "INSERT INTO destinations(form_id,kind,config,active) VALUES($1,'webhook','{}'::jsonb,true) RETURNING id",
      [form.id]
    );
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const submission = await storeA.createSubmission({
        form, payload: { index }, skipAutomatic: true, status: "accepted", sourceIpHash: "test",
        accessTokenHash: "test", expiresAt: new Date(Date.now() + 60000)
      });
      const job = await pool.query(
        "INSERT INTO outbox_jobs(submission_id,destination_id) VALUES($1,$2) RETURNING id",
        [submission.submission.id, destination.rows[0].id]
      );
      ids.push(job.rows[0].id);
    }
    return ids;
  }

  async function createSiteFixture(count: number) {
    const destination = await pool.query(
      "INSERT INTO site_contact_destinations(kind,config,active) VALUES('webhook','{}'::jsonb,true) RETURNING id"
    );
    siteDestinations.push(destination.rows[0].id);
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const message = await pool.query(
        "INSERT INTO site_contact_messages(name,email,message,idempotency_key) VALUES('Visitor','visitor@example.com',$1,$2) RETURNING id",
        [`Message ${index}`, randomUUID()]
      );
      siteMessages.push(message.rows[0].id);
      const job = await pool.query(
        "INSERT INTO site_contact_outbox_jobs(message_id,destination_id) VALUES($1,$2) RETURNING id",
        [message.rows[0].id, destination.rows[0].id]
      );
      ids.push(job.rows[0].id);
    }
    return ids;
  }

  const createFixture = (table: JobTable, count: number) => table === "outbox" ? createOutboxFixture(count) : createSiteFixture(count);

  function claim(table: JobTable, store: PostgresStore, limit: number, workerId: string, leaseSeconds = 60): Promise<OutboxJob[]> {
    return table === "outbox" ? store.claimJobs(limit, workerId, leaseSeconds) : store.claimSiteContactJobs(limit, workerId, leaseSeconds);
  }

  function markDelivered(table: JobTable, store: PostgresStore, id: string, leaseId: string): Promise<boolean> {
    return table === "outbox" ? store.markJobDelivered(id, leaseId) : store.markSiteContactJobDelivered(id, leaseId);
  }

  function markFailed(table: JobTable, store: PostgresStore, id: string, attempts: number, error: string, leaseId: string): Promise<boolean> {
    return table === "outbox" ? store.markJobFailed(id, attempts, error, leaseId) : store.markSiteContactJobFailed(id, attempts, error, leaseId);
  }

  function renew(table: JobTable, store: PostgresStore, id: string, leaseId: string, leaseSeconds: number): Promise<boolean> {
    return table === "outbox" ? store.renewJobLease(id, leaseId, leaseSeconds) : store.renewSiteContactJobLease(id, leaseId, leaseSeconds);
  }

  it.each<JobTable>(["outbox", "site"])("concurrent workers cannot claim the same %s job", async (table) => {
    const jobIds = await createFixture(table, 1);
    const [first, second] = await Promise.all([
      claim(table, storeA, 10, "worker-a"),
      claim(table, storeB, 10, "worker-b")
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(jobIds[0]);
  });

  it.each<JobTable>(["outbox", "site"])("concurrent workers can claim different %s jobs", async (table) => {
    const jobIds = await createFixture(table, 2);
    const [first, second] = await Promise.all([
      claim(table, storeA, 1, "worker-a"),
      claim(table, storeB, 1, "worker-b")
    ]);
    const ids = [...first, ...second].map((job) => job.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set(jobIds));
  });

  it.each<JobTable>(["outbox", "site"])("renews an owned %s lease and rejects a stale lease token", async (table) => {
    const [jobId] = await createFixture(table, 1);
    const [job] = await claim(table, storeA, 1, "worker-a", 60);
    await pool.query(`UPDATE ${tableNames[table]} SET lease_expires_at = now() + interval '1 second' WHERE id = $1`, [jobId]);

    expect(await renew(table, storeA, jobId, job.leaseId!, 120)).toBe(true);
    const row = await pool.query(`SELECT lease_expires_at > now() + interval '100 seconds' AS extended FROM ${tableNames[table]} WHERE id=$1`, [jobId]);
    expect(row.rows[0].extended).toBe(true);

    expect(await renew(table, storeA, jobId, randomUUID(), 120)).toBe(false);
  });

  it.each<JobTable>(["outbox", "site"])("does not steal active %s leases but recovers expired ones", async (table) => {
    const [jobId] = await createFixture(table, 1);
    const [first] = await claim(table, storeA, 1, "worker-a", 60);
    expect(first.id).toBe(jobId);

    expect(await claim(table, storeB, 1, "worker-b", 60)).toEqual([]);

    await pool.query(`UPDATE ${tableNames[table]} SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const [recovered] = await claim(table, storeB, 1, "worker-b", 60);
    expect(recovered.id).toBe(jobId);
    expect(recovered.leaseId).not.toBe(first.leaseId);

    expect(await markDelivered(table, storeA, jobId, first.leaseId!)).toBe(false);
    expect(await markFailed(table, storeA, jobId, 1, "stale worker", first.leaseId!)).toBe(false);
    const row = await pool.query(`SELECT status FROM ${tableNames[table]} WHERE id = $1`, [jobId]);
    expect(row.rows[0].status).toBe("processing");

    expect(await markDelivered(table, storeB, jobId, recovered.leaseId!)).toBe(true);
    const delivered = await pool.query(`SELECT status, lease_id, locked_by FROM ${tableNames[table]} WHERE id = $1`, [jobId]);
    expect(delivered.rows[0]).toMatchObject({ status: "delivered", lease_id: null, locked_by: null });
  });

  it.each<JobTable>(["outbox", "site"])("preserves retry backoff and dead-letter behavior for %s jobs", async (table) => {
    const [jobId] = await createFixture(table, 1);
    const [job] = await claim(table, storeA, 1, "worker-a", 60);
    expect(await markFailed(table, storeA, job.id, 1, "first failure", job.leaseId!)).toBe(true);

    let row = await pool.query(`SELECT status,attempts,last_error,available_at > now() AS delayed FROM ${tableNames[table]} WHERE id=$1`, [jobId]);
    expect(row.rows[0]).toMatchObject({ status: "failed", attempts: 1, last_error: "first failure", delayed: true });

    await pool.query(`UPDATE ${tableNames[table]} SET available_at = now() - interval '1 second' WHERE id=$1`, [jobId]);
    const [retry] = await claim(table, storeB, 1, "worker-b", 60);
    expect(retry.id).toBe(jobId);
    expect(retry.attempts).toBe(1);
    expect(await markFailed(table, storeB, retry.id, 8, "final failure", retry.leaseId!)).toBe(true);

    row = await pool.query(`SELECT status,attempts,last_error FROM ${tableNames[table]} WHERE id=$1`, [jobId]);
    expect(row.rows[0]).toEqual({ status: "dead", attempts: 8, last_error: "final failure" });
  });

  it("retries failed object deletion and records successful deletion exactly once", async () => {
    const tenantId = await storeA.createTenant(`Uploads ${randomUUID()}`);
    tenantIds.push(tenantId);
    const form = await storeA.createForm({
      tenantName: `Uploads ${tenantId}`,
      tenantId,
      name: `Uploads ${randomUUID()}`,
      allowedOrigins: ["https://example.com"],
      schema: { type: "object" }
    }, `cf_${randomUUID()}`);
    const now = new Date();
    const expired = await storeA.createUpload({
      tenantId, formId: form.id, objectKey: `uploads/${tenantId}/${form.id}/expired-${randomUUID()}.txt`,
      url: "https://example.com/expired.txt", originalFilename: "expired.txt", mimeType: "text/plain",
      sizeBytes: 1, expiresAt: new Date(now.getTime() - 1000)
    });
    const future = await storeA.createUpload({
      tenantId, formId: form.id, objectKey: `uploads/${tenantId}/${form.id}/future-${randomUUID()}.txt`,
      url: "https://example.com/future.txt", originalFilename: "future.txt", mimeType: "text/plain",
      sizeBytes: 1, expiresAt: new Date(now.getTime() + 60000)
    });
    uploadIds.push(expired.id, future.id);

    const expiredRecords = await storeA.deleteExpiredUploads(now);
    expect(expiredRecords.map((upload) => upload.id)).toEqual([expired.id]);

    const statuses = await pool.query("SELECT id,status FROM uploads WHERE id = ANY($1::uuid[])", [[expired.id, future.id]]);
    expect(statuses.rows.find((row) => row.id === expired.id)?.status).toBe("deleted");
    expect(statuses.rows.find((row) => row.id === future.id)?.status).toBe("pending");
    const jobs = await pool.query("SELECT upload_id FROM upload_deletion_jobs WHERE upload_id = ANY($1::uuid[])", [[expired.id, future.id]]);
    expect(jobs.rows.map((row) => row.upload_id)).toEqual([expired.id]);

    const [deletion] = await storeA.claimUploadDeletionJobs(10, "worker-a", 60);
    expect(deletion).toMatchObject({ uploadId: expired.id, objectKey: expired.objectKey, attempts: 0 });
    expect(await storeB.claimUploadDeletionJobs(10, "worker-b", 60)).toEqual([]);

    expect(await storeA.markUploadDeletionFailed(deletion.uploadId, deletion.leaseId, 1, "temporary storage failure")).toBe(true);
    expect(await storeA.claimUploadDeletionJobs(10, "worker-a", 60)).toEqual([]);

    await pool.query("UPDATE upload_deletion_jobs SET available_at = now() - interval '1 second' WHERE upload_id=$1", [expired.id]);
    const [retry] = await storeB.claimUploadDeletionJobs(10, "worker-b", 60);
    expect(retry).toMatchObject({ uploadId: expired.id, attempts: 1 });
    expect(await storeB.markUploadDeleted(retry.uploadId, retry.leaseId)).toBe(true);

    const recorded = await pool.query("SELECT status,attempts,last_error,deleted_at FROM upload_deletion_jobs WHERE upload_id=$1", [expired.id]);
    expect(recorded.rows[0]).toMatchObject({ status: "deleted", attempts: 1, last_error: null });
    expect(recorded.rows[0].deleted_at).toBeTruthy();

    expect(await storeA.claimUploadDeletionJobs(10, "worker-a", 60)).toEqual([]);

    await storeA.enqueueUploadDeletion("uploads/orphaned/object.txt");
    const [orphan] = await storeB.claimUploadDeletionJobs(10, "worker-b", 60);
    expect(orphan).toMatchObject({ objectKey: "uploads/orphaned/object.txt", attempts: 0 });
    expect(await storeB.markUploadDeleted(orphan.uploadId, orphan.leaseId)).toBe(true);
    await pool.query("DELETE FROM upload_deletion_jobs WHERE upload_id = $1", [orphan.uploadId]);

    await pool.query("UPDATE uploads SET status = 'deleted' WHERE id = $1", [future.id]);
    const legacyCleanup = await pool.query("SELECT object_key FROM upload_deletion_jobs WHERE upload_id = $1", [future.id]);
    expect(legacyCleanup.rows[0]?.object_key).toBe(future.objectKey);

    expect(await storeA.deleteExpiredUploads(now)).toEqual([]);
  });

  it("deletes attached uploads when their submission expires", async () => {
    const tenantId = await storeA.createTenant(`Expiry ${randomUUID()}`);
    tenantIds.push(tenantId);
    const form = await storeA.createForm({
      tenantName: `Expiry ${tenantId}`,
      tenantId,
      name: `Expiry ${randomUUID()}`,
      allowedOrigins: ["https://example.com"],
      schema: { type: "object" }
    }, `cf_${randomUUID()}`);
    const upload = await storeA.createUpload({
      tenantId, formId: form.id, objectKey: `uploads/${tenantId}/${form.id}/attached-${randomUUID()}.txt`,
      url: "https://example.com/attached.txt", originalFilename: "attached.txt", mimeType: "text/plain",
      sizeBytes: 1, expiresAt: new Date(Date.now() + 60000)
    });
    uploadIds.push(upload.id);

    const { submission } = await storeA.createSubmission({
      form,
      payload: { attachment: upload.id },
      skipAutomatic: true,
      status: "accepted",
      sourceIpHash: "test",
      accessTokenHash: "test",
      expiresAt: new Date(Date.now() + 60000),
      media: [{ uploadId: upload.id, fieldKey: "attachment" }]
    });

    const attached = await pool.query("SELECT status FROM uploads WHERE id=$1", [upload.id]);
    expect(attached.rows[0].status).toBe("attached");

    await pool.query("UPDATE submissions SET expires_at = now() - interval '1 second' WHERE id=$1", [submission.id]);
    expect(await storeA.deleteExpiredSubmissions(new Date())).toBe(1);

    const after = await pool.query("SELECT status FROM uploads WHERE id=$1", [upload.id]);
    expect(after.rows[0].status).toBe("deleted");
    const queued = await pool.query("SELECT object_key FROM upload_deletion_jobs WHERE upload_id=$1", [upload.id]);
    expect(queued.rows[0]?.object_key).toBe(upload.objectKey);
  });

  it("dead-letters object deletion after repeated failures", async () => {
    const tenantId = await storeA.createTenant(`Dead ${randomUUID()}`);
    tenantIds.push(tenantId);
    const form = await storeA.createForm({
      tenantName: `Dead ${tenantId}`,
      tenantId,
      name: `Dead ${randomUUID()}`,
      allowedOrigins: ["https://example.com"],
      schema: { type: "object" }
    }, `cf_${randomUUID()}`);
    const upload = await storeA.createUpload({
      tenantId, formId: form.id, objectKey: `uploads/${tenantId}/${form.id}/dead-${randomUUID()}.txt`,
      url: "https://example.com/dead.txt", originalFilename: "dead.txt", mimeType: "text/plain",
      sizeBytes: 1, expiresAt: new Date(Date.now() - 1000)
    });
    uploadIds.push(upload.id);

    expect((await storeA.deleteExpiredUploads(new Date())).map((record) => record.id)).toContain(upload.id);
    const [job] = await storeA.claimUploadDeletionJobs(10, "worker-a", 60);
    expect(job.uploadId).toBe(upload.id);

    expect(await storeA.markUploadDeletionFailed(job.uploadId, job.leaseId, 8, "permanent storage failure")).toBe(true);
    const row = await pool.query("SELECT status,attempts,last_error FROM upload_deletion_jobs WHERE upload_id=$1", [upload.id]);
    expect(row.rows[0]).toMatchObject({ status: "dead", attempts: 8, last_error: "permanent storage failure" });
    expect(await storeA.claimUploadDeletionJobs(10, "worker-a", 60)).toEqual([]);
  });
});
