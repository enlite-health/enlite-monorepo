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

// Polyfill mínimo para o TipTap (`MessageComposer`, spec 022 B2/T215-T216) montar em jsdom.
// jsdom não implementa `document.elementFromPoint` nem `Range.prototype.getClientRects`/
// `getBoundingClientRect` — o ProseMirror (por baixo do TipTap) chama essas 3 em toda transação
// (posicionamento de cursor, scroll-into-view). Sem isto, `TypeError: ... is not a function`
// interrompe qualquer teste que digite no editor. Não afeta nenhum teste existente: as 3 APIs
// simplesmente não existem hoje em jsdom, então nada usava o valor real antes.
//
// 🔒 GUARDADO por `typeof document !== 'undefined'`: este `setup.ts` roda para TODO arquivo de
// teste, inclusive os poucos com `// @vitest-environment node` (ex.: `renderTherapeuticProjectPdf
// .test.ts`), onde `document`/`Range` não existem — sem a guarda, o polyfill quebrava esses
// testes com `ReferenceError: document is not defined` (achado ao rodar a suíte inteira).
if (typeof document !== 'undefined') {
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null;
  }
  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = () => ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
      toJSON() { return this; },
    }) as DOMRect;
  }
}

afterEach(() => {
  cleanup();
});
