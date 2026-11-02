-- =====================================================================
--  022 · Hallazgos de la auditoría contra el PDF
--  - Producción consulta pedidos (Tabla 2: ○ consulta).
--  - Índices para el filtro por vendedor, búsqueda en auditoría y trazabilidad por documento.
-- =====================================================================
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT 'PRODUCCION', 'pedidos.ver'
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = 'PRODUCCION') AND EXISTS (SELECT 1 FROM core.permiso WHERE id = 'pedidos.ver')
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_venta_vendedor_txt ON core.venta (vendedor, creado_en) WHERE estado = 'CONFIRMADA';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_audit_actor_trgm ON audit.evento USING gin (actor gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_audit_entidad_id_trgm ON audit.evento USING gin (entidad_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_mov_documento ON core.movimiento_inventario (documento);
CREATE INDEX IF NOT EXISTS ix_op_producto_terminada ON core.orden_produccion (producto_id, terminada_en) WHERE estado = 'TERMINADA';
-- Reemplazado por ix_vd_venta_inc (021), que además cubre las columnas que leen los reportes.
DROP INDEX IF EXISTS core.ix_vd_venta;
