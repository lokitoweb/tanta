import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/core/api';
import { Icon } from '@/ui/icons';

interface Aviso { id: number; tipo: string; titulo: string; cuerpo: string; ruta: string; leida: boolean; fecha: string }

/** A11: avisos del usuario (pedidos nuevos, ventas, stock, aprobaciones). Se refresca cada 30 s. */
export function Campana() {
  const [abierto, setAbierto] = useState(false);
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
    <div className="cuenta">
      <button className="campana" onClick={() => { setAbierto((v) => !v); if (!abierto) void cargar(); }} aria-expanded={abierto} aria-haspopup="menu"
        aria-label={datos.noLeidas ? `${datos.noLeidas} notificaciones sin leer` : 'Notificaciones'}>
        <Icon name="bell" size={18} />
        {datos.noLeidas > 0 && <span className="campana__n">{datos.noLeidas > 99 ? '99+' : datos.noLeidas}</span>}
      </button>
      {abierto && (
        <div className="cuenta__menu campana__menu" role="menu">
          <div className="campana__cab"><b>Notificaciones</b>{datos.noLeidas > 0 && <button className="enlace" onClick={() => void todas()}>Marcar todo leído</button>}</div>
          {!datos.avisos.length && <p className="t-muted campana__vacio">No tienes notificaciones.</p>}
          {datos.avisos.slice(0, 30).map((a) => (
            <button key={a.id} role="menuitem" className={`campana__item${a.leida ? '' : ' is-nueva'}`} onClick={() => void abrir(a)}>
              <b>{a.titulo}</b>
              <span>{a.cuerpo}</span>
              <small>{new Date(a.fecha).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' })}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
