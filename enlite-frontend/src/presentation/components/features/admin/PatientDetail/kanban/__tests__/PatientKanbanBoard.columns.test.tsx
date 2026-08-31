/**
 * PatientKanbanBoard — as 4 colunas têm de caber na tela.
 *
 * Medido no navegador em 30/08 (Playwright, viewport 1440): o board tinha
 * 1096px úteis para 1156px de conteúdo — 4 colunas de 280px + 3 gaps de 12px —
 * e a 4ª ("Activo") ficava 60px fora da tela, com o badge do caso pela metade.
 * A largura de 280px é do funil de VAGAS, que tem 9 colunas e rola de qualquer
 * jeito; aqui são 4 e a rolagem só esconde a coluna que mais importa.
 *
 * ⚠️ O que este teste prova e o que NÃO prova: o jsdom não faz layout, então
 * aqui não dá para medir corte. O que se afirma é que a classe de largura menor
 * chega à coluna — o suficiente para pegar quem remover a prop. A prova de que
 * cabe é a medição no navegador (cortado: 60 → 0), registrada no commit.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { PatientKanbanBoard } from '../PatientKanbanBoard';
import type { PatientKanbanGroups } from '@hooks/admin/usePatientKanban';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const empty: PatientKanbanGroups = {
  SOLICITANTE: [], ADMISSION: [], PENDING_ADMISSION: [], ACTIVE: [],
};

describe('largura das colunas', () => {
  it('as 4 colunas usam a largura reduzida, não os 280px do funil de vagas', () => {
    const { container } = render(
      <PatientKanbanBoard groups={empty} onMove={async () => null} />,
    );
    const board = container.querySelector('[data-testid="patient-kanban-board"]')!;
    const cols = [...board.children];
    expect(cols).toHaveLength(4);
    for (const c of cols) {
      expect(c.className).toContain('w-[260px]');
      expect(c.className).not.toContain('w-[280px]');
    }
  });
});
