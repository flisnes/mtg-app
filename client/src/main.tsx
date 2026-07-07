import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App.js';
import { CardDbGate } from './cardDb/CardDbGate.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { installGlobalErrorHandlers } from './errorLog.js';
import './styles.css';

installGlobalErrorHandlers();

// Hash-based routing: GitHub Pages has no SPA rewrite, so all routes live under
// the URL fragment (beta plan §2). The gate blocks the app until the card
// database is ready (downloaded/imported on first launch).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <CardDbGate>
          <App />
        </CardDbGate>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
);
