import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Inicializa i18n para que componentes que usam useTranslation não emitam
// o warning "NO_I18NEXT_INSTANCE" no stderr durante os testes.
if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    lng: 'pt-BR',
    // Espelha a PRODUÇÃO (infrastructure/i18n/config.ts:38 usa 'es'). Com
    // 'pt-BR' aqui, chave faltando no es.json era servida em português e o
    // teste passava verde — medido em 30/08 apagando stages.INTERVIEWED.
    fallbackLng: 'es',
    resources: {},
    interpolation: { escapeValue: false },
    initImmediate: false,
    // Suprime o log promocional do i18next ("made possible by Locize") no stdout.
    // Ref: https://www.i18next.com/misc/creating-own-plugins#logger
    debug: false,
  });
}

afterEach(() => {
  cleanup();
});
