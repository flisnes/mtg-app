import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App.js';
import { CardDbGate } from './cardDb/CardDbGate.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { loadEndpoints, serverKnown } from './endpoints.js';
import { installGlobalErrorHandlers } from './errorLog.js';
import './vendor/keyrune/keyrune.css';
import './vendor/mana/mana.css';
import './styles.css';

installGlobalErrorHandlers();

// Hash-based routing: GitHub Pages has no SPA rewrite, so all routes live under
// the URL fragment (beta plan §2). The gate blocks the app until the card
// database is ready (downloaded/imported on first launch).
function render(): void {
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
}

// The server's address comes from endpoints.json on the site (endpoints.ts).
// A device that already knows one renders at once and refreshes it in the
// background; only a first boot waits for the answer (bounded by the fetch
// timeout), so nothing dials a server it has never heard of.
const endpoints = loadEndpoints();
if (serverKnown()) render();
else void endpoints.finally(render);
