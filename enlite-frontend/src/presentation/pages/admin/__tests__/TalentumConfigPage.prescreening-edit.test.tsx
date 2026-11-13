/**
 * TalentumConfigPage — o que o operador digita no passo 2 é o que o publish salva.
 *
 * Defeito (desde 03/05): PrescreeningStep guardava as perguntas/FAQ em estado local e o publish
 * salvava o estado do hook (só alimentado pela IA). Aqui a página, o hook e o PrescreeningStep são
 * os REAIS; só o AdminApiService (borda HTTP) é dublado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'es' } }),
}));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getVacancyById: vi.fn(),
    generateAIContent: vi.fn(),
    updateTalentumDescription: vi.fn(),
    savePrescreeningConfig: vi.fn(),
    publishToTalentum: vi.fn(),
  },
}));

import { AdminApiService } from '@infrastructure/http/AdminApiService';
import TalentumConfigPage from '../TalentumConfigPage';

const ps = 'admin.vacancyDetail.prescreening';
const save = vi.mocked(AdminApiService.savePrescreeningConfig);

const aiQuestion = {
  question: 'Pergunta da IA', responseType: ['text'], desiredResponse: 'R', weight: 5,
  required: false, analyzed: true, earlyStoppage: false,
};

function montar() {
  const state = {
    description: 'Descripción',
    prescreeningQuestions: [aiQuestion],
    prescreeningFaq: [{ question: 'FAQ da IA', answer: 'Resposta da IA' }],
  };
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/admin/vacancies/v1/talentum', state }]}>
      <Routes>
        <Route path="/admin/vacancies/:id/talentum" element={<TalentumConfigPage />} />
        <Route path="/admin/vacancies/:id" element={<span>detalhe</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(AdminApiService.getVacancyById).mockResolvedValue({ id: 'v1' } as any);
  save.mockResolvedValue(undefined as any);
  vi.mocked(AdminApiService.updateTalentumDescription).mockResolvedValue({ description: 'Descripción', propagated: false } as any);
  vi.mocked(AdminApiService.publishToTalentum).mockResolvedValue(undefined as any);
});

describe('TalentumConfigPage — publish salva o que o operador vê no passo 2', () => {
  it('pergunta editada, pergunta adicionada e FAQ editada chegam ao savePrescreeningConfig', async () => {
    montar();
    const q = await screen.findByDisplayValue('Pergunta da IA');
    fireEvent.change(q, { target: { value: 'Pergunta do operador' } });
    fireEvent.click(screen.getByText(`${ps}.addQuestion`));
    fireEvent.change(screen.getByDisplayValue('Resposta da IA'), { target: { value: 'FAQ editada' } });
    fireEvent.click(screen.getByText(`${ps}.addFaq`));

    fireEvent.click(screen.getByText('admin.talentumConfig.publishButton'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const [vacancyId, payload] = save.mock.calls[0] as [string, any];
    expect(vacancyId).toBe('v1');
    expect(payload.questions).toHaveLength(2);
    expect(payload.questions[0].question).toBe('Pergunta do operador');
    expect(payload.questions[1].question).toBe('');
    expect(payload.faq).toHaveLength(2);
    expect(payload.faq[0]).toEqual({ question: 'FAQ da IA', answer: 'FAQ editada' });
  });

  it('sem edição, o publish salva o conteúdo da IA que está na tela', async () => {
    montar();
    await screen.findByDisplayValue('Pergunta da IA');
    fireEvent.click(screen.getByText('admin.talentumConfig.publishButton'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const payload = (save.mock.calls[0] as any)[1];
    expect(payload.questions.map((x: any) => x.question)).toEqual(['Pergunta da IA']);
    expect(payload.faq).toEqual([{ question: 'FAQ da IA', answer: 'Resposta da IA' }]);
  });
});
