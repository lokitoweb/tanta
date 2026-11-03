-- =====================================================================
--  025 · Producción según INF-TEC-001 (M04): lotes, requisición a Almacén,
--  cierre con unidades buenas/merma/tiempos reales, costo real y varianza.
--  RN-18/19 (lotes y criterio), RN-20/21 (consumo y FALTA), RN-22/23 (presupuesto),
--  RN-24 (varianza), RN-27 (los insumos salen cuando Almacén entrega), RN-28 (costo real).
-- =====================================================================

ALTER TABLE core.orden_produccion
  ADD COLUMN IF NOT EXISTS criterio            text NOT NULL DEFAULT 'PROPORCIONAL',
  ADD COLUMN IF NOT EXISTS lotes               numeric(12,4),
  ADD COLUMN IF NOT EXISTS unidades_esperadas  numeric(18,4),
  ADD COLUMN IF NOT EXISTS masa_kg             numeric(18,4),
  ADD COLUMN IF NOT EXISTS unidades_buenas     numeric(18,4),
  ADD COLUMN IF NOT EXISTS unidades_merma      numeric(18,4),
  ADD COLUMN IF NOT EXISTS motivo_merma_tipo   text,
  ADD COLUMN IF NOT EXISTS horas_hombre_real   numeric(10,3),
  ADD COLUMN IF NOT EXISTS horas_horno_real    numeric(10,3),
  ADD COLUMN IF NOT EXISTS costo_total         numeric(18,4),
  ADD COLUMN IF NOT EXISTS costo_unitario_real numeric(18,6),
  ADD COLUMN IF NOT EXISTS motivo_anulacion    text;
DO $$ BEGIN
  ALTER TABLE core.orden_produccion ADD CONSTRAINT ck_op_criterio CHECK (criterio IN ('PROPORCIONAL','LOTES_COMPLETOS'));
  ALTER TABLE core.orden_produccion ADD CONSTRAINT ck_op_motivo_merma CHECK (motivo_merma_tipo IS NULL OR motivo_merma_tipo IN ('CORTE','ROTURA','QUEMADO','DEFORME','OTRO'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Requisición: lo que Producción pide y Almacén entrega (PRO-05, AIN-02).
CREATE SEQUENCE IF NOT EXISTS core.requisicion_correlativo_seq;
CREATE TABLE IF NOT EXISTS core.requisicion (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo      text NOT NULL UNIQUE,
  op_id       uuid NOT NULL UNIQUE REFERENCES core.orden_produccion(id),
  estado      text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','PARCIAL','ATENDIDA','ANULADA')),
  creado_en   timestamptz NOT NULL DEFAULT now(),
  atendida_en timestamptz,
  atendida_por uuid REFERENCES core.usuario(id)
);
CREATE INDEX IF NOT EXISTS ix_requisicion_pendiente ON core.requisicion (creado_en) WHERE estado IN ('PENDIENTE','PARCIAL');

CREATE TABLE IF NOT EXISTS core.requisicion_detalle (
  requisicion_id  uuid NOT NULL REFERENCES core.requisicion(id) ON DELETE CASCADE,
  insumo_id       uuid NOT NULL REFERENCES core.insumo(id),
  insumo          text NOT NULL,
  unidad          text NOT NULL,
  cant_solicitada numeric(18,6) NOT NULL CHECK (cant_solicitada >= 0),
  cant_entregada  numeric(18,6) NOT NULL DEFAULT 0 CHECK (cant_entregada >= 0),
  costo_entregado numeric(18,4) NOT NULL DEFAULT 0,
  cant_real_usada numeric(18,6) CHECK (cant_real_usada IS NULL OR cant_real_usada >= 0),
  PRIMARY KEY (requisicion_id, insumo_id)
);
CREATE INDEX IF NOT EXISTS ix_requisicion_detalle_insumo ON core.requisicion_detalle (insumo_id);

-- Permiso y pantalla de Almacén para atender requisiciones.
INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('requisiciones.atender', 'Almacén', 'Entregar a Producción los insumos de una requisición')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, 'requisiciones.atender' FROM unnest(ARRAY['SUPERADMIN','ALMACEN']) r
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
INSERT INTO core.navegacion (id, grupo, etiqueta, ruta, icono, permiso_id, orden, grupo_orden) VALUES
  ('n-requisiciones', 'Operación', 'Requisiciones', '/almacen/requisiciones', 'clipboard', 'requisiciones.atender', 5, 1)
ON CONFLICT (id) DO NOTHING;
