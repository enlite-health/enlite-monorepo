/**
 * VacancySimulationSection.test.tsx — spec 029, T073.
 *
 * i18n REAL. `vi.mock` no MESMO caminho que o componente importa (`@infrastructure/http/AdminApiService`,
 * conferido contra o import do arquivo); `ApiError` é a classe real (o componente faz `instanceof`).
 * A junta com o `request()` real está em `infrastructure/http/__tests__/AdminApiService.aiPrompts.wire.test.ts`.
 * As peças `PrescreeningStep`/`AIDescriptionEditor` são as REAIS (não dubladas).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { VacancySimulationSection } from '../VacancySimulationSection';
import { AdminApiService, ApiError, type AiVacancySimulation } from '@infrastructure/http/AdminApiService';

vi.mock('@infrastructure/http/AdminApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminApiService')>();
  return {
    ...actual,
    AdminApiService: { listVacancies: vi.fn(), simulateVacancyCreation: vi.fn() },
  };
});

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const listVacancies = () => vi.mocked(AdminApiService.listVacancies);
const simulate = () => vi.mocked(AdminApiService.simulateVacancyCreation);

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'pt-BR',
    fallbackLng: false,
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

function sim(over: Partial<AiVacancySimulation> & { q?: string; desc?: string } = {}): AiVacancySimulation {
  return {
    description: over.desc ?? 'Descrição simulada',
    prescreening: {
      questions: [
        { question: over.q ?? 'Pergunta simulada', responseType: ['text', 'audio'], desiredResponse: 'Resposta esperada', weight: 5, required: false, analyzed: true, earlyStoppage: false },
      ],
      faq: [{ question: 'FAQ simulada', answer: 'Resposta FAQ' }],
    },
    workerType: 'AT',
    usedSlugs: ['VACANCY_DESCRIPTION', 'PRESCREENING_AT'],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listVacancies().mockResolvedValue({
    data: [
      { id: CASE_ID, caso: 'Caso 101', isDraft: false },
      { id: 'rascunho-id', caso: 'Caso 999', isDraft: true },
    ],
    total: 2,
  });
});

async function pickCaseAndRun(): Promise<void> {
  fireEvent.change(await screen.findByTestId('vacancy-simulation-case'), { target: { value: CASE_ID } });
  fireEvent.click(screen.getByTestId('vacancy-simulation-run'));
}

describe('VacancySimulationSection', () => {
  it('lista os casos sem rascunhos e só habilita simular com caso escolhido', async () => {
    render(<VacancySimulationSection bodies={{}} />);
    expect(await screen.findByRole('option', { name: 'Caso 101' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Caso 999' })).not.toBeInTheDocument();
    expect(screen.getByTestId('vacancy-simulation-run')).toBeDisabled();
    fireEvent.change(screen.getByTestId('vacancy-simulation-case'), { target: { value: CASE_ID } });
    expect(screen.getByTestId('vacancy-simulation-run')).toBeEnabled();
  });

  it('envia o caso e os corpos em edição; mostra descrição e perguntas/FAQ em readOnly', async () => {
    simulate().mockResolvedValue(sim());
    render(<VacancySimulationSection bodies={{ VACANCY_DESCRIPTION: 'rascunho não salvo' }} />);
    await pickCaseAndRun();
    const result = await screen.findByTestId('vacancy-simulation-result');
    expect(simulate()).toHaveBeenCalledWith(CASE_ID, { VACANCY_DESCRIPTION: 'rascunho não salvo' });
    expect(within(result).getByDisplayValue('Descrição simulada')).toHaveAttribute('readonly');
    expect(within(result).getByDisplayValue('Pergunta simulada')).toHaveAttribute('readonly');
    expect(within(result).getByDisplayValue('FAQ simulada')).toHaveAttribute('readonly');
    expect(screen.getByTestId('vacancy-simulation-notice')).toHaveTextContent(/SIMULAÇÃO/);
  });

  it('NÃO HÁ COMO CRIAR: nenhum botão de guardar/publicar/criar, nenhuma lixeira, nenhum "adicionar"', async () => {
    simulate().mockResolvedValue(sim());
    render(<VacancySimulationSection bodies={{}} />);
    await pickCaseAndRun();
    await screen.findByTestId('vacancy-simulation-result');
    const nomes = screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim());
    // Só sobram o "Simular" e o "configuración avanzada" de cada pergunta (expande flags, travadas).
    for (const nome of nomes) {
      expect(nome).not.toMatch(/guardar|salvar|publicar|crear|criar|agregar|adicionar|eliminar|excluir|enviar|talentum/i);
    }
    expect(screen.getByTestId('vacancy-simulation-run')).toHaveTextContent('Simular criação');
    // Lixeira (excluir pergunta/FAQ) só existe fora de readOnly: os únicos botões são "Simular" + "avançada".
    expect(screen.getAllByRole('button')).toHaveLength(2);
    // Campos travados.
    for (const campo of screen.getByTestId('vacancy-simulation-result').querySelectorAll('textarea, input[type="text"], input[type="number"]')) {
      expect(campo).toHaveAttribute('readonly');
    }
  });

  it('SEGUNDA SIMULAÇÃO APARECE: duas simulações seguidas mostram a SEGUNDA (key= remonta o useState semeado)', async () => {
    simulate()
      .mockResolvedValueOnce(sim({ q: 'Pergunta da PRIMEIRA', desc: 'Descrição da PRIMEIRA' }))
      .mockResolvedValueOnce(sim({ q: 'Pergunta da SEGUNDA', desc: 'Descrição da SEGUNDA' }));
    render(<VacancySimulationSection bodies={{}} />);
    await pickCaseAndRun();
    expect(await screen.findByDisplayValue('Pergunta da PRIMEIRA')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('vacancy-simulation-run'));
    expect(await screen.findByDisplayValue('Pergunta da SEGUNDA')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Descrição da SEGUNDA')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Pergunta da PRIMEIRA')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Descrição da PRIMEIRA')).not.toBeInTheDocument();
    expect(simulate()).toHaveBeenCalledTimes(2);
  });

  it('AVISO: texto editado de PRESCREENING_AT com vaga de CUIDADOR fica sinalizado como NÃO exercitado', async () => {
    simulate().mockResolvedValue(
      sim({ workerType: 'CUIDADOR', usedSlugs: ['VACANCY_DESCRIPTION', 'PRESCREENING_CAREGIVER'] }),
    );
    render(<VacancySimulationSection bodies={{ PRESCREENING_AT: 'meu texto de AT' }} />);
    await pickCaseAndRun();
    const aviso = await screen.findByTestId('vacancy-simulation-not-exercised-PRESCREENING_AT');
    expect(aviso).toHaveTextContent(/NÃO entrou/);
    expect(aviso).toHaveTextContent('Pré-seleção — Acompanhante Terapêutico');
    expect(aviso).toHaveTextContent('Pré-seleção — Cuidador');
    expect(screen.getByTestId('vacancy-simulation-used')).toHaveTextContent('Pré-seleção — Cuidador');
  });

  it('SEM aviso quando o prescreening editado é o que a vaga exercitou (e quando não houve edição)', async () => {
    simulate().mockResolvedValue(sim());
    const { unmount } = render(<VacancySimulationSection bodies={{ PRESCREENING_AT: 'meu texto de AT' }} />);
    await pickCaseAndRun();
    await screen.findByTestId('vacancy-simulation-result');
    expect(screen.queryByTestId('vacancy-simulation-not-exercised-PRESCREENING_AT')).not.toBeInTheDocument();
    unmount();
    render(<VacancySimulationSection bodies={{}} />);
    await pickCaseAndRun();
    await screen.findByTestId('vacancy-simulation-result');
    expect(screen.queryByTestId(/vacancy-simulation-not-exercised/)).not.toBeInTheDocument();
  });

  it('carregando: mostra estado honesto (dezenas de segundos) e desabilita o botão; some ao terminar', async () => {
    let resolve!: (v: AiVacancySimulation) => void;
    simulate().mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<VacancySimulationSection bodies={{}} />);
    await pickCaseAndRun();
    expect(await screen.findByTestId('vacancy-simulation-running')).toHaveTextContent(/dezenas de segundos/);
    expect(screen.getByTestId('vacancy-simulation-run')).toBeDisabled();
    resolve(sim());
    await screen.findByTestId('vacancy-simulation-result');
    expect(screen.queryByTestId('vacancy-simulation-running')).not.toBeInTheDocument();
  });

  it('503 / 404 / genérico: mensagem própria, sem resultado', async () => {
    simulate().mockRejectedValueOnce(new ApiError({ success: false, error: 'modelo_indisponivel' } as never, 503));
    render(<VacancySimulationSection bodies={{}} />);
    await pickCaseAndRun();
    expect(await screen.findByTestId('vacancy-simulation-error')).toHaveTextContent(/indisponível/);
    expect(screen.queryByTestId('vacancy-simulation-result')).not.toBeInTheDocument();

    simulate().mockRejectedValueOnce(new ApiError({ success: false, error: 'caso_nao_encontrado' } as never, 404));
    fireEvent.click(screen.getByTestId('vacancy-simulation-run'));
    expect(await screen.findByText(/não existe mais/)).toBeInTheDocument();

    simulate().mockRejectedValueOnce(new Error('rede'));
    fireEvent.click(screen.getByTestId('vacancy-simulation-run'));
    expect(await screen.findByText(/preservados/)).toBeInTheDocument();
  });

  it('estados vazios: sem casos, erro ao listar e descrição em branco têm mensagem', async () => {
    listVacancies().mockResolvedValueOnce({ data: [], total: 0 });
    const a = render(<VacancySimulationSection bodies={{}} />);
    expect(await screen.findByTestId('vacancy-simulation-no-cases')).toBeInTheDocument();
    a.unmount();

    listVacancies().mockRejectedValueOnce(new Error('boom'));
    const b = render(<VacancySimulationSection bodies={{}} />);
    expect(await screen.findByTestId('vacancy-simulation-cases-error')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-simulation-case')).not.toBeInTheDocument();
    b.unmount();

    simulate().mockResolvedValue(sim({ desc: '   ' }));
    render(<VacancySimulationSection bodies={{}} />);
    await pickCaseAndRun();
    expect(await screen.findByTestId('vacancy-simulation-empty-description')).toBeInTheDocument();
  });
});
