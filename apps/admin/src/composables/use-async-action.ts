import { ApiError } from '@reservepro/api-client';
import { ref } from 'vue';
import { describeError } from '../lib/errors';

/**
 * Envuelve una acción asíncrona de formulario: evita el doble envío (`loading`), y expone el mensaje de error
 * general y los errores por campo de la API.
 */
export function useAsyncAction() {
  const loading = ref(false);
  const error = ref<string | null>(null);
  const fieldErrors = ref<Record<string, string>>({});

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (loading.value) return undefined; // ya hay un envío en curso
    loading.value = true;
    error.value = null;
    fieldErrors.value = {};
    try {
      return await action();
    } catch (e) {
      if (e instanceof ApiError && e.errors.length > 0) {
        fieldErrors.value = Object.fromEntries(e.errors.map((f) => [f.path, f.message]));
        error.value = 'Revisa los campos marcados.';
      } else {
        error.value = describeError(e);
      }
      return undefined;
    } finally {
      loading.value = false;
    }
  }
  return { loading, error, fieldErrors, run };
}
