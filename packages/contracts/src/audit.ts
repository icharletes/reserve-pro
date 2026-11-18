import { z } from 'zod';
import { uuid } from './common.js';

export const auditQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().max(100).optional(),
  entityType: z.string().max(60).optional(),
  entityId: uuid.optional(),
  actorId: uuid.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;

export const auditLogView = z.object({
  id: uuid,
  action: z.string(),
  entityType: z.string(),
  entityId: uuid.nullable(),
  actorType: z.string(),
  actorId: uuid.nullable(),
  actorName: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditLogView = z.infer<typeof auditLogView>;
