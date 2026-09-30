import { z } from "zod";

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).default(""),
  status: z.enum(["active", "disabled", "accepted", "spam", "inactive"]).optional(),
  tenantId: z.string().uuid().optional(),
  formKey: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(["newest", "oldest", "most-used", "name"]).default("newest"),
}).refine(v => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), "from must precede to");
export type ListQuery = z.infer<typeof listQuery>;
export type PageResult = { items: Record<string, unknown>[]; pagination: { page: number; limit: number; total: number; pages: number } };
