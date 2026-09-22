/**
 * MentionPopupList — teste unitário isolado (spec 022, Rodada 2/R2-F, extraído de
 * `MessageComposer.tsx`). O comportamento composto (TipTap + editor real) já é coberto por
 * `MessageComposer.test.tsx`; este teste cobre o componente puro, sozinho, para o módulo de
 * menção ser reusável fora do compositor sem depender daquele teste maior.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { MentionPopupList } from '../MentionPopupList';

/** Mesmo padrão de `MessageComposer.test.tsx`: espelha o `t` real contra o pt-BR.json de verdade. */
const translations = ptBR as Record<string, unknown>;
function resolve(key: string): unknown {
  return key.split('.').reduce((acc: any, part) => acc?.[part], translations);
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const raw = resolve(key);
      return typeof raw === 'string' ? raw : key;
    },
  }),
}));

describe('MentionPopupList (extraído do MessageComposer, Rodada 2/R2-F)', () => {
  it('lista os candidatos e chama command com {id,label} ao clicar', () => {
    const command = vi.fn();
    render(<MentionPopupList items={[{ uid: 'u-1', displayName: 'QA Staff Um' }]} error={false} command={command} />);
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveTextContent('QA Staff Um');
    fireEvent.click(screen.getByTestId('composer-mention-item-u-1'));
    expect(command).toHaveBeenCalledWith({ id: 'u-1', label: 'QA Staff Um' });
  });

  it('items=[] sem erro: não renderiza nada (nem lista nem erro)', () => {
    const { container } = render(<MentionPopupList items={[]} error={false} command={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('error=true: mostra o aviso de falha, nunca a lista (distinto de "0 resultados")', () => {
    render(<MentionPopupList items={[]} error command={vi.fn()} />);
    expect(screen.getByTestId('composer-mention-error')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-mention-list')).not.toBeInTheDocument();
  });
});
