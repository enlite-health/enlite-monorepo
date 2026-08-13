/**
 * Cobertura do conteúdo de ajuda ("¿Qué es este número?") da Gestión a la Vista.
 *
 * Evidência, não afirmação: TODA chave de `MANAGEMENT_HELP_KEYS` precisa ter o
 * bloco completo (title/que/origen/cambia) nos DOIS locales, e o campo opcional
 * `ojo` precisa existir nos dois ou em nenhum — senão a tela cai em chave crua
 * num idioma e não no outro.
 */
import { describe, it, expect } from 'vitest';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { MANAGEMENT_HELP_KEYS } from '../helpKeys';

type HelpEntry = { title?: string; que?: string; origen?: string; cambia?: string; ojo?: string };
type HelpBlock = Record<string, HelpEntry | string | Record<string, string>>;

const REQUIRED = ['title', 'que', 'origen', 'cambia'] as const;

function helpOf(json: unknown): HelpBlock {
  return (json as { admin: { managementDashboard: { help: HelpBlock } } }).admin
    .managementDashboard.help;
}

describe('conteúdo de ajuda da Gestión a la Vista', () => {
  const es = helpOf(esJson);
  const pt = helpOf(ptBRJson);

  it('ariaLabel e títulos de seção existem nos dois locales', () => {
    for (const help of [es, pt]) {
      expect(typeof help.ariaLabel).toBe('string');
      const sections = help._sections as Record<string, string>;
      for (const s of ['que', 'origen', 'cambia', 'ojo']) {
        expect(sections[s], `_sections.${s}`).toBeTruthy();
      }
    }
  });

  it.each(MANAGEMENT_HELP_KEYS)('indicador "%s" tem bloco completo em es e pt-BR', (key) => {
    const esEntry = es[key] as HelpEntry | undefined;
    const ptEntry = pt[key] as HelpEntry | undefined;
    expect(esEntry, `es.json sem help.${key}`).toBeTruthy();
    expect(ptEntry, `pt-BR.json sem help.${key}`).toBeTruthy();
    for (const field of REQUIRED) {
      expect(esEntry?.[field], `es help.${key}.${field}`).toBeTruthy();
      expect(ptEntry?.[field], `pt-BR help.${key}.${field}`).toBeTruthy();
    }
    // `ojo` é opcional, mas tem que ser simétrico entre locales.
    expect(Boolean(esEntry?.ojo), `assimetria de "ojo" em ${key}`).toBe(Boolean(ptEntry?.ojo));
  });

  it('não há entrada de ajuda órfã (conteúdo sem chave declarada)', () => {
    const declared = new Set<string>([...MANAGEMENT_HELP_KEYS, 'ariaLabel', '_sections']);
    for (const [name, help] of [['es', es] as const, ['pt-BR', pt] as const]) {
      const orphans = Object.keys(help).filter((k) => !declared.has(k));
      expect(orphans, `${name}: entradas órfãs`).toEqual([]);
    }
  });
});
