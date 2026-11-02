import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, borrarAcceso, leerAcceso, logout as logoutApi, refrescar } from './api';
import type { Dataset, NavGrupo, Rol } from './types';
import { Acceso } from '@/modules/auth/Acceso';

interface Yo {
  usuario: { id: string; nombre: string; fotoUrl?: string | null };
  rol: Rol;
  permisos: string[];
  navegacion: NavGrupo[];
}

interface Estado {
  dataset: Dataset;
  rol: Rol;
  sesion: { usuario: { id: string; nombre: string; fotoUrl?: string | null }; rolId: string };
  permisos: string[];
  navegacion: NavGrupo[];
  navegacionVisible: NavGrupo[];
  puede: (permiso: string) => boolean;
  cerrarSesion: () => Promise<void>;
  refrescarDatos: () => Promise<void>;
  /** Vuelve a pedir /auth/yo (tras cambiar nombre, foto o permisos). */
  recargarSesion: () => Promise<void>;
}

const Ctx = createContext<Estado | null>(null);

type Fase =
  | { tipo: 'cargando' }
  | { tipo: 'sin-sesion' }
  | { tipo: 'listo'; yo: Yo; dataset: Dataset };

export function AppProvider({ children }: { children: ReactNode }) {
  const [fase, setFase] = useState<Fase>({ tipo: 'cargando' });

  const cargar = useCallback(async () => {
    // Atajo de desarrollo para revisar pantallas: /?usuario=x&clave=y.
    // Solo existe en el servidor de desarrollo; en el build de producción no se compila.
    if (import.meta.env.DEV && !leerAcceso()) {
      const p = new URLSearchParams(window.location.search);
      const u = p.get('usuario');
      const c = p.get('clave');
      // Las credenciales no quedan en la barra ni en el historial del navegador.
      if (u || c) window.history.replaceState(null, '', window.location.pathname);
      if (u && c) {
        try {
          const { login } = await import('./api');
          const r = await login(u, c);
          // Si el perfil pide segundo factor, se deja que la pantalla de acceso lo resuelva.
          if (!('accessToken' in r)) {
            setFase({ tipo: 'sin-sesion' });
            return;
          }
        } catch { /* se muestra el login normal */ }
      }
    }
    if (!leerAcceso() && !(await refrescar())) {
      setFase({ tipo: 'sin-sesion' });
      return;
    }
    try {
      const [yo, dataset] = await Promise.all([
        api<Yo>('/auth/yo'),
        api<Dataset>('/datos'),
      ]);
      setFase({ tipo: 'listo', yo, dataset });
    } catch {
      borrarAcceso();
      setFase({ tipo: 'sin-sesion' });
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  const cerrarSesion = useCallback(async () => {
    await logoutApi();
    setFase({ tipo: 'sin-sesion' });
  }, []);

  const refrescarDatos = useCallback(async () => {
    const dataset = await api<Dataset>('/datos');
    setFase((f) => (f.tipo === 'listo' ? { ...f, dataset } : f));
  }, []);

  const recargarSesion = useCallback(async () => {
    const yo = await api<Yo>('/auth/yo');
    setFase((f) => (f.tipo === 'listo' ? { ...f, yo } : f));
  }, []);

  const valor = useMemo<Estado | null>(() => {
    if (fase.tipo !== 'listo') return null;
    const { yo, dataset } = fase;
    const set = new Set(yo.permisos);
    const rol: Rol = { ...yo.rol, permisos: yo.permisos };
    return {
      dataset,
      rol,
      sesion: { usuario: yo.usuario, rolId: yo.rol.id },
      permisos: yo.permisos,
      navegacion: yo.navegacion,
      navegacionVisible: yo.navegacion,
      puede: (p: string) => set.has(p),
      cerrarSesion,
      refrescarDatos,
      recargarSesion,
    };
  }, [fase, cerrarSesion, refrescarDatos, recargarSesion]);

  if (fase.tipo === 'cargando') {
    return (
      <div className="arranque">
        <div className="arranque__marca">
          <span className="brandmark__word">TANTA</span>
          <span className="brandmark__pill">PAN DE CASA</span>
        </div>
        <p>Conectando con el sistema…</p>
      </div>
    );
  }

  if (fase.tipo === 'sin-sesion') {
    return <Acceso onSesion={() => void cargar()} />;
  }

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useApp(): Estado {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp debe usarse dentro de AppProvider');
  return ctx;
}

/** Renderiza children solo si el rol activo tiene el permiso. */
export function Gate({ permiso, children, siNo = null }: { permiso: string; children: ReactNode; siNo?: ReactNode }) {
  const { puede } = useApp();
  return <>{puede(permiso) ? children : siNo}</>;
}
