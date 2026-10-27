import { z } from "zod";
export const fieldFilters = z.record(z.string().min(1).max(80), z.array(z.string().max(500)).min(1).max(50)).refine(v => Object.keys(v).length <= 20);
export const replyFilters = z.object({ q: z.string().max(200).default(""), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), fields: fieldFilters.optional() }).strict().refine(v => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to));
export type ReplyFilters = z.infer<typeof replyFilters>;

export function payloadConditions(fields: Record<string, string[]> | undefined, bind: (v: unknown) => string): string[] {
  return Object.entries(fields ?? {}).map(([key, values]) => {
    const field = bind(key); const options = bind(values);
    return `(s.payload->>${field}=ANY(${options}::text[]) OR (jsonb_typeof(s.payload->${field})='array' AND s.payload->${field} ?| ${options}::text[]))`;
  });
}

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().max(200).default(""),
  fields: z.string().max(20000).transform((v, ctx) => { try { return fieldFilters.parse(JSON.parse(v)); } catch { ctx.addIssue({ code: "custom", message: "Invalid field filters" }); return z.NEVER; } }).optional(),
  status: z.enum(["active", "disabled", "accepted", "spam", "inactive"]).optional(),
  tenantId: z.string().uuid().optional(),
  formKey: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(["newest", "oldest", "most-used", "name"]).default("newest"),
}).refine(v => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), "from must precede to");
export type ListQuery = z.infer<typeof listQuery>;
export type PageResult = { items: Record<string, unknown>[]; pagination: { page: number; limit: number; total: number; pages: number } };
