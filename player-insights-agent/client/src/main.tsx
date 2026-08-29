import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { AppSessionBoundary, installAppSessionFetchGuard } from './app-session.tsx';

// Installed before React mounts so bootstrap, polling, mutations, and lazy
// routes all observe the same stable idle-timeout response.
installAppSessionFetchGuard();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppSessionBoundary>
        <App />
      </AppSessionBoundary>
    </ErrorBoundary>
  </StrictMode>
);
