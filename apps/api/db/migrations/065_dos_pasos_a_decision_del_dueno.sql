-- La verificación en dos pasos la decide el dueño por rol (Roles y permisos): ningún rol la trae impuesta.
-- Quien ya la activó conserva su clave; vuelve a pedirse cuando el dueño la exija para su rol.
UPDATE core.rol SET exige_mfa = false WHERE exige_mfa;
