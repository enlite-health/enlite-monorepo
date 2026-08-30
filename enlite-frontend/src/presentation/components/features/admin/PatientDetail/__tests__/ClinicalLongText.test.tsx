/**
 * ClinicalLongText — o bloco de texto clínico da ficha (observações gerais e instruções de
 * emergência usam o MESMO componente): quebras, autoria no locale do usuário, redigido, máscara.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let language = 'pt-BR';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) =>
      key === 'admin.patients.detail.diagnosisCard.lastEditedBy' ? `Última edição: ${opts!.date} · ${opts!.name}` : key,
    i18n: { get language() { return language; } },
  }),
}));

import { ClinicalLongText } from '../ClinicalLongText';

const FMT = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } as const;

const base = { testId: 'bloco', label: 'Rótulo:', text: 'linha 1\nlinha 2', updatedAt: '2026-08-28T14:35:00Z', updatedBy: 'Coordinadora' };

describe('ClinicalLongText', () => {
  it('texto com quebras, rótulo, máscara do Clarity e "Última edição: data · nome"', () => {
    render(<ClinicalLongText {...base} />);
    expect(screen.getByTestId('bloco')).toHaveAttribute('data-clarity-mask', 'True');
    expect(screen.getByText('Rótulo:')).toBeInTheDocument();
    expect(screen.getByTestId('bloco-text')).toHaveClass('whitespace-pre-wrap');
    expect(screen.getByTestId('bloco-text').textContent).toBe('linha 1\nlinha 2');
    expect(screen.getByTestId('bloco-edited').textContent).toMatch(/^Última edição: 28\/08\/2026.* · Coordinadora$/);
    expect(screen.queryByTestId('bloco-redacted')).not.toBeInTheDocument();
  });

  it('sem texto mostra — ; sem data não mostra a linha de autoria', () => {
    render(<ClinicalLongText {...base} text={null} updatedAt={null} updatedBy={null} />);
    expect(screen.getByTestId('bloco-text').textContent).toBe('—');
    expect(screen.queryByTestId('bloco-edited')).not.toBeInTheDocument();
  });

  it('data presente e nome nulo → "—" no lugar do nome; data inválida cai no ISO cru', () => {
    render(<ClinicalLongText {...base} updatedAt="não-é-data" updatedBy={null} />);
    expect(screen.getByTestId('bloco-edited').textContent).toBe('Última edição: não-é-data · —');
  });

  it('redigido: mostra a mensagem, sem texto nem autoria (mesmo com data e nome presentes)', () => {
    render(<ClinicalLongText {...base} redactedMessage="Sem permissão" />);
    expect(screen.getByTestId('bloco-redacted').textContent).toBe('Sem permissão');
    expect(screen.getByTestId('bloco-text').textContent).not.toContain('linha 1');
    expect(screen.queryByTestId('bloco-edited')).not.toBeInTheDocument();
  });

  it('a data segue o idioma do usuário: es → es-AR; qualquer outro → pt-BR', () => {
    const iso = '2026-08-28T14:35:00Z';
    language = 'es';
    const { unmount } = render(<ClinicalLongText {...base} />);
    expect(screen.getByTestId('bloco-edited').textContent).toBe(`Última edição: ${new Date(iso).toLocaleString('es-AR', FMT)} · Coordinadora`);
    unmount();
    language = 'pt-BR';
    render(<ClinicalLongText {...base} />);
    expect(screen.getByTestId('bloco-edited').textContent).toBe(`Última edição: ${new Date(iso).toLocaleString('pt-BR', FMT)} · Coordinadora`);
  });
});
