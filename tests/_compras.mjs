// Flujo real de compra para las pruebas: Compras registra (psalas) y Almacén verifica (jramos).
// El stock solo ingresa al verificar (RN-06), así que toda prueba que necesita stock pasa por aquí.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from './_sql.mjs';

export const hoyLima = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
export const nroUnico = () => String(Math.floor(Math.random() * 1e10)).padStart(10, '0');

/** api(t, metodo, ruta, cuerpo) y login(usuario) son los de cada archivo de prueba. */
export function flujoCompras(api, login) {
  const proveedor = async () => {
    const r = await api(await login('lbermudez'), 'POST', '/proveedores', { razonSocial: `Proveedor prueba ${randomUUID().slice(0, 8)}` });
    assert.equal(r.s, 201, JSON.stringify(r.b));
    return r.b.id;
  };
  const registrar = async (proveedorId, items, extra = {}) => api(await login('psalas'), 'POST', '/compras', {
    proveedorId, docTipo: 'GUIA', serie: 'G001', nro: nroUnico(), fechaCompra: hoyLima(), items, ...extra,
  });
  /** conteo: { [item]: [cantidadContada, observacion] }; por defecto se cuenta lo del documento. */
  const verificar = async (compra, conteo = {}) => api(await login('jramos'), 'POST', `/compras/${compra.codigo}/verificar`, {
    lineas: compra.items.map((i) => ({ item: i.item, cantidadVerificada: conteo[i.item]?.[0] ?? i.cantidad, observacion: conteo[i.item]?.[1] ?? '' })),
  });
  const comprar = async (items, proveedorId) => {
    const r = await registrar(proveedorId ?? await proveedor(), items);
    assert.equal(r.s, 201, JSON.stringify(r.b));
    const v = await verificar(r.b);
    assert.equal(v.b?.estado, 'VERIFICADA', JSON.stringify(v.b));
    return r.b;
  };
  /** Compra expresada en unidad de inventario (como el stock): convierte a presentaciones con el servicio de la base. */
  const comprarInventario = (insumoId, cantidad, costo, proveedorId) => {
    const k = Number(sql(`SELECT coalesce(cant_presentacion, 1) * core.factor_inventario(id) FROM core.insumo WHERE id = '${insumoId}'`));
    return comprar([{ insumoId, cantidad: cantidad / k, precioUnitario: costo * k }], proveedorId);
  };
  return { proveedor, registrar, verificar, comprar, comprarInventario };
}
