-- =====================================================================
--  033 · Lotes y fechas de vencimiento de insumos (INF-TEC-001 AIN-11)
--  · Cada ingreso de insumo crea un lote (número y vencimiento opcionales; sin número: "S/L-<mov>").
--  · Cada salida consume primero el lote que vence antes (FEFO); sin vencimiento, el más antiguo.
--  · Lo hace la base al registrar el movimiento: ninguna ruta (compra, baja, requisición, conteo,
--    producción) puede saltarse la regla. El stock del insumo sigue siendo la fuente de verdad;
--    core.cuadrar_lotes() alinea los lotes con él (datos previos a esta migración).
-- =====================================================================

CREATE TABLE IF NOT EXISTS core.lote_insumo (
  id               bigserial PRIMARY KEY,
  insumo_id        uuid NOT NULL REFERENCES core.insumo(id) ON DELETE CASCADE,
  lote             text NOT NULL,
  vence_en         date,
  cantidad_inicial numeric(18,6) NOT NULL CHECK (cantidad_inicial >= 0),
  saldo            numeric(18,6) NOT NULL CHECK (saldo >= 0),
  movimiento_id    bigint,
  alerta_en        timestamptz,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_lote_fefo ON core.lote_insumo (insumo_id, vence_en NULLS LAST, id) WHERE saldo > 0;
CREATE INDEX IF NOT EXISTS ix_lote_vence ON core.lote_insumo (vence_en) WHERE saldo > 0 AND vence_en IS NOT NULL;

ALTER TABLE core.movimiento_inventario
  ADD COLUMN IF NOT EXISTS lote     text,
  ADD COLUMN IF NOT EXISTS vence_en date;

-- Consume `cantidad` del insumo por FEFO. Si los lotes no alcanzan (stock anterior sin lotes), consume lo que hay.
CREATE OR REPLACE FUNCTION core.consumir_lotes(p_insumo uuid, p_cantidad numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l record; resto numeric := p_cantidad; toma numeric;
BEGIN
  FOR l IN SELECT id, saldo FROM core.lote_insumo WHERE insumo_id = p_insumo AND saldo > 0
           ORDER BY vence_en NULLS LAST, id FOR UPDATE LOOP
    EXIT WHEN resto <= 0;
    toma := least(l.saldo, resto);
    UPDATE core.lote_insumo SET saldo = saldo - toma WHERE id = l.id;
    resto := resto - toma;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION core.lote_movimiento() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_tipo <> 'INSUMO' OR NEW.cantidad = 0 THEN RETURN NULL; END IF;
  IF NEW.cantidad > 0 THEN
    INSERT INTO core.lote_insumo (insumo_id, lote, vence_en, cantidad_inicial, saldo, movimiento_id)
    VALUES (NEW.insumo_id, coalesce(nullif(trim(NEW.lote), ''), 'S/L-' || NEW.id), NEW.vence_en, NEW.cantidad, NEW.cantidad, NEW.id);
  ELSE
    PERFORM core.consumir_lotes(NEW.insumo_id, -NEW.cantidad);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tg_lote_movimiento ON core.movimiento_inventario;
CREATE TRIGGER tg_lote_movimiento AFTER INSERT ON core.movimiento_inventario
  FOR EACH ROW EXECUTE FUNCTION core.lote_movimiento();

-- Alinea la suma de lotes con el stock: el faltante entra como lote INICIAL; el sobrante se consume por FEFO.
CREATE OR REPLACE FUNCTION core.cuadrar_lotes() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE i record; n integer := 0;
BEGIN
  FOR i IN SELECT x.id, greatest(x.stock, 0) stock, coalesce((SELECT sum(saldo) FROM core.lote_insumo l WHERE l.insumo_id = x.id), 0) lotes
           FROM core.insumo x LOOP
    IF i.stock > i.lotes + 0.000001 THEN
      INSERT INTO core.lote_insumo (insumo_id, lote, cantidad_inicial, saldo) VALUES (i.id, 'INICIAL', i.stock - i.lotes, i.stock - i.lotes);
      n := n + 1;
    ELSIF i.lotes > i.stock + 0.000001 THEN
      PERFORM core.consumir_lotes(i.id, i.lotes - i.stock);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
SELECT core.cuadrar_lotes();

-- Días de anticipación de la alerta de vencimiento: lo ajusta el Administrador.
INSERT INTO core.parametro (clave, valor, tipo, descripcion)
VALUES ('dias_alerta_vencimiento', '7', 'numero', 'Días antes del vencimiento de un lote de insumo para avisar a Almacén y Gerencia')
ON CONFLICT (clave) DO NOTHING;
