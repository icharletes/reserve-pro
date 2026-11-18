import { describe, expect, it } from 'vitest';
import { phoneE164, tenantSlug } from './common.js';

describe('phoneE164', () => {
  it('acepta números internacionales válidos', () => {
    expect(phoneE164.safeParse('+56912345678').success).toBe(true);
  });
  it('rechaza números sin + o con ceros iniciales', () => {
    expect(phoneE164.safeParse('56912345678').success).toBe(false);
    expect(phoneE164.safeParse('+0912345678').success).toBe(false);
    expect(phoneE164.safeParse('+56 9 1234 5678').success).toBe(false);
  });
});

describe('tenantSlug', () => {
  it('acepta slugs válidos', () => {
    expect(tenantSlug.safeParse('mi-peluqueria').success).toBe(true);
  });
  it('rechaza mayúsculas, guiones en los extremos y longitud insuficiente', () => {
    expect(tenantSlug.safeParse('MiPeluqueria').success).toBe(false);
    expect(tenantSlug.safeParse('-abc').success).toBe(false);
    expect(tenantSlug.safeParse('ab').success).toBe(false);
  });
});
