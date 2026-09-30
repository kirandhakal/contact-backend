import { hashPassword } from "../admin-auth.js";
import { getConfig } from "../config.js";
import { PostgresStore } from "./postgres-store.js";

const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;

async function main() {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length < 8 || password.length > 256) {
    throw new Error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (8–256 characters) before seeding an administrator.");
  }
  const config = getConfig();
  const store = new PostgresStore(config.DATABASE_URL);
  try {
    const existing = await store.getAdminByEmail(email);
    if (existing) {
      console.log(`Admin ${email} already exists; no changes made.`);
      return;
    }
    await store.createAdmin(email, await hashPassword(password), "sudo", null);
    console.log(`Created sudo admin: ${email}`);
    console.log("Change the seeded password after the first login.");
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
