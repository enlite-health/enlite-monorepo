/** Botão de comentários do card em duas formas: largo (funil da vaga, default) e só ícone na linha da tag (evento de enquadre). */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18n from '@infrastructure/i18n/config';
import { KanbanCard } from '../KanbanCard';

const base = {
  id: 'c-1',
  workerId: null as string | null,
  workerName: 'Ficticio 01',
  workerPhone: null,
  occupation: 'Acompañante terapéutico',
  workZone: null,
  matchScore: null,
  talentumStatus: null as string | null,
  rejectionReasonCategory: null as string | null,
  interviewDate: null as string | null,
  interviewTime: null as string | null,
  stage: 'COMPLETED',
};

beforeAll(async () => { await i18n.changeLanguage('es'); });
afterEach(() => cleanup());

describe('KanbanCard — botão de comentários', () => {
  it('compactNotes: só o ícone, com aria-label/title, na MESMA linha da tag', () => {
    render(<KanbanCard {...base} onOpenNotes={vi.fn()} compactNotes />);
    const btn = screen.getByTestId('notes-button');
    expect(btn.textContent).toBe('');
    expect(btn.getAttribute('aria-label')).toBe('Comentarios');
    expect(btn.getAttribute('title')).toBe('Comentarios');
    expect(btn.className).not.toContain('w-full');
    expect(btn.parentElement).toBe(screen.getByText('Acompañante terapéutico').parentElement);
  });

  it('compactNotes sem onOpenNotes (evento encerrado): nenhum botão, e a tag segue', () => {
    render(<KanbanCard {...base} compactNotes />);
    expect(screen.queryByTestId('notes-button')).not.toBeInTheDocument();
    expect(screen.getByText('Acompañante terapéutico')).toBeInTheDocument();
  });

  it('default (funil da vaga): continua o botão largo com o texto, fora da linha da tag', () => {
    render(<KanbanCard {...base} onOpenNotes={vi.fn()} />);
    const btn = screen.getByTestId('notes-button');
    expect(btn.textContent).toContain('Comentarios');
    expect(btn.className).toContain('w-full');
  });
});
