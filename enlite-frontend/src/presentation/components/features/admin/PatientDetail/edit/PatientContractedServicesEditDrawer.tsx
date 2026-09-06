import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ContractedServiceFormRow } from './ContractedServiceFormRow';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { DiscardChangesConfirm } from './DiscardChangesConfirm';

/** O que o drawer edita: UM serviço novo, ou UM serviço existente (pelo id). */
export type ContractedServiceTarget = { kind: 'new' } | { kind: 'edit'; serviceId: string };

interface Props {
  patient: PatientDetail;
  target: ContractedServiceTarget;
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

/**
 * Drawer de UM serviço contratado por vez (Gabriel, 06/09: "a lista de serviços JÁ VAI ESTAR
 * LISTADA onde temos o botão — não faz sentido ter esse passo"). Antes ele abria com a lista
 * inteira em formulários + "+ Nuevo servicio"; a tabela do card já é a lista, então aqui só
 * entra o serviço que a pessoa escolheu (lápis na linha / botão do detalhe) ou o formulário
 * vazio (botão "+ Nuevo servicio" do card).
 *
 * Spec 014 (US-D4): o drawer não tem "Guardar" próprio — o formulário salva sozinho. O `dirty`
 * do formulário é o que decide a confirmação de fechar. Um serviço NOVO, depois de salvo, vira
 * o alvo de edição (é aí que a seção de prestadores aparece), e o `refetch` traz o id.
 *
 * ⚠️ `onSaved` do PAI só dispara ao FECHAR (não a cada save): `usePatientDetail` derruba a
 * página num `<DetailSkeleton/>` ao refetch, o que desmontaria este drawer no meio do trabalho.
 */
export function PatientContractedServicesEditDrawer({ patient, target: initialTarget, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const [show, setShow] = useState(false);
  const [target, setTarget] = useState<ContractedServiceTarget>(initialTarget);
  const [services, setServices] = useState<PatientContractedServiceDetail[]>(patient.contractedServices);
  const [loadError, setLoadError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [formDirty, setFormDirty] = useState(false);

  const refetch = async (): Promise<PatientContractedServiceDetail[]> => {
    try {
      const fresh = await AdminContractedServicesApiService.listContractedServices(patient.id);
      setServices(fresh);
      setLoadError(false);
      return fresh;
    } catch {
      setLoadError(true);
      return [];
    }
  };

  useEffect(() => {
    refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = (): void => {
    setShow(false);
    // Só agora propaga pro pai (refetch da PÁGINA inteira) — o drawer já está saindo.
    if (dirty) onSaved();
    setTimeout(onClose, CLOSE_MS);
  };

  const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
    isDirty: formDirty,
    onConfirmedClose: handleClose,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  const handleChildSaved = async (): Promise<void> => {
    setDirty(true);
    setFormDirty(false);
    const fresh = await refetch();
    if (target.kind === 'new') {
      // O recém-criado é o mais novo — vira o alvo, e a seção de prestadores passa a existir.
      const novo = [...fresh].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (novo) setTarget({ kind: 'edit', serviceId: novo.id });
    }
  };

  const service = target.kind === 'edit' ? services.find((s) => s.id === target.serviceId) ?? null : null;
  const missing = target.kind === 'edit' && !service;
  const title = target.kind === 'new' ? te('newServiceTitle') : te('editServiceTitle');

  return (
    <>
      {confirmingClose && <DiscardChangesConfirm onKeepEditing={keepEditing} onDiscard={confirmDiscard} />}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={requestClose}
        data-testid="patient-contracted-services-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // `max-w-5xl` (Gabriel, 06/09): a legenda "Franja etaria solicitada del prestador (opcional)"
        // tem de caber numa linha — medido: ~430px; com `max-w-2xl` a coluna tinha ~280px, com
        // `4xl` ~400px (ainda quebrava), com `5xl` ~464px.
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-5xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-contracted-services-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{title}</Heading>
          <button type="button" onClick={requestClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-4">
          {loadError && (
            <Text size="sm" className="text-red-600" data-testid="contracted-services-load-error">{te('saveError')}</Text>
          )}

          {missing && !loadError && (
            <Text size="sm" color="muted" data-testid="contracted-service-missing">{te('serviceNotFound')}</Text>
          )}

          {target.kind === 'new' && (
            <ContractedServiceFormRow
              patientId={patient.id}
              addresses={patient.addresses}
              service={null}
              index={services.length + 1}
              onSaved={handleChildSaved}
              onCancelNew={requestClose}
              onDirtyChange={setFormDirty}
            />
          )}

          {service && (
            <ContractedServiceFormRow
              key={service.id}
              patientId={patient.id}
              addresses={patient.addresses}
              service={service}
              index={Math.max(1, services.findIndex((s) => s.id === service.id) + 1)}
              onSaved={handleChildSaved}
              onDirtyChange={setFormDirty}
            />
          )}
        </div>
      </div>
    </>
  );
}
