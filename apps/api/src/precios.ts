import type { PoolClient } from 'pg';
import { q } from './db.js';

/**
 * Precios propios de la lista del cliente (producto → precio con IGV por unidad).
 * Un producto que no está en la lista, o una lista inactiva, se cobra al precio del catálogo.
 * Las presentaciones (paquetes) se escalan en la misma proporción: ver `escalar`.
 */
export async function preciosCliente(clienteId: string | null | undefined, c?: PoolClient): Promise<Map<string, number>> {
  if (!clienteId) return new Map();
  const sql = `SELECT i.producto_id, i.precio_con_igv FROM core.cliente c
      JOIN core.lista_precio l ON l.codigo = c.lista_precio AND l.activa
      JOIN core.lista_precio_item i ON i.lista_codigo = l.codigo
    WHERE c.id = $1`;
  const filas = c ? (await c.query<{ producto_id: string; precio_con_igv: string }>(sql, [clienteId])).rows
    : await q<{ producto_id: string; precio_con_igv: string }>(sql, [clienteId]);
  return new Map(filas.map((f) => [f.producto_id, Number(f.precio_con_igv)]));
}

/** Lleva un precio del catálogo (unidad o paquete) a la lista: misma proporción que el precio por unidad, a céntimos. */
export function escalar(precio: number, catalogoUnidad: number, listaUnidad: number | undefined): number {
  if (listaUnidad === undefined || !(catalogoUnidad > 0)) return precio;
  return Math.round(precio * (listaUnidad / catalogoUnidad) * 100) / 100;
}
