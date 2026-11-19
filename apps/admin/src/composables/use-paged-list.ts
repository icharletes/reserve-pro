import { type Ref, ref } from 'vue';
import { describeError } from '../lib/errors';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Lista paginada por cursor con estado de carga y error. `reload()` vuelve a la primera página (tras crear,
 * editar o borrar); `more()` agrega la siguiente.
 */
export function usePagedList<T>(fetchPage: (cursor?: string) => Promise<Page<T>>) {
  const items = ref([]) as Ref<T[]>;
  const nextCursor = ref<string | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(cursor?: string): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = null;
    try {
      const page = await fetchPage(cursor);
      items.value = cursor ? [...items.value, ...page.items] : page.items;
      nextCursor.value = page.nextCursor;
    } catch (e) {
      error.value = describeError(e);
    } finally {
      loading.value = false;
    }
  }

  return {
    items,
    nextCursor,
    loading,
    error,
    reload: () => load(),
    more: () => (nextCursor.value ? load(nextCursor.value) : Promise.resolve()),
  };
}
