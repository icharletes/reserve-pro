/**
 * Lee el token del fragmento de la URL (`#token=…`) y lo BORRA de la barra de direcciones y del historial.
 * Higiene: el token no debe quedar visible, copiable por error ni en el historial del navegador.
 * (El fragmento ya nunca viajó al servidor; esto protege la copia local.)
 */
export function takeFragmentToken(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = params.get('token');
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return token && token.length >= 20 ? token : null;
}
