/**
 * Máquina de estados de una reserva (ARCHITECTURE.md §6.4).
 * Única fuente de verdad de las transiciones permitidas. Sin dependencias.
 */
export const RESERVATION_STATUSES = [
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

const TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: ReservationStatus): readonly ReservationStatus[] {
  return TRANSITIONS[from];
}

/** Estados terminales: solo una corrección excepcional (con permiso y auditoría) puede salir de ellos. */
export function isTerminal(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Solo `cancelled` libera el recurso (coincide con el trigger de BD que sincroniza `is_active`). */
export function releasesResource(status: ReservationStatus): boolean {
  return status === 'cancelled';
}
