import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import es from '../../../../infrastructure/i18n/locales/es.json';
import ptBR from '../../../../infrastructure/i18n/locales/pt-BR.json';
import { Label } from './Label';

// O setup global sobe o i18n com `resources: {}`; cada teste injeta o bundle que quer provar.
const ORIGINAL = i18n.language;

afterEach(async () => {
  i18n.removeResourceBundle('pt-BR', 'translation');
  i18n.removeResourceBundle('es', 'translation');
  await i18n.changeLanguage(ORIGINAL);
});

describe('Label — "(opcional)" vem da tradução (common.optional), não fixo no JSX', () => {
  it.each([
    ['pt-BR', ptBR],
    ['es', es],
  ])('em %s mostra o valor do locale real', async (lng, bundle) => {
    i18n.addResourceBundle(lng, 'translation', bundle, true, true);
    await i18n.changeLanguage(lng);
    render(<Label optional>Email</Label>);
    expect(screen.getByText(bundle.common.optional)).toBeInTheDocument();
  });

  it('segue a chave: bundle com outro texto muda o que a tela mostra', async () => {
    i18n.addResourceBundle('pt-BR', 'translation', { common: { optional: '(SENTINELA)' } }, true, true);
    await i18n.changeLanguage('pt-BR');
    render(<Label optional>Email</Label>);
    expect(screen.getByText('(SENTINELA)')).toBeInTheDocument();
    expect(screen.queryByText('(opcional)')).not.toBeInTheDocument();
  });

  it('sem `optional` não mostra o texto', () => {
    render(<Label>Email</Label>);
    expect(screen.queryByText(/opcional|common\.optional/)).not.toBeInTheDocument();
  });
});
