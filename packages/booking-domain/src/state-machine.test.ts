import { describe, expect, it } from 'vitest';
import {
  RESERVATION_STATUSES,
  allowedTransitions,
  canTransition,
  isTerminal,
  releasesResource,
} from './state-machine.js';

describe('reservation state machine', () => {
  it('permite las transiciones definidas', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true);
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('confirmed', 'in_progress')).toBe(true);
    expect(canTransition('confirmed', 'no_show')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('rechaza transiciones arbitrarias', () => {
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('pending', 'no_show')).toBe(false);
    expect(canTransition('in_progress', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
  });

  it('ningún estado transiciona a sí mismo', () => {
    for (const s of RESERVATION_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it('los estados terminales no tienen salidas', () => {
    for (const s of ['completed', 'cancelled', 'no_show'] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(allowedTransitions(s)).toHaveLength(0);
    }
    expect(isTerminal('pending')).toBe(false);
  });

  it('solo cancelled libera el recurso', () => {
    const releasing = RESERVATION_STATUSES.filter(releasesResource);
    expect(releasing).toEqual(['cancelled']);
  });
});
