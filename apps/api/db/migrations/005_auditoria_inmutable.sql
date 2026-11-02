-- =====================================================================
--  005 · Auditoría a prueba de manipulación
--  El libro de eventos debe ser inmutable incluso para el usuario de la
--  aplicación: si el atacante puede borrar su rastro, la auditoría no vale.
--  Orden: primero se ajustan los datos y al final se cierra la tabla.
-- =====================================================================

-- 1) El instante del evento pasa a formar parte de lo que se hashea, para que
--    al verificar se use exactamente el mismo valor que se firmó.
ALTER TABLE audit.evento ADD COLUMN IF NOT EXISTS ocurrido_en timestamptz;

UPDATE audit.evento SET ocurrido_en = creado_en WHERE ocurrido_en IS NULL;

ALTER TABLE audit.evento ALTER COLUMN ocurrido_en SET NOT NULL;
ALTER TABLE audit.evento ALTER COLUMN ocurrido_en SET DEFAULT now();

-- 2) Estado de la cadena en una sola fila bloqueable: evita que dos procesos
--    lean el mismo "último hash" y partan la cadena.
CREATE TABLE IF NOT EXISTS audit.cadena_estado (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hash_actual    text NOT NULL DEFAULT '',
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
INSERT INTO audit.cadena_estado (id, hash_actual)
VALUES (1, coalesce((SELECT hash_actual FROM audit.evento ORDER BY id DESC LIMIT 1), ''))
ON CONFLICT (id) DO NOTHING;

-- 3) La cadena anterior a esta migración quedó partida: se documenta y se marca
--    el corte, en lugar de fingir que siempre fue válida.
INSERT INTO audit.evento (actor, rol, accion, entidad, detalle, hash_anterior, hash_actual, ocurrido_en, creado_en)
SELECT 'migracion', 'SISTEMA', 'CADENA_REINICIADA', 'audit.evento',
       jsonb_build_object('motivo', 'Corrección del algoritmo de encadenado',
                          'eventosPrevios', (SELECT count(*) FROM audit.evento)),
       '', 'CORTE-' || extract(epoch from now())::bigint, now(), now();

UPDATE audit.cadena_estado
SET hash_actual = (SELECT hash_actual FROM audit.evento ORDER BY id DESC LIMIT 1)
WHERE id = 1;

-- 4) A partir de aquí, nadie puede modificar ni borrar eventos.
CREATE OR REPLACE FUNCTION audit.rechazar_modificacion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.evento es append-only: % no está permitido', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_inmutable ON audit.evento;
CREATE TRIGGER trg_audit_inmutable
  BEFORE UPDATE OR DELETE ON audit.evento
  FOR EACH ROW EXECUTE FUNCTION audit.rechazar_modificacion();

DROP TRIGGER IF EXISTS trg_audit_inmutable_truncate ON audit.evento;
CREATE TRIGGER trg_audit_inmutable_truncate
  BEFORE TRUNCATE ON audit.evento
  FOR EACH STATEMENT EXECUTE FUNCTION audit.rechazar_modificacion();
