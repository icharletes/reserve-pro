const PHONE_SEPARATORS = /[\s().-]/g;
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Teléfono escrito por una persona a E.164 (+56912345678). Sin prefijo internacional se asume el del país por
 * defecto. Devuelve null si no parece un número válido. La usan el panel y el portal; el servidor vuelve a validar.
 */
export function normalizePhone(input: string, defaultCountryCode = '56'): string | null {
  const raw = input.trim().replace(PHONE_SEPARATORS, '');
  if (raw === '') return null;
  let e164: string;
  if (raw.startsWith('+')) e164 = raw;
  else if (raw.startsWith('00')) e164 = `+${raw.slice(2)}`;
  else if (raw.startsWith(defaultCountryCode) && raw.length > defaultCountryCode.length + 8)
    e164 = `+${raw}`;
  else e164 = `+${defaultCountryCode}${raw.replace(/^0+/, '')}`;
  return E164.test(e164) ? e164 : null;
}
