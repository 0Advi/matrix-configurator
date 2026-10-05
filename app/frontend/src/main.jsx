import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import { SessionProvider } from './state/SessionContext.jsx';
import { SitesProvider } from './state/SitesContext.jsx';
import AppRouter from './router/AppRouter.jsx';

// Auth model: the backend issues JWTs at POST /api/auth/login in response to
// {email, workspace_code}. The token is stashed in authToken.js (sessionStorage)
// and attached by the HTTP adapter on every request. No Supabase JS SDK needed.

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <SessionProvider>
        <SitesProvider>
          <AppRouter />
        </SitesProvider>
      </SessionProvider>
    </HashRouter>
  </React.StrictMode>
);
