import slugify from "slugify";

/** Normalize workspace and form names. Form names are unique per tenant by this slug. */
export function tenantSlug(name: string): string {
  return slugify(name.normalize("NFKC"), { lower: true, strict: true, trim: true });
}

export const formSlug = tenantSlug;
