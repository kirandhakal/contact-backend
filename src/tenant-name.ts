import slugify from "slugify";

export function tenantSlug(name: string): string {
  return slugify(name.normalize("NFKC"), { lower: true, strict: true, trim: true });
}
