import ReactDOM from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import './styles/index.css';
import i18n from './infrastructure/i18n/config';
import { PreviewShell } from './preview/enquadre/PreviewShell';

const params = new URLSearchParams(window.location.search);
const lang = params.get('lang');

async function main(): Promise<void> {
  if (lang === 'es' || lang === 'pt-BR') await i18n.changeLanguage(lang);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
      <PreviewShell estado={params.get('estado')} />
    </MemoryRouter>,
  );
}

void main();
