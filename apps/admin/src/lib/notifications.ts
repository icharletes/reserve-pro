import type { NotificationView } from '@reservepro/contracts';

export const NOTIFICATION_STATUS_LABELS: Record<NotificationView['status'], string> = {
  queued: 'En cola',
  sending: 'Enviando',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Falló',
  suppressed: 'No enviado (sin consentimiento)',
};

const TYPE_LABELS: Record<string, string> = {
  'reservation.created_confirmed': 'Reserva confirmada',
  'reservation.created_pending': 'Solicitud recibida',
  'reservation.confirmed': 'Confirmada por el negocio',
  'reservation.rescheduled': 'Cambio de horario',
  'reservation.cancelled': 'Cancelación',
  'reservation.expired': 'Solicitud vencida',
  'reservation.reminder': 'Recordatorio',
};

export const notificationTypeLabel = (type: string): string => TYPE_LABELS[type] ?? type;
