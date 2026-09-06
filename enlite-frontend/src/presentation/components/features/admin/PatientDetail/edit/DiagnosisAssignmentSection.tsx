/**
 * DiagnosisAssignmentSection — compõe busca + chips dentro do drawer clínico (spec 016 F3).
 *
 * Cada ação (escolher, promover, remover) já É o "salvar" — chama a API imediatamente (não
 * existe "rascunho" de diagnóstico: o contrato do backend não tem batch). `onChanged` dispara o
 * refetch do paciente no componente pai (molde `onSaved={refetch}` dos outros cards da ficha) —
 * assim a ficha mostra a patología nova sem depender do botão "Guardar" do formulário geral, que
 * só existe para os OUTROS campos da seção clínica.
 *
 * Escopo: só lista/edita diagnósticos `source==='PANEL'` — é a única origem que este controller
 * (`AdminPatientDiagnosesController`) permite mutar (D263: o escritor do painel é fisicamente
 * incapaz de tocar uma linha CLICKUP/BACKFILL). Mostrar aqui um chip de outra origem cujos
 * botões dessem 404 em silêncio seria pior do que não mostrar.
 *
 * Cláusula 1.3 da licença da OMS: atribuição sempre visível junto da busca — e LEGÍVEL: em `muted`
 * (cinza a 50%) ela estava na tela sem que ninguém conseguisse ler (05/09).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';
import type { TerminologyCandidate } from '@domain/entities/Terminology';
import { AdminDiagnosisApiService, DiagnosisApiError, type DiagnosisApiErrorCode } from '@infrastructure/http/AdminDiagnosisApiService';
import { IcdSearchCombobox } from './IcdSearchCombobox';
import { DiagnosisChipList, type ChipBusy } from './DiagnosisChipList';

export interface DiagnosisAssignmentSectionProps {
  patientId: string;
  initialDiagnoses: PatientDiagnosisDetail[];
  onChanged: () => void;
  /** id do título que nomeia a busca (repassado ao combobox como `aria-labelledby`). */
  ariaLabelledBy?: string;
}

const ERROR_KEY: Partial<Record<DiagnosisApiErrorCode, string>> = {
  CONCEPT_NOT_RESOLVED: 'addError',
  CONCEPT_NOT_DIAGNOSABLE: 'notDiagnosableError',
  DIAGNOSIS_ALREADY_ACTIVE: 'alreadyActiveError',
  PRIMARY_DIAGNOSIS_RACE: 'updateError',
  DIAGNOSIS_NOT_ACTIVE: 'updateError',
};

export function DiagnosisAssignmentSection({
  patientId,
  initialDiagnoses,
  onChanged,
  ariaLabelledBy,
}: DiagnosisAssignmentSectionProps): JSX.Element {
  const { t } = useTranslation();
  const ta = (k: string) => t(`admin.patients.editDrawer.diagnosisAssignment.${k}`);

  const [diagnoses, setDiagnoses] = useState<PatientDiagnosisDetail[]>(
    initialDiagnoses.filter((d) => d.active && d.source === 'PANEL'),
  );
  /** Ação em voo num chip existente (PATCH promover / PATCH desativar) — o chip mostra "Guardando…"/"Quitando…". */
  const [busy, setBusy] = useState<ChipBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 06/09 (Gabriel): "quando eu clico qual CID-11 eu quero, demora uns milissegundos para aparecer —
   * precisamos de um aviso de carregando para o usuário entender que NÃO TRAVOU". Entre o clique e o
   * POST responder, o título escolhido aparece como chip PROVISÓRIO ("Agregando…", com spinner) no
   * lugar onde o chip real vai entrar; some quando a API responde (sucesso → chip real; erro → mensagem).
   */
  const [pendingTitle, setPendingTitle] = useState<string | null>(null);

  function mapError(err: unknown): string {
    if (err instanceof DiagnosisApiError && err.code && ERROR_KEY[err.code]) {
      return ta(ERROR_KEY[err.code] as string);
    }
    return ta('genericError');
  }

  async function handleSelect(candidate: TerminologyCandidate): Promise<void> {
    setError(null);
    setPendingTitle(candidate.title);
    try {
      const created = await AdminDiagnosisApiService.create(patientId, candidate.uri);
      setDiagnoses((prev) => [...prev, created]);
      onChanged();
    } catch (err) {
      setError(mapError(err));
    } finally {
      setPendingTitle(null);
    }
  }

  async function handlePromote(id: string): Promise<void> {
    setError(null);
    setBusy({ id, action: 'promote' });
    try {
      const promoted = await AdminDiagnosisApiService.promote(patientId, id);
      setDiagnoses((prev) => prev.map((d) => (d.id === promoted.id ? promoted : { ...d, isPrimary: false })));
      onChanged();
    } catch (err) {
      setError(mapError(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setError(null);
    setBusy({ id, action: 'remove' });
    try {
      await AdminDiagnosisApiService.deactivate(patientId, id);
      setDiagnoses((prev) => prev.filter((d) => d.id !== id));
      onChanged();
    } catch (err) {
      setError(mapError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="diagnosis-assignment-section">
      <IcdSearchCombobox id="icd-search" onSelect={handleSelect} ariaLabelledBy={ariaLabelledBy} disabled={pendingTitle !== null} />
      <DiagnosisChipList diagnoses={diagnoses} busy={busy} pendingTitle={pendingTitle} onPromote={handlePromote} onRemove={handleRemove} />
      {error && (
        <Text as="span" size="xs" className="!text-red-600" data-testid="diagnosis-assignment-error">
          {error}
        </Text>
      )}
      {/* Cláusula 1.3 da licença OMS — atribuição obrigatória, discreta, sempre presente. */}
      <Text as="span" size="2xs" color="secondary" data-testid="who-attribution">
        {ta('whoAttribution')}
      </Text>
    </div>
  );
}
