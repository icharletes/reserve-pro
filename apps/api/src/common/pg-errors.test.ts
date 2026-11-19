import { describe, expect, it } from 'vitest';
import { isRetryable, isUniqueViolation, pgCode } from './pg-errors.js';

// Forma real observada con Prisma 7.10 + @prisma/adapter-pg ante una violación del EXCLUDE.
const prismaWrapped = (sqlstate: string, prismaCode = 'P2039') => ({
  name: 'PrismaClientKnownRequestError',
  code: prismaCode,
  clientVersion: '7.10.1',
  meta: {
    driverAdapterError: {
      name: 'DriverAdapterError',
      cause: { originalCode: sqlstate, code: sqlstate },
    },
  },
});

describe('pgCode', () => {
  it('lee el SQLSTATE original de un error de Prisma, no su código propio', () => {
    expect(pgCode(prismaWrapped('23P01'))).toBe('23P01');
    expect(pgCode({ code: 'P2039', clientVersion: '7.10.1' })).toBeUndefined();
  });
  it('lee el SQLSTATE de un error de pg, también anidado en cause', () => {
    expect(pgCode({ code: '23505', severity: 'ERROR' })).toBe('23505');
    expect(pgCode(new Error('x', { cause: { code: '40P01' } }))).toBe('40P01');
    expect(pgCode(new Error('sin código'))).toBeUndefined();
    expect(pgCode(null)).toBeUndefined();
  });
  it('clasifica reintentables y unicidad', () => {
    expect(isRetryable(prismaWrapped('40P01'))).toBe(true);
    expect(isRetryable({ code: 'P2034', clientVersion: '7' })).toBe(true);
    expect(isRetryable(prismaWrapped('23P01'))).toBe(false);
    expect(isUniqueViolation({ code: 'P2002', clientVersion: '7' })).toBe(true);
    expect(isUniqueViolation(prismaWrapped('23505'))).toBe(true);
  });
});
