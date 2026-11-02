import { useMemo, useState } from 'react';
import { useApp } from '@/core/app-state';
import { money } from '@/core/format';
import { Boton, Encabezado, Insignia, Tarjeta } from '@/ui/primitives';
import { Icon } from '@/ui/icons';
import { NuevoPedido } from '@/modules/ventas/NuevoPedido';

export function Catalogo() {
  const { dataset, puede, refrescarDatos } = useApp();
  const [cat, setCat] = useState('todas');
  const [carrito, setCarrito] = useState<Record<string, number>>({});
  const [confirmando, setConfirmando] = useState(false);
  const [registrado, setRegistrado] = useState<string | null>(null);

  const productos = dataset.categorias.flatMap((c) =>
    dataset.productos.filter((p) => p.categoriaId === c.id && p.estado === 'ACTIVO').map((p) => ({ ...p, categoria: c.nombre })),
  );

  const lista = cat === 'todas' ? productos : productos.filter((p) => p.categoriaId === cat);
  const items = Object.values(carrito).reduce((s, n) => s + n, 0);
  const total = useMemo(
    () => productos.reduce((s, p) => s + (carrito[p.id] ?? 0) * p.precioConIgv, 0),
    [carrito, productos],
  );

  const sumar = (id: string) => setCarrito((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));

  // El pedido más reciente del propio cliente, tal como lo devuelve el servidor.
  const ultimo = dataset.misPedidos?.[0];

  return (
    <>
      <Encabezado
        titulo="Catálogo"
        descripcion="Elige tus productos y la fecha de entrega al confirmar el pedido"
        acciones={registrado && <Insignia tono="ok" punto>Pedido {registrado} registrado</Insignia>}
      />

      <div className="chips chips--fila">
        <button className={`chipfilter ${cat === 'todas' ? 'is-active' : ''}`} onClick={() => setCat('todas')}>Todo</button>
        {dataset.categorias.map((c) => (
          <button key={c.id} className={`chipfilter ${cat === c.id ? 'is-active' : ''}`} onClick={() => setCat(c.id)}>{c.nombre}</button>
        ))}
      </div>

      <div className="grid grid--4">
        {lista.map((p) => (
          <article className="prod" key={p.id}>
            <div className={`prod__tile prod__tile--${p.categoriaId}`}>
              <span className="prod__inicial">{p.nombre.charAt(0)}</span>
              <Insignia tono="neutral">{p.categoria}</Insignia>
            </div>
            <div className="prod__body">
              <h3 className="prod__nombre">{p.nombre}</h3>
              <p className="prod__unidad">por {p.unidad.toLowerCase()}</p>
              <div className="prod__foot">
                <strong className="prod__precio">{money(p.precioConIgv)}</strong>
                <button className="prod__add" onClick={() => sumar(p.id)} aria-label={`Agregar ${p.nombre}`}>
                  <Icon name="plus" size={16} />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>

      {items > 0 && (
        <div className="carrito">
          <div className="carrito__info">
            <span className="carrito__badge">{items}</span>
            <div>
              <strong>{items} {items === 1 ? 'producto' : 'productos'}</strong>
              <p>Total {money(total)}</p>
            </div>
          </div>
          {puede('pedidos.crear') && <Boton variant="primary" size="lg" iconoDer="chevron" onClick={() => setConfirmando(true)}>Confirmar pedido</Boton>}
        </div>
      )}

      {confirmando && (
        <NuevoPedido elegirCliente={!dataset.misPedidos && puede('pedidos.gestionar')}
          inicial={Object.entries(carrito).filter(([, n]) => n > 0).map(([productoId, cantidad]) => ({ productoId, cantidad }))}
          onCerrar={(codigo) => { setConfirmando(false); if (codigo) { setRegistrado(codigo); setCarrito({}); void refrescarDatos(); } }} />
      )}

      {ultimo && (
        <Tarjeta className="aviso-pedido">
          <Icon name="clock" size={18} />
          <div>
            <strong>Tu último pedido</strong>
            <p>{ultimo.codigo} · {money(ultimo.total)} · entrega el {ultimo.fechaEntrega}</p>
          </div>
          <Insignia tono={ultimo.estado === 'ENTREGADO' ? 'ok' : 'warn'} punto>
            {ultimo.estado === 'ENTREGADO' ? 'Entregado' : ultimo.estado === 'EN_PRODUCCION' ? 'En producción' : ultimo.estado}
          </Insignia>
        </Tarjeta>
      )}
    </>
  );
}
