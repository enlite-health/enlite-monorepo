/**
 * ItineraryEditAppointmentModal — D445.3 (nós Figma 11340:76269/76377/76652). "Día de la semana"
 * e "Horario" desabilitados (chave imutável); "Dirección de entrada" só leitura (D445.6); os
 * contadores de "Búsqueda de urgencia" NUNCA aparecem sem fonte (D445.7) — só o link/aviso.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { ItineraryEditAppointmentModal } from '../ItineraryEditAppointmentModal';

vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({
  useServiceExitReasonOptions: () => ({ options: [{ code: 'OTHER', label: 'Otro' }], status: 'ok' }),
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const SLOT = { weekday: 1, startTime: '08:00', endTime: '12:00' };
const OPTIONS = [
  { workerId: 'w-1', displayName: 'Dana Fixture', vacancyId: 'vac-1' },
  { workerId: 'w-2', displayName: 'Elio Fixture', vacancyId: 'vac-1' },
];

function renderModal(props: Partial<Parameters<typeof ItineraryEditAppointmentModal>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <MemoryRouter>
      <ItineraryEditAppointmentModal
        slot={SLOT}
        addressLabel="Rua Augusta, 975"
        options={OPTIONS}
        vacancyId="vac-1"
        currentWorkerId={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...utils, onSubmit, onCancel };
}

describe('ItineraryEditAppointmentModal', () => {
  it('"Día de la semana" e "Horario" ficam DESABILITADOS (chave imutável)', () => {
    renderModal();
    expect(screen.getByTestId('itinerario-editar-dia')).toBeDisabled();
    // Figma: "Día de la semana" é um SELECT desabilitado (com seta); "Horario" um input.
    expect(screen.getByTestId('itinerario-editar-dia').tagName).toBe('SELECT');
    expect(screen.getByTestId('itinerario-editar-dia')).toHaveDisplayValue('lunes');
    expect(screen.getByTestId('itinerario-editar-horario')).toBeDisabled();
    expect(screen.getByTestId('itinerario-editar-horario')).toHaveValue('08:00 - 12:00');
    // Figma: o VALOR também fica no cinza de desabilitado (#d9d9d9), não só o rótulo.
    expect(screen.getByTestId('itinerario-editar-horario').className).toContain('!text-[#d9d9d9]');
  });

  it('"Dirección de entrada" é só leitura, com o endereço do serviço', () => {
    renderModal();
    expect(screen.getByTestId('itinerario-editar-endereco')).toHaveAttribute('readonly');
    expect(screen.getByTestId('itinerario-editar-endereco')).toHaveValue('Rua Augusta, 975');
  });

  it('D445.6: NÃO existe campo de "Endereço de saída", "Valor da hora" nem etiqueta Regular/Fin de semana', () => {
    renderModal();
    expect(screen.queryByText(/Endereço de saída|Dirección de salida/i)).toBeNull();
    expect(screen.queryByText(/Valor da hora|Valor de la hora/i)).toBeNull();
    expect(screen.queryByText(/^Regular$/)).toBeNull();
    expect(screen.queryByText(/Final de semana|Fin de semana/i)).toBeNull();
  });

  it('Guardar fica desabilitado sem prestador escolhido; escolher habilita e chama onSubmit(workerId)', () => {
    const { onSubmit } = renderModal();
    expect(screen.getByTestId('itinerario-editar-guardar')).toBeDisabled();
    fireEvent.click(screen.getByTestId('itinerario-editar-prestador'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Dana Fixture'));
    expect(screen.getByTestId('itinerario-editar-guardar')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('itinerario-editar-guardar'));
    expect(onSubmit).toHaveBeenCalledWith('w-1');
  });

  it('currentWorkerId pré-seleciona o select (mostra o nome) e o card correspondente', () => {
    renderModal({ currentWorkerId: 'w-2' });
    expect(screen.getByTestId('itinerario-editar-prestador')).toHaveTextContent('Elio Fixture');
  });

  it('clicar num card de "Preseleccionados" escolhe o prestador', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('itinerario-editar-selecionar-w-2'));
    expect(screen.getByTestId('itinerario-editar-prestador')).toHaveTextContent('Elio Fixture');
  });

  it('D445 (rodada 2): ocupação aparece sob o nome quando presente (mesma chave i18n de serviceTypes)', () => {
    renderModal({
      options: [{ workerId: 'w-1', displayName: 'Dana Fixture', vacancyId: 'vac-1', occupation: 'CAREGIVER' }],
    });
    expect(screen.getByTestId('itinerario-editar-ocupacao-w-1')).toHaveTextContent(
      i18n.t('admin.patients.detail.contractedServicesCard.serviceTypes.CAREGIVER'),
    );
  });

  it('D445 (rodada 2): sem occupation cadastrada, o card não mostra a linha de ocupação', () => {
    renderModal({ options: [{ workerId: 'w-1', displayName: 'Dana Fixture', vacancyId: 'vac-1', occupation: null }] });
    expect(screen.queryByTestId('itinerario-editar-ocupacao-w-1')).toBeNull();
  });

  it('D445 (rodada 2): o ícone de "ver perfil" abre /admin/workers/:id em nova aba, sem mudar o select', () => {
    renderModal();
    const link = screen.getByTestId('itinerario-editar-ver-perfil-w-2');
    expect(link.getAttribute('href')).toBe('/admin/workers/w-2');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    fireEvent.click(link);
    expect(screen.getByTestId('itinerario-editar-prestador')).not.toHaveTextContent('Elio Fixture');
  });

  it('D445.7: sem fonte para os contadores de raio — NUNCA inventa números, mostra o aviso "sem fonte" e o link para a vaga', () => {
    renderModal();
    expect(screen.getByTestId('itinerario-editar-sem-fonte-contadores')).toHaveTextContent('Invitá prestadores de la zona desde la vacante.');
    // texto de PRODUTO: nada de vocabulário técnico na tela do usuário
    expect(screen.queryByText(/fuente de datos|ambiente|contadores/i)).toBeNull();
    expect(screen.queryByText(/Trabajadores Seleccionados|Selecionados na região/i)).toBeNull();
    expect(screen.queryByText(/Trabajadores.*perfil|perfil de enquadre/i)).toBeNull();
    const link = screen.getByTestId('itinerario-editar-link-vaga');
    expect(link.getAttribute('href')).toBe('/admin/vacancies/vac-1');
  });

  it('sem vaga viva (vacancyId null) → sem link, mostra o aviso "sin vacante"', () => {
    renderModal({ vacancyId: null });
    expect(screen.queryByTestId('itinerario-editar-link-vaga')).toBeNull();
    expect(screen.getByTestId('itinerario-editar-sem-vaga')).toBeInTheDocument();
  });

  it('aviso Ana Care sempre visível (padrão D445)', () => {
    renderModal();
    expect(screen.getByTestId('itinerario-editar-anacare-aviso')).toBeInTheDocument();
  });

  it('options null (carregando) → select desabilitado', () => {
    renderModal({ options: null });
    expect(screen.getByTestId('itinerario-editar-prestador')).toBeDisabled();
  });

  it('options vazio → aviso "sem opções"', () => {
    renderModal({ options: [] });
    expect(screen.getByTestId('itinerario-editar-sem-opcoes')).toBeInTheDocument();
  });

  it('não há botão "Cerrar": Esc fecha o painel (onCancel após a animação)', async () => {
    const { onCancel } = renderModal();
    expect(screen.queryByTestId('itinerario-editar-cancelar')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it('clicar no overlay fecha o painel', async () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByTestId('itinerario-editar-modal-backdrop'));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  describe('Fase 4 — "Quitar del itinerario"', () => {
    it('com prestador atual e onRemove: o botão do prestador atual aparece; o painel só abre ao clicar', () => {
      renderModal({ currentWorkerId: 'w-2', onRemove: vi.fn() });
      expect(screen.queryByTestId('itinerario-quitar-painel')).toBeNull();
      fireEvent.click(screen.getByTestId('itinerario-quitar-w-2'));
      const panel = screen.getByTestId('itinerario-quitar-painel');
      expect(panel).toBeInTheDocument();
      // irmão do modal, não filho (o `transform` do modal prenderia o `fixed` do painel)
      expect(screen.getByTestId('itinerario-editar-modal').contains(panel)).toBe(false);
      expect(screen.getByTestId('itinerario-quitar-prestador')).toHaveTextContent('Elio Fixture');
    });

    it('só o prestador ATUAL da faixa tem o botão (nenhum outro Selecionado)', () => {
      renderModal({ currentWorkerId: 'w-2', onRemove: vi.fn() });
      expect(screen.getByTestId('itinerario-quitar-w-2')).toBeInTheDocument();
      expect(screen.queryByTestId('itinerario-quitar-w-1')).toBeNull();
    });

    it('sem prestador atual, ou sem onRemove: não há ação de quitar', () => {
      const { unmount } = renderModal({ currentWorkerId: null, onRemove: vi.fn() });
      expect(screen.queryByTestId('itinerario-quitar-w-2')).toBeNull();
      unmount();
      renderModal({ currentWorkerId: 'w-2' });
      expect(screen.queryByTestId('itinerario-quitar-w-2')).toBeNull();
    });

    it('prestador atual fora da lista de opções (Em Atendimento): o rótulo cai no fallback com o fim do id, sem lançar', () => {
      renderModal({ currentWorkerId: 'w-12345678-fim', options: [], onRemove: vi.fn() });
      fireEvent.click(screen.getByTestId('itinerario-quitar-w-12345678-fim'));
      expect(screen.getByTestId('itinerario-quitar-prestador').textContent).toContain('5678-fim');
    });

    it('confirmar no painel chama onRemove(motivo, destino)', () => {
      const onRemove = vi.fn();
      renderModal({ currentWorkerId: 'w-2', onRemove });
      fireEvent.click(screen.getByTestId('itinerario-quitar-w-2'));
      fireEvent.change(screen.getByTestId('itinerario-quitar-motivo'), { target: { value: 'OTHER' } });
      fireEvent.click(screen.getByTestId('itinerario-quitar-destino-RESERVE'));
      fireEvent.click(screen.getByTestId('itinerario-quitar-confirmar'));
      expect(onRemove).toHaveBeenCalledWith('OTHER', 'RESERVE');
    });
  });
});
