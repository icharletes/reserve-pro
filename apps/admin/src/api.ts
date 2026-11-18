import { ApiClient } from '@reservepro/api-client';

let onAuthLost: () => void = () => undefined;
/** El store registra aquí qué hacer cuando la sesión no puede recuperarse (evita un import circular). */
export const setAuthLostHandler = (fn: () => void): void => {
  onAuthLost = fn;
};

/** Cliente único de la app. Mismo origen (`/api/v1`): ver el proxy de Vite en desarrollo. */
export const api = new ApiClient({ baseUrl: '/api/v1', onAuthLost: () => onAuthLost() });
