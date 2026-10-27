import { expect, it } from "vitest";
import { formSlug, tenantSlug } from "../src/tenant-name.js";

it("normalizes workspace names using slugify", () => {
  expect(tenantSlug("  Acme Studio  ")).toBe("acme-studio");
  expect(tenantSlug("Café & Company")).toBe("cafe-and-company");
  expect(tenantSlug("acme-studio")).toBe("acme-studio");
  expect(tenantSlug("!!!")).toBe("");
});

it("uses the same slugify for unique form names within a tenant", () => {
  expect(formSlug("Website contact")).toBe("website-contact");
  expect(formSlug("Website Contact")).toBe("website-contact");
  expect(formSlug("website-contact")).toBe("website-contact");
});
