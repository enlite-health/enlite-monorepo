/**
 * DiscardChangesConfirm.test.tsx — spec 014 US-D4, lex D4 AUTORIZADO.
 *
 * Covers:
 * - Renderiza título e corpo (i18n, não texto cru)
 * - Botão "Seguir editando" chama onKeepEditing
 * - Botão "Descartar cambios" chama onDiscard
 * - expectNoRawEnumLeaks — sem enum cru no DOM
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import es from '@infrastructure/i18n/locales/es.json';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';

const translations = es as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

import { DiscardChangesConfirm } from '../DiscardChangesConfirm';

function renderModal(overrides: Partial<{ onKeepEditing: () => void; onDiscard: () => void }> = {}) {
  const onKeepEditing = overrides.onKeepEditing ?? vi.fn();
  const onDiscard = overrides.onDiscard ?? vi.fn();
  const utils = render(<DiscardChangesConfirm onKeepEditing={onKeepEditing} onDiscard={onDiscard} />);
  return { ...utils, onKeepEditing, onDiscard };
}

describe('DiscardChangesConfirm', () => {
  it('renderiza título e corpo em espanhol (i18n)', () => {
    renderModal();
    expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
    expect(screen.getByText('¿Descartar los cambios?')).toBeVisible();
  });

  it('"Seguir editando" chama onKeepEditing, nunca onDiscard', () => {
    const { onKeepEditing, onDiscard } = renderModal();
    fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('"Descartar cambios" chama onDiscard, nunca onKeepEditing', () => {
    const { onKeepEditing, onDiscard } = renderModal();
    fireEvent.click(screen.getByTestId('discard-changes-discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onKeepEditing).not.toHaveBeenCalled();
  });

  it('sem enum cru no DOM', () => {
    const { container } = renderModal();
    expectNoRawEnumLeaks(container);
  });
});
