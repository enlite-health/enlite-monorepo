/**
 * Bug real (tela de Acessos e permissões, 21/09): `recruitment.blocked` e
 * `recruitment.health` mostravam o ID CRU no lugar do rótulo.
 *
 * Causa-raiz: `ScreenTree.tsx` monta a chave por interpolação de string —
 * `t(\`admin.access.screens.${id}.label\`, id)` — e o i18next, por padrão,
 * trata TODO `.` da chave como separador de nível (`keySeparator: '.'`, sem
 * override em `infrastructure/i18n/config.ts`). Para a maioria das telas
 * (`patients.list`, `workers.detail`, …) isso funciona porque não existe uma
 * tela-PAI de mesmo nome — o algoritmo de resolução do i18next (`deepFind`)
 * cai no fallback de juntar o resto do caminho como chave literal
 * (`screens['patients.list']`). Mas EXISTE uma tela `recruitment` (sem ponto,
 * `screenRegistry.ts`) — então ao descer `screens.recruitment` o i18next acha
 * um objeto de VERDADE (`{ label: 'Reclutamiento' }`) e para de tentar juntar
 * segmentos: nunca chega a `.blocked.label`/`.health.label`, mesmo esses
 * existindo como chaves PLANAS `'recruitment.blocked'`/`'recruitment.health'`
 * no JSON. `t()` cai no 2º argumento (defaultValue = o próprio id) → ID cru.
 *
 * Conserto (na estrutura do JSON, não no código de leitura): `health` e
 * `blocked` viram filhos REAIS de `recruitment` em vez de chaves planas
 * pontuadas — aí o i18next desce naturalmente `screens.recruitment.health.
 * label`/`screens.recruitment.blocked.label`. Não muda `ScreenTree.tsx`, não
 * muda as outras 26 telas (nenhuma outra tem uma tela-pai de mesmo nome).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { SCREEN_REGISTRY } from '@presentation/config/screenRegistry';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

/** Exatamente a mesma forma de montar a chave que `ScreenTree.tsx` usa. */
function rotuloDaTela(id: string, lng: 'es' | 'pt-BR'): string {
  return i18n.t(`admin.access.screens.${id}.label`, { defaultValue: id, lng });
}

describe('ScreenTree — chave i18n de tela pontuada não pode cair pro ID cru quando existe tela-pai homônima', () => {
  it.each(['es', 'pt-BR'] as const)('recruitment.blocked resolve pro rótulo humano, não pro ID (%s)', (lng) => {
    const rotulo = rotuloDaTela('recruitment.blocked', lng);
    expect(rotulo).not.toBe('recruitment.blocked');
  });

  it.each(['es', 'pt-BR'] as const)('recruitment.health resolve pro rótulo humano, não pro ID (%s)', (lng) => {
    const rotulo = rotuloDaTela('recruitment.health', lng);
    expect(rotulo).not.toBe('recruitment.health');
  });

  // Trava de classe: TODA tela do registro (não só as 2 nomeadas) tem que resolver — se alguém
  // criar outra tela-filha de uma tela-pai homônima amanhã, este teste pega sem precisar nomear.
  it.each(['es', 'pt-BR'] as const)('nenhuma tela do SCREEN_REGISTRY cai pro ID cru (%s)', (lng) => {
    const crus = SCREEN_REGISTRY.map((s) => s.id).filter((id) => rotuloDaTela(id, lng) === id);
    expect(crus).toEqual([]);
  });
});
