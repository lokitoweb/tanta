import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/core/api';
import { useCerrarAfuera } from '@/ui/useCerrarAfuera';
import { Icon } from '@/ui/icons';

// Ícono y tono por tipo de aviso; uno nuevo cae en la campana gris.
const TIPO: Record<string, { icono: Parameters<typeof Icon>[0]['name']; tono: string }> = {
  cobranza: { icono: 'wallet', tono: 'danger' }, compra: { icono: 'truck', tono: 'info' }, stock: { icono: 'alert', tono: 'warn' },
  venta: { icono: 'ledger', tono: 'ok' }, pedido: { icono: 'clipboard', tono: 'info' }, conteo: { icono: 'box', tono: 'warn' },
  promocion: { icono: 'tag', tono: 'ok' }, descuento: { icono: 'tag', tono: 'warn' }, requisicion: { icono: 'sack', tono: 'info' },
};

/** «hace 5 min», «ayer»; más de una semana, la fecha. */
function haceCuanto(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'ayer';
  if (d < 7) return `hace ${d} días`;
  return new Date(iso).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
}

interface Aviso { id: number; tipo: string; titulo: string; cuerpo: string; ruta: string; leida: boolean; fecha: string }

/** A11: avisos del usuario (pedidos nuevos, ventas, stock, aprobaciones). Se refresca cada 30 s. */
export function Campana() {
  const [abierto, setAbierto] = useState(false);
  const ref = useCerrarAfuera(abierto, () => setAbierto(false));
  const [datos, setDatos] = useState<{ noLeidas: number; avisos: Aviso[] }>({ noLeidas: 0, avisos: [] });
  const navegar = useNavigate();
  const cargar = () => api<typeof datos>('/notificaciones').then(setDatos).catch(() => {});
  useEffect(() => {
    void cargar();
    const t = setInterval(() => void cargar(), 30_000);
    return () => clearInterval(t);
  }, []);

  const abrir = async (a: Aviso) => {
    if (!a.leida) await api('/notificaciones/leidas', { method: 'POST', body: { ids: [a.id] } }).catch(() => {});
    setAbierto(false);
    void cargar();
    // El aviso del cliente apunta a su pedido; en la web, su historial está en el catálogo.
    if (a.ruta) navegar(a.ruta.startsWith('/pedidos/') ? '/catalogo' : a.ruta);
  };
  const todas = async () => { await api('/notificaciones/leidas', { method: 'POST', body: {} }).catch(() => {}); void cargar(); };

  return (
    <div className="cuenta" ref={ref}>
      <button className="campana" onClick={() => { setAbierto((v) => !v); if (!abierto) void cargar(); }} aria-expanded={abierto} aria-haspopup="menu"
        aria-label={datos.noLeidas ? `${datos.noLeidas} notificaciones sin leer` : 'Notificaciones'}>
        <Icon name="bell" size={18} />
        {datos.noLeidas > 0 && <span className="campana__n">{datos.noLeidas > 99 ? '99+' : datos.noLeidas}</span>}
      </button>
      {abierto && (
        <div className="cuenta__menu campana__menu" role="menu">
          <div className="campana__cab">
            <b>Notificaciones{datos.noLeidas > 0 && <span className="campana__chip">{datos.noLeidas} nuevas</span>}</b>
            {datos.noLeidas > 0 && <button className="campana__todas" onClick={() => void todas()}><Icon name="check" size={14} />Marcar leídas</button>}
          </div>
          {!datos.avisos.length && (
            <div className="campana__vacio"><Icon name="bell" size={28} /><span>Estás al día</span><small>No tienes notificaciones.</small></div>
          )}
          <div className="campana__lista">
            {datos.avisos.slice(0, 30).map((a) => {
              const k = TIPO[a.tipo] ?? { icono: 'bell', tono: 'neutro' };
              return (
                <button key={a.id} role="menuitem" className={`campana__item${a.leida ? '' : ' is-nueva'}`} onClick={() => void abrir(a)}>
                  <span className={`campana__ico tono-${k.tono}`}><Icon name={k.icono} size={16} /></span>
                  <span className="campana__txt">
                    <b>{a.titulo}</b>
                    {a.cuerpo && <span>{a.cuerpo}</span>}
                    <small title={new Date(a.fecha).toLocaleString('es-PE')}>{haceCuanto(a.fecha)}</small>
                  </span>
                  {!a.leida && <span className="campana__punto" aria-label="sin leer" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
