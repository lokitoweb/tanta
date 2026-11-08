import { useEffect, useState } from 'react';
import { api } from '@/core/api';

/** Catálogos administrables (Maestros → Catálogos). Las reglas salen de sus atributos, no del código. */
export interface MedioPago { codigo: string; nombre: string; requiereOperacion: boolean; enVentas: boolean; enCobranza: boolean; enCompras: boolean; cajaChica: boolean; esCredito: boolean; activo: boolean; orden: number }
export interface TipoDocumento { codigo: string; nombre: string; creditoFiscal: boolean; activo: boolean; orden: number }
export interface TipoInsumo { codigo: string; nombre: string; esHarina: boolean; activo: boolean; orden: number }
export interface Unidad { codigo: string; descripcion: string; familia: 'MASA' | 'VOLUMEN' | 'CONTEO'; factorAPatron: number; activo: boolean; orden: number }
export interface PresentacionCompra { codigo: string; nombre: string; equivalencia: number; activo: boolean; orden: number }
export interface PresentacionVenta { codigo: string; nombre: string; equivalencia: number; insumoId: string | null; cantidadInsumo: number | null; activo: boolean; orden: number }
export interface Banco { codigo: string; nombre: string; activo: boolean; orden: number }
export interface TipoGasto { codigo: string; nombre: string; activo: boolean; orden: number }
/** Boleta, factura, nota de pedido… lo elige el cliente al cerrar su pedido. */
export interface ComprobanteVenta { codigo: string; nombre: string; requiereRuc: boolean; activo: boolean; orden: number }
export interface Catalogos { tiposGasto: TipoGasto[]; mediosPago: MedioPago[]; tiposDocumento: TipoDocumento[]; tiposInsumo: TipoInsumo[]; unidades: Unidad[];
  presentacionesCompra: PresentacionCompra[]; presentacionesVenta: PresentacionVenta[]; bancos: Banco[]; comprobantesVenta: ComprobanteVenta[] }

const vacio: Catalogos = { tiposGasto: [], mediosPago: [], tiposDocumento: [], tiposInsumo: [], unidades: [], presentacionesCompra: [], presentacionesVenta: [], bancos: [], comprobantesVenta: [] };
let cache: Promise<Catalogos> | null = null;

/** Recarga los catálogos (tras editarlos en Maestros → Catálogos). */
export const invalidarCatalogos = () => { cache = null; };

/** Catálogos activos, una sola consulta compartida por todas las pantallas. */
export function useCatalogos(): Catalogos {
  const [c, setC] = useState<Catalogos>(vacio);
  useEffect(() => {
    cache ??= api<Catalogos>('/catalogos').catch(() => { cache = null; return vacio; });
    let vivo = true;
    void cache.then((x) => { if (vivo) setC(x); });
    return () => { vivo = false; };
  }, []);
  return c;
}

/** Unidades de la misma familia que `unidad` (para escribir una receta en g si el insumo va en kg). */
export const mismaFamilia = (unidades: Unidad[], unidad: string) => {
  const f = unidades.find((u) => u.codigo === unidad)?.familia;
  return f ? unidades.filter((u) => u.familia === f) : unidades.filter((u) => u.codigo === unidad);
};
