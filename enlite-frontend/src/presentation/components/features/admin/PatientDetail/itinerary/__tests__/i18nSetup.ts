import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

/** i18n REAL (es + pt-BR) para os testes do itinerário: o texto que o operador lê é o que o teste confere. */
export async function initI18n(lng: 'es' | 'pt-BR' = 'es'): Promise<void> {
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
}

export { i18n };
