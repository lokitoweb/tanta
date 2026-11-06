-- Flujo pedido → entrega → cobro → rendición (reunión con el dueño, 06/11/2026).
--  · Al pedir, el cliente ya no elige cómo pagará: el medio real se registra al entregar.
--  · El vendedor puede «observar» un pedido mal hecho: el cliente recibe la alerta y lo corrige (anula y repite).
--  · Al entregar se registra quién entregó; lo cobrado entra por Cobranza (recibo) y lo que falta queda como deuda.
--  · Cada día, cada vendedor rinde lo cobrado a la persona encargada de caja (sin mezclar días).

ALTER TABLE core.pedido ALTER COLUMN pago_entrega DROP NOT NULL;
ALTER TABLE core.pedido ALTER COLUMN pago_entrega DROP DEFAULT;
ALTER TABLE core.pedido
  ADD COLUMN IF NOT EXISTS observacion_vendedor text,
  ADD COLUMN IF NOT EXISTS observado_en timestamptz,
  ADD COLUMN IF NOT EXISTS observado_por uuid REFERENCES core.usuario(id),
  ADD COLUMN IF NOT EXISTS entregado_por uuid REFERENCES core.usuario(id);

CREATE TABLE IF NOT EXISTS core.rendicion_cobranza (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendedor_id        uuid NOT NULL REFERENCES core.usuario(id),
  fecha              date NOT NULL,
  esperado           jsonb NOT NULL,                 -- lo cobrado por forma de pago al rendir: {"EFECTIVO": 120.5, "YAPE": 40}
  total              numeric(16,2) NOT NULL CHECK (total >= 0),
  efectivo_esperado  numeric(16,2) NOT NULL CHECK (efectivo_esperado >= 0),
  efectivo_entregado numeric(16,2) NOT NULL CHECK (efectivo_entregado >= 0),
  nota               text,
  estado             text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','RECIBIDA')),
  efectivo_recibido  numeric(16,2) CHECK (efectivo_recibido >= 0),
  nota_caja          text,
  recibido_por       uuid REFERENCES core.usuario(id),
  recibido_en        timestamptz,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  actualizado_en     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendedor_id, fecha)
);
CREATE INDEX IF NOT EXISTS ix_rendicion_fecha ON core.rendicion_cobranza (fecha DESC, estado);
CREATE INDEX IF NOT EXISTS ix_cobranza_vendedor_fecha ON core.cobranza (registrado_por, creado_en);

INSERT INTO core.permiso (id, grupo, descripcion) VALUES
  ('caja.rendiciones', 'Caja', 'Recibir la rendición de cobranza de los vendedores (cuadre del día)')
ON CONFLICT (id) DO NOTHING;
INSERT INTO core.rol_permiso (rol_id, permiso_id)
SELECT r, 'caja.rendiciones' FROM unnest(ARRAY['SUPERADMIN','GERENTE','ADMINISTRADOR']) r
WHERE EXISTS (SELECT 1 FROM core.rol WHERE id = r)
ON CONFLICT DO NOTHING;
