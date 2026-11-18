import { z } from 'zod';
import { authResponse, password } from './auth.js';
import { uuid } from './common.js';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Email inválido'));

export const MEMBER_STATUSES = ['active', 'disabled'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

// --- Invitaciones (lado empresa) ---------------------------------------------------------------
export const createInvitationRequest = z.object({
  email,
  /** Clave del rol de la empresa (owner, admin, manager, receptionist, professional…). */
  roleKey: z.string().min(1).max(50),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequest>;

export const invitationView = z.object({
  id: uuid,
  email: z.string(),
  roleKey: z.string(),
  roleName: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
  createdAt: z.string(),
});
export type InvitationView = z.infer<typeof invitationView>;

export const createInvitationResponse = z.object({
  invitation: invitationView,
  /** false si el email no pudo enviarse: la invitación existe y puede reenviarse. */
  emailSent: z.boolean(),
});
export type CreateInvitationResponse = z.infer<typeof createInvitationResponse>;

// --- Invitaciones (lado invitado; públicas, el token va en el CUERPO para no quedar en logs de acceso) ---
export const invitationTokenRequest = z.object({ token: z.string().min(20).max(200) });
export type InvitationTokenRequest = z.infer<typeof invitationTokenRequest>;

export const invitationPreview = z.object({
  tenantName: z.string(),
  roleName: z.string(),
  email: z.string(),
  /** true si ya existe una cuenta con ese email (solo debe confirmar); false si debe crear nombre y contraseña. */
  accountExists: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreview>;

export const acceptInvitationRequest = z.object({
  token: z.string().min(20).max(200),
  /** Solo si el invitado aún no tiene cuenta. */
  fullName: z.string().trim().min(2).max(150).optional(),
  password: password.optional(),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequest>;

export const acceptInvitationResponse = z.object({
  /** account_created: se creó la cuenta y se inició sesión; joined: la cuenta ya existía, debe iniciar sesión. */
  outcome: z.enum(['account_created', 'joined']),
  tenantName: z.string(),
  auth: authResponse.optional(),
});
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponse>;

// --- Miembros ----------------------------------------------------------------------------------
export const memberView = z.object({
  membershipId: uuid,
  userId: uuid,
  email: z.string(),
  fullName: z.string(),
  status: z.enum(MEMBER_STATUSES),
  roles: z.array(z.object({ key: z.string(), name: z.string() })),
  createdAt: z.string(),
});
export type MemberView = z.infer<typeof memberView>;

export const updateMemberRequest = z
  .object({
    status: z.enum(MEMBER_STATUSES),
    /** Reemplaza TODOS los roles del miembro. Debe contener al menos uno. */
    roleKeys: z.array(z.string().min(1).max(50)).min(1).max(5),
  })
  .partial()
  .refine((v) => v.status !== undefined || v.roleKeys !== undefined, { message: 'Debe indicar status o roleKeys' });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequest>;

export const roleView = z.object({
  key: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});
export type RoleView = z.infer<typeof roleView>;
