-- =====================================================================
--  006 · Datos del negocio en la base, no en el código
--  El nombre, RUC, dirección y representante estaban escritos dentro del
--  endpoint /datos. Eso obliga a un despliegue para cambiar el teléfono.
-- =====================================================================

CREATE TABLE IF NOT EXISTS core.negocio (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  nombre        text NOT NULL,
  ruc           text NOT NULL DEFAULT '',
  direccion     text NOT NULL DEFAULT '',
  telefono      text NOT NULL DEFAULT '',
  whatsapp      text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  representante text NOT NULL DEFAULT '',
  claim         text NOT NULL DEFAULT '',
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.negocio (id, nombre, ruc, direccion, telefono, whatsapp, email, representante, claim)
VALUES (1,
        'Panadería Tanta',
        '20481234567',
        'Av. Los Álamos 452, Santiago de Surco, Lima',
        '985 649 922',
        '985 649 922',
        'contacto@tantapanaderia.com',
        'Oscar Quilcate Rosell',
        'Pan de masa madre')
ON CONFLICT (id) DO NOTHING;
