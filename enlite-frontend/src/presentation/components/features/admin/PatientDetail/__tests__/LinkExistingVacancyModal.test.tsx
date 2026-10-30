/** LinkExistingVacancyModal (spec 079, T031): candidatas, prévia, bloqueio, confirmação e erros 409/422. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { LinkExistingVacancyModal } from '../LinkExistingVacancyModal';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { AdminLinkExistingVacancyApiService } from '@infrastructure/http/AdminLinkExistingVacancyApiService';
import type { LinkPreview, LinkableVacancy } from '@domain/entities/LinkExistingVacancy';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));
vi.mock('@infrastructure/http/AdminLinkExistingVacancyApiService', () => ({
  AdminLinkExistingVacancyApiService: { preview: vi.fn(), link: vi.fn() },
}));

const P = AdminLinkExistingVacancyApiService as unknown as { preview: ReturnType<typeof vi.fn>; link: ReturnType<typeof vi.fn> };
const K = (translations.admin.patients.detail.contractedServicesCard.linkExistingVacancy) as Record<string, any>;

const CAND: LinkableVacancy = {
  id: 'v-1', caseNumber: 1234, caseOrdinal: 1, vacancyNumber: 7, title: 'Vaga legada', status: 'SEARCHING', isDraft: false, createdAt: '2026-09-01T00:00:00Z',
};
const prev = (o: Partial<LinkPreview> = {}): LinkPreview => ({
  vacancyId: 'v-1', rows: [], warnings: [], blockers: [], canConfirm: true, ...o,
});

async function openAndChoose() {
  const onLinked = vi.fn(); const onClose = vi.fn();
  render(<LinkExistingVacancyModal open patientId="p1" serviceId="s1" serviceLabel="Serviço" onClose={onClose} onLinked={onLinked} />);
  fireEvent.click(await screen.findByTestId('link-existing-vacancy-combo'));
  fireEvent.click((await screen.findByRole('option', { name: /Vaga legada/ })).querySelector('button') as HTMLElement);
  return { onLinked, onClose };
}

describe('LinkExistingVacancyModal', () => {
  beforeEach(() => { P.preview.mockReset(); P.link.mockReset(); });

  it('abre, chama a prévia sem vacancyId e lista as candidatas', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null });
    render(<LinkExistingVacancyModal open patientId="p1" serviceId="s1" serviceLabel="Serviço" onClose={vi.fn()} onLinked={vi.fn()} />);
    expect(screen.getByText(K.loading)).toBeTruthy();
    fireEvent.click(await screen.findByTestId('link-existing-vacancy-combo'));
    expect(await screen.findByRole('option', { name: /Vaga legada/ })).toBeTruthy();
    expect(P.preview).toHaveBeenCalledWith('p1', 's1');
  });

  it('sem candidatas mostra noCandidates', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [], preview: null });
    render(<LinkExistingVacancyModal open patientId="p1" serviceId="s1" serviceLabel="Serviço" onClose={vi.fn()} onLinked={vi.fn()} />);
    expect(await screen.findByText(K.noCandidates)).toBeTruthy();
  });

  it('escolher chama a prévia com vacancyId e a tabela mostra só as rows', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null }).mockResolvedValueOnce({
      candidates: [CAND],
      preview: prev({ rows: [{ field: 'payment_day', vacancyValue: null, effectiveValue: [5, 10], origin: 'VACANCY' }] }),
    });
    await openAndChoose();
    const box = await screen.findByTestId('link-existing-vacancy-preview');
    expect(P.preview).toHaveBeenLastCalledWith('p1', 's1', 'v-1');
    expect(box.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(box.textContent).toContain(K.field.payment_day);
    expect(box.textContent).toContain('5, 10');
    expect(box.textContent).toContain(K.originVacancy);
  });

  it('aviso traduzido com o nome do campo', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null }).mockResolvedValueOnce({
      candidates: [CAND], preview: prev({ warnings: [{ field: 'providers_needed', code: 'PROVIDERS_NEEDED_NOT_INTEGER' }] }),
    });
    await openAndChoose();
    const w = await screen.findByTestId('link-existing-vacancy-warnings');
    expect(w.textContent).toContain(K.field.providers_needed);
    expect(w.textContent).toContain(K.warning.PROVIDERS_NEEDED_NOT_INTEGER);
  });

  it('bloqueio traduzido e confirmar DESABILITADO', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null }).mockResolvedValueOnce({
      candidates: [CAND], preview: prev({ blockers: ['ADDRESS_MISMATCH', 'SERVICE_SCHEDULE'], canConfirm: false }),
    });
    await openAndChoose();
    const b = await screen.findByTestId('link-existing-vacancy-blockers');
    expect(b.textContent).toContain(K.blockedTitle);
    expect(b.textContent).toContain(K.blocker.ADDRESS_MISMATCH);
    expect(b.textContent).not.toContain('SERVICE_SCHEDULE');
    expect((screen.getByTestId('link-existing-vacancy-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('canConfirm: confirmar chama link e onLinked', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null }).mockResolvedValueOnce({ candidates: [CAND], preview: prev() });
    P.link.mockResolvedValueOnce({ vacancyId: 'v-1', serviceId: 's1', fedFields: [] });
    const { onLinked, onClose } = await openAndChoose();
    await screen.findByText(K.noChanges);
    const btn = screen.getByTestId('link-existing-vacancy-confirm') as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(P.link).toHaveBeenCalledWith('p1', 's1', 'v-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('409 VACANCY_NOT_LINKABLE mostra o erro traduzido', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null }).mockResolvedValueOnce({ candidates: [CAND], preview: prev() });
    P.link.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'VACANCY_NOT_LINKABLE', reason: 'ALREADY_LINKED' }));
    const { onLinked } = await openAndChoose();
    const btn = screen.getByTestId('link-existing-vacancy-confirm') as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', K.error.VACANCY_NOT_LINKABLE);
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('422 LINK_BLOCKED mostra os blockers do erro', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null }).mockResolvedValueOnce({ candidates: [CAND], preview: prev() });
    P.link.mockRejectedValueOnce(new ContractedServiceApiError('x', 422, { code: 'LINK_BLOCKED', blockers: ['ADDRESS_MISMATCH'] }));
    await openAndChoose();
    const btn = screen.getByTestId('link-existing-vacancy-confirm') as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    expect((await screen.findByRole('alert')).textContent).toBe(K.error.LINK_BLOCKED);
    expect(screen.getByTestId('link-existing-vacancy-blockers').textContent).toContain(K.blocker.ADDRESS_MISMATCH);
  });

  it('prévia traduz enums (sem BOTH/part-time/AT crus) e o diálogo é alinhado à esquerda', async () => {
    P.preview.mockResolvedValueOnce({ candidates: [CAND], preview: null }).mockResolvedValueOnce({
      candidates: [CAND],
      preview: prev({ rows: [
        { field: 'required_sex', vacancyValue: 'BOTH', effectiveValue: 'BOTH', origin: 'SERVICE' },
        { field: 'work_schedule', vacancyValue: 'part-time', effectiveValue: 'part-time', origin: 'SERVICE' },
        { field: 'required_professions', vacancyValue: ['AT'], effectiveValue: ['AT'], origin: 'SERVICE' },
      ] }),
    });
    await openAndChoose();
    const box = await screen.findByTestId('link-existing-vacancy-preview');
    // por célula: textContent da tabela cola as células (BOTHBOTH) e o regex do guard não casaria
    box.querySelectorAll('td').forEach((td) => expectNoRawEnumLeaks(td as HTMLElement));
    const vf = translations.admin.vacancyDetail.vacancyForm;
    expect(box.textContent).toContain(vf.sexOptions.BOTH);
    expect(box.textContent).toContain(vf.workScheduleOptions['part-time']);
    expect(box.textContent).toContain(vf.professionOptions.AT);
    expect(box.textContent).not.toMatch(/part-time|\bAT\b/);
    expect(screen.getByRole('dialog').className).toContain('text-left');
  });
});
