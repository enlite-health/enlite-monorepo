import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '@infrastructure/i18n/config';
import { LanguageSwitcher } from './LanguageSwitcher';

afterEach(async () => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  await i18n.changeLanguage('es');
});

describe('LanguageSwitcher', () => {
  it('troca o idioma na hora e grava a escolha em localStorage["i18nextLng"] (a chave que i18n/config lê no próximo carregamento)', async () => {
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByTestId('language-pt-BR'));
    expect(window.localStorage.getItem('i18nextLng')).toBe('pt-BR');
    expect(i18n.language).toBe('pt-BR');
    expect(await screen.findByTestId('language-pt-BR')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('language-es')).toHaveAttribute('aria-pressed', 'false');
  });

  it('localStorage que lança (modo privado, iframe sandbox) não vira erro não tratado e não impede a troca em memória', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    // O React NÃO relança erro de handler pelo `fireEvent`: ele o reporta como `error` na janela. É esse evento que se mede.
    const naoTratados: string[] = [];
    const onError = (e: ErrorEvent): void => { naoTratados.push(String(e.error?.message ?? e.message)); e.preventDefault(); };
    window.addEventListener('error', onError);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByTestId('language-pt-BR'));
    window.removeEventListener('error', onError);
    expect(naoTratados).toEqual([]);
    expect(i18n.language).toBe('pt-BR');
  });
});
