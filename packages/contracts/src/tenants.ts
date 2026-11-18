import { z } from 'zod';
import { ianaTimezone } from './auth.js';

export const updateTenantRequest = z
  .object({
    name: z.string().trim().min(2).max(150),
    legalName: z.string().trim().max(200).nullable(),
    taxId: z.string().trim().max(30).nullable(),
    timezone: ianaTimezone,
    currency: z.string().length(3).toUpperCase(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Debe indicar al menos un campo' });
export type UpdateTenantRequest = z.infer<typeof updateTenantRequest>;
