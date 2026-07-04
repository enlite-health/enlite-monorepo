import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './presentation/App';
import { validateEnv } from './infrastructure/config/env';
import { initializeFirebase } from './infrastructure/config/firebase';
import { initClarity } from './infrastructure/analytics/clarity';
import './infrastructure/i18n/config';
import './styles/index.css';

validateEnv();
initializeFirebase();
initClarity();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
