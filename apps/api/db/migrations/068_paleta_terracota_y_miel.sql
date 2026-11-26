-- Paleta Terracota y miel (26/11/2026): el interior pasa a colores más claros y juveniles.
-- Configuración → Marca ahora pinta toda la web: si la marca sigue con los colores de fábrica
-- (marrón #2B1D16 y arena #C9A27A), pasa a la paleta nueva. Si el Superadministrador ya eligió
-- otros colores, se respetan.
UPDATE core.configuracion
   SET valor = valor || '{"colorPrimario":"#B84A26","colorAcento":"#E9A23B"}'::jsonb,
       actualizado_en = now()
 WHERE clave = 'marca'
   AND upper(coalesce(valor->>'colorPrimario', '#2B1D16')) = '#2B1D16'
   AND upper(coalesce(valor->>'colorAcento', '#C9A27A')) = '#C9A27A';
