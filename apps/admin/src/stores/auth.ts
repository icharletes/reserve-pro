import type {
  AuthResponse,
  MeResponse,
  MembershipSummary,
  PermissionKey,
} from '@reservepro/contracts';
import { defineStore } from 'pinia';
import { api, setAuthLostHandler } from '../api';

/** Promesa del bootstrap (fuera del estado: no es reactiva ni se serializa). Una sola ejecución por app. */
let bootstrapPromise: Promise<void> | null = null;

interface State {
  /** true cuando ya se intentó restaurar la sesión al abrir la app (evita parpadeos y redirecciones prematuras). */
  ready: boolean;
  user: AuthResponse['user'] | null;
  memberships: MembershipSummary[];
  activeTenantId: string | null;
  me: MeResponse | null;
}

/** Solo para pruebas: permite simular una app recién abierta. */
export const resetBootstrapForTests = (): void => {
  bootstrapPromise = null;
};

export const useAuthStore = defineStore('auth', {
  state: (): State => ({
    ready: false,
    user: null,
    memberships: [],
    activeTenantId: null,
    me: null,
  }),

  getters: {
    isAuthenticated: (s) => s.user !== null,
    hasTenant: (s) => s.activeTenantId !== null,
    activeMembership: (s) => s.memberships.find((m) => m.tenantId === s.activeTenantId) ?? null,
    /** Solo para MOSTRAR u ocultar acciones. La autorización real la aplica siempre el backend. */
    can: (s) => (permission: PermissionKey) => s.me?.permissions.includes(permission) ?? false,
  },

  actions: {
    /** Restaura la sesión a partir de la cookie HttpOnly. Se ejecuta UNA vez; las demás llamadas esperan la misma promesa. */
    bootstrap(): Promise<void> {
      bootstrapPromise ??= (async () => {
        setAuthLostHandler(() => this.clear());
        try {
          const auth = await api.restoreSession();
          if (auth) await this.apply(auth);
        } catch {
          // API caída o respuesta inesperada al abrir la app: se degrada a "sin sesión" (muestra el login).
          // Lanzar aquí dejaría la navegación colgada y la pantalla en blanco.
          this.clear();
        } finally {
          this.ready = true;
        }
      })();
      return bootstrapPromise;
    },

    async apply(auth: AuthResponse): Promise<void> {
      this.user = auth.user;
      this.memberships = auth.memberships;
      this.activeTenantId = auth.activeTenantId;
      this.me = auth.activeTenantId ? await api.me() : null;
    },

    async login(email: string, password: string, tenantId?: string): Promise<void> {
      await this.apply(await api.login({ email, password, ...(tenantId ? { tenantId } : {}) }));
    },

    async register(input: Parameters<typeof api.register>[0]): Promise<void> {
      await this.apply(await api.register(input));
    },

    async switchTenant(tenantId: string): Promise<void> {
      await this.apply(await api.switchTenant(tenantId));
    },

    /** Vuelve a leer el usuario (p.ej. tras verificar el email). */
    async refreshMe(): Promise<void> {
      this.me = await api.me();
      if (this.user) this.user = { ...this.user, emailVerified: this.me.user.emailVerified };
    },

    async logout(): Promise<void> {
      try {
        await api.logout();
      } finally {
        this.clear();
      }
    },

    clear(): void {
      this.user = null;
      this.memberships = [];
      this.activeTenantId = null;
      this.me = null;
    },
  },
});
