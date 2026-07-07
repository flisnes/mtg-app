import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App.js';
import './styles.css';

// Hash-based routing: GitHub Pages has no SPA rewrite, so all routes live under
// the URL fragment (beta plan §2).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
