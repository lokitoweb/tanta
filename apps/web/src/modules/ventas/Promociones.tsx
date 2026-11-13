import { api } from '@/core/api';
import { useApp } from '@/core/app-state';
import { Crud } from '@/ui/Crud';

type Reg = Record<string, unknown> & { id?: string };
const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

const cuerpo = (d: Reg) => ({ productoId: d.productoId, titulo: d.titulo, precioConIgv: Number(d.precioConIgv), desde: d.desde, hasta: d.hasta, activa: d.activa !== false, avisar: d.avisar === true,
  cantidad: d.cantidad === '' || d.cantidad == null || Number(d.cantidad) <= 0 ? null : Math.floor(Number(d.cantidad)) });

/** Promociones: venden lo que sobró de producción, a precio rebajado y hasta agotar el stock; no entran a producción. */
export function Promociones() {
  const { dataset } = useApp();
  const productos = dataset.productos.filter((p) => p.estado === 'ACTIVO' && !p.insumoId).map((p) => ({ valor: p.id, texto: p.nombre }));
  return (
    <Crud titulo="Promociones" nombreExport="promociones" descripcion="Ofertas de productos terminados, con su imagen en la app del cliente. No pasan a producción y se cobran aparte del pedido regular. Al tomarse las unidades ofrecidas, se avisa a todos que se agotó."
      cargar={() => api<Reg[]>('/promociones')}
      nuevo={{ productoId: productos[0]?.valor ?? '', titulo: '', precioConIgv: 0, cantidad: '', desde: hoy(), hasta: hoy(), activa: true, avisar: true }}
      crear={(d) => api('/promociones', { method: 'POST', body: cuerpo(d) })}
      editar={(id, d) => api(`/promociones/${id}`, { method: 'PATCH', body: cuerpo(d) })}
      columnas={[
        { key: 'titulo', label: 'Promoción' }, { key: 'producto', label: 'Producto' }, { key: 'precioNormal', label: 'Precio normal', tipo: 'dinero' }, { key: 'precioConIgv', label: 'Precio promoción', tipo: 'dinero' },
        { key: 'desde', label: 'Desde' }, { key: 'hasta', label: 'Hasta' }, { key: 'cantidad', label: 'Ofrecidas' }, { key: 'vendidas', label: 'Tomadas' }, { key: 'disponible', label: 'Quedan' }, { key: 'activa', label: 'Activa' },
      ]}
      campos={[
        { key: 'titulo', label: 'Título', requerido: true, ancho: true, max: 80, placeholder: 'Ej.: Pan francés a mitad de precio' },
        { key: 'productoId', label: 'Producto', tipo: 'select', opciones: productos, ancho: true },
        { key: 'precioConIgv', label: 'Precio de promoción por unidad, con IGV (S/)', tipo: 'numero', requerido: true, ayuda: 'Ej.: 10 panes a S/ 20 = S/ 2.00 por unidad' },
        { key: 'cantidad', label: 'Unidades en oferta', tipo: 'numero', ayuda: 'Ej.: 10. Vacío = hasta agotar el stock del producto' },
        { key: 'desde', label: 'Desde', tipo: 'fecha', requerido: true },
        { key: 'hasta', label: 'Hasta', tipo: 'fecha', requerido: true, ayuda: 'Igual a «Desde» = solo hoy: vence sola al terminar el día' },
        { key: 'activa', label: 'Activa', tipo: 'bool' },
        { key: 'avisar', label: 'Avisar a los clientes al guardar', tipo: 'bool', ayuda: 'Llega a la campana y al celular de quienes tienen cuenta' },
      ]} />
  );
}
