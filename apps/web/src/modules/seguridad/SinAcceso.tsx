import { useApp } from '@/core/app-state';
import { Boton, Encabezado, Tarjeta } from '@/ui/primitives';
import { Icon } from '@/ui/icons';

export function SinAcceso() {
  const { rol } = useApp();
  return (
    <>
      <Encabezado titulo="Sin acceso" descripcion="Esta sección no está habilitada para tu perfil" />
      <Tarjeta>
        <div className="sinacceso">
          <span className="sinacceso__icono"><Icon name="shield" size={26} /></span>
          <h2>Tu rol no tiene este permiso</h2>
          <p>
            Estás en el perfil <strong>{rol.nombre}</strong>. Si necesitas esta sección, pide a Gerencia
            que amplíe tu rol. El acceso quedó registrado en la auditoría.
          </p>
          <Boton variant="primary" onClick={() => history.back()}>Volver</Boton>
        </div>
      </Tarjeta>
    </>
  );
}
