import { expect, it } from "vitest";
import { tenantSlug } from "../src/tenant-name.js";

it("normalizes workspace names using slugify", () => {
  expect(tenantSlug("  Acme Studio  ")).toBe("acme-studio");
  expect(tenantSlug("Café & Company")).toBe("cafe-and-company");
  expect(tenantSlug("acme-studio")).toBe("acme-studio");
  expect(tenantSlug("!!!")).toBe("");
});
