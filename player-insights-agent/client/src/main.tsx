import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { installAppSessionFetchGuard } from './app-session.tsx';
import { StartupBoundary } from './StartupBoundary.tsx';
import { installStaleBuildRecovery } from './stale-build.ts';

// Installed before React mounts so bootstrap, polling, mutations, and lazy
// routes all observe the same stable idle-timeout response.
installAppSessionFetchGuard();
// A tab opened before a redeploy asks for code files that no longer exist; reload once.
installStaleBuildRecovery();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <StartupBoundary>
        <App />
      </StartupBoundary>
    </ErrorBoundary>
  </StrictMode>
);
