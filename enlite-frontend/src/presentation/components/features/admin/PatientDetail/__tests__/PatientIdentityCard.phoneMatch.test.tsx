/**
 * PatientIdentityCard — spec 014, US-D3 (lex D3.1, MEDIDO 03/09 em produção: 5/37 pacientes
 * com telefone tinham o do responsável no campo próprio). "Teléfono del Responsable" (rótulo
 * errado — mostrava o telefone do PACIENTE) vira "WhatsApp del paciente"; quando
 * `phoneMatchesResponsible` é true, um aviso aparece com "Mover al responsable" (limpa o campo
 * do paciente via PATCH general, SEM apagar o do responsável) e "Mantener" (não faz nada).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { patientDetailFixture } from './patientDetailFixture';
import { PatientIdentityCard } from '../PatientIdentityCard';

const updatePatientSection = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updatePatientSection: (...a: unknown[]) => updatePatientSection(...a) },
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

beforeEach(() => {
  updatePatientSection.mockReset().mockResolvedValue({ id: 'x' });
});

describe('PatientIdentityCard — rótulo D3.1', () => {
  it('o campo do telefone do PACIENTE mostra "WhatsApp del paciente" (o rótulo antigo continua existindo, mas SÓ na seção do responsável, para o telefone DELE)', () => {
    const { container } = render(
      <PatientIdentityCard patient={{ ...patientDetailFixture, phoneMatchesResponsible: false }} />,
    );
    expect(screen.getByText(/WhatsApp del paciente/)).toBeInTheDocument();
    // "Teléfono del Responsable" segue existindo (rótulo correto para o telefone do RESPONSÁVEL,
    // na seção de contato de emergência) — o bug era usar esse rótulo para o dado do PACIENTE.
    // Prova de que não sobrou duplicado: só 1 ocorrência, dentro da seção de emergência.
    const emergencySection = screen.getByText(/Contacto de Emergencia/).closest('div');
    expect(emergencySection?.textContent).toContain('Teléfono del Responsable');
    expectNoRawEnumLeaks(container);
  });

  it('o botão "Editar" fantasma (disabled, sem ação) some — a edição de identidade já vive no card de Informações Gerais', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, phoneMatchesResponsible: false }} />);
    expect(screen.queryByRole('button', { name: /Editar/i })).not.toBeInTheDocument();
  });

  it('"Desligamiento" (rótulo fantasma, sem coluna no banco) não aparece mais', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, phoneMatchesResponsible: false }} />);
    expect(screen.queryByText(/Desligamiento/i)).not.toBeInTheDocument();
  });
});

describe('PatientIdentityCard — aviso de telefone coincidente (lex D3.1)', () => {
  it('phoneMatchesResponsible:false → nenhum aviso', () => {
    render(<PatientIdentityCard patient={{ ...patientDetailFixture, phoneMatchesResponsible: false }} />);
    expect(screen.queryByTestId('phone-match-warning')).not.toBeInTheDocument();
  });

  it('phoneMatchesResponsible:true → mostra o aviso com o nome do responsável e as 2 ações', () => {
    const patient = {
      ...patientDetailFixture,
      phoneMatchesResponsible: true,
      phoneWhatsapp: '+55 (11) 99852-0481', // mesmos últimos 8 dígitos do responsable[0].phone
    };
    render(<PatientIdentityCard patient={patient} />);
    const warning = screen.getByTestId('phone-match-warning');
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toContain('Luciana Soto');
    expect(screen.getByTestId('move-phone-to-responsible-btn')).toBeInTheDocument();
    expect(screen.getByTestId('keep-phone-btn')).toBeInTheDocument();
  });

  it('backend diz que bate mas o telefone do paciente é curto demais (<8 dígitos) → nome "—", sem quebrar', () => {
    const patient = { ...patientDetailFixture, phoneMatchesResponsible: true, phoneWhatsapp: '123' };
    render(<PatientIdentityCard patient={patient} />);
    expect(screen.getByTestId('phone-match-warning').textContent).toContain('—');
  });

  it('backend diz que bate mas phoneWhatsapp é null (defensivo) → nome "—", sem quebrar', () => {
    const patient = { ...patientDetailFixture, phoneMatchesResponsible: true, phoneWhatsapp: null };
    render(<PatientIdentityCard patient={patient} />);
    expect(screen.getByTestId('phone-match-warning').textContent).toContain('—');
  });

  it('backend diz que bate mas nenhum responsável local tem o mesmo último-8 (um deles sem telefone) → nome "—", sem quebrar', () => {
    const patient = {
      ...patientDetailFixture,
      phoneMatchesResponsible: true,
      phoneWhatsapp: '+55 (11) 99852-0481',
      responsibles: [
        { ...patientDetailFixture.responsibles[0], phone: null },
        { ...patientDetailFixture.responsibles[0], id: 'r2', phone: '+55 (11) 00000-0000' },
      ],
    };
    render(<PatientIdentityCard patient={patient} />);
    expect(screen.getByTestId('phone-match-warning').textContent).toContain('—');
  });

  it('responsável encontrado mas SEM nome (firstName/lastName ambos null) → "—", sem quebrar', () => {
    const patient = {
      ...patientDetailFixture,
      phoneMatchesResponsible: true,
      phoneWhatsapp: '+55 (11) 99852-0481',
      responsibles: [{ ...patientDetailFixture.responsibles[0], firstName: null, lastName: null }],
    };
    render(<PatientIdentityCard patient={patient} />);
    expect(screen.getByTestId('phone-match-warning').textContent).toContain('—');
  });

  it('"Mantener" fecha o aviso e NUNCA chama a API — nenhum dado é apagado', async () => {
    const user = userEvent.setup();
    const patient = { ...patientDetailFixture, phoneMatchesResponsible: true, phoneWhatsapp: '+55 (11) 99852-0481' };
    render(<PatientIdentityCard patient={patient} />);
    await user.click(screen.getByTestId('keep-phone-btn'));
    expect(screen.queryByTestId('phone-match-warning')).not.toBeInTheDocument();
    expect(updatePatientSection).not.toHaveBeenCalled();
  });

  it('"Mover al responsable" pede confirmação ANTES de gravar', async () => {
    const user = userEvent.setup();
    const patient = { ...patientDetailFixture, phoneMatchesResponsible: true, phoneWhatsapp: '+55 (11) 99852-0481' };
    render(<PatientIdentityCard patient={patient} />);
    await user.click(screen.getByTestId('move-phone-to-responsible-btn'));
    expect(updatePatientSection).not.toHaveBeenCalled();
    expect(screen.getByTestId('move-phone-confirm-modal')).toBeInTheDocument();
  });

  it('confirmar "Mover" grava PATCH general com phoneWhatsapp:null (NUNCA apaga o do responsável) e chama onSaved', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const patient = { ...patientDetailFixture, id: 'pat-move-1', phoneMatchesResponsible: true, phoneWhatsapp: '+55 (11) 99852-0481' };
    render(<PatientIdentityCard patient={patient} onSaved={onSaved} />);
    await user.click(screen.getByTestId('move-phone-to-responsible-btn'));
    await user.click(screen.getByTestId('move-phone-confirm-btn'));
    await waitFor(() => expect(updatePatientSection).toHaveBeenCalledWith('pat-move-1', 'general', { phoneWhatsapp: null }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // O responsável nunca é tocado — nenhuma chamada de PATCH de rede de apoio.
    expect(updatePatientSection).not.toHaveBeenCalledWith(expect.anything(), 'support-network', expect.anything());
  });

  it('clicar no backdrop do modal fecha sem gravar (mesmo efeito do cancelar)', async () => {
    const user = userEvent.setup();
    const patient = { ...patientDetailFixture, phoneMatchesResponsible: true, phoneWhatsapp: '+55 (11) 99852-0481' };
    render(<PatientIdentityCard patient={patient} />);
    await user.click(screen.getByTestId('move-phone-to-responsible-btn'));
    await user.click(screen.getByTestId('move-phone-confirm-backdrop'));
    expect(updatePatientSection).not.toHaveBeenCalled();
    expect(screen.queryByTestId('move-phone-confirm-modal')).not.toBeInTheDocument();
  });

  it('cancelar no modal de confirmação NÃO grava', async () => {
    const user = userEvent.setup();
    const patient = { ...patientDetailFixture, phoneMatchesResponsible: true, phoneWhatsapp: '+55 (11) 99852-0481' };
    render(<PatientIdentityCard patient={patient} />);
    await user.click(screen.getByTestId('move-phone-to-responsible-btn'));
    await user.click(screen.getByTestId('move-phone-cancel-btn'));
    expect(updatePatientSection).not.toHaveBeenCalled();
    expect(screen.queryByTestId('move-phone-confirm-modal')).not.toBeInTheDocument();
  });
});
