import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from '@/core/app-state';
import { App } from '@/App';
import { Legal } from '@/modules/auth/Legal';

import './styles/fonts.css';
import '@tanta/tokens/tokens.css';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Privacidad y términos son públicos: se muestran sin iniciar sesión. */}
    {location.pathname === '/privacidad' || location.pathname === '/terminos'
      ? <Legal doc={location.pathname.slice(1) as 'privacidad' | 'terminos'} />
      : <BrowserRouter>
          <AppProvider>
            <App />
          </AppProvider>
        </BrowserRouter>}
  </StrictMode>,
);
