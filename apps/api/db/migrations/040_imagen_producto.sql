-- =====================================================================
--  040 · Imagen del producto (catálogo web y app)
--  Se guarda en core.archivo como el logo y la foto de perfil: respaldada con la base.
-- =====================================================================
ALTER TABLE core.producto ADD COLUMN IF NOT EXISTS imagen_id uuid REFERENCES core.archivo(id) ON DELETE SET NULL;
