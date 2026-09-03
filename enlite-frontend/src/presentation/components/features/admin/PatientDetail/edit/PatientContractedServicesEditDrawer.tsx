import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ContractedServiceFormRow } from './ContractedServiceFormRow';

interface Props {
  patient: PatientDetail;
  onClose: () => void;
  onSaved: () => void;
}

const CLOSE_MS = 300;

/**
 * Drawer "Editar servicios contratados" (spec 013, bloco C) — vira LISTA + formulário por
 * serviço (fim do drawer de campo único, `#PEND-08`). "+ Nuevo" adiciona; cada serviço tem
 * "Dar de baja" (sem DELETE, lex C-a.4) e a seção de prestadores alocados.
 *
 * Fonte de verdade DEPOIS de montar: refetch próprio (`AdminContractedServicesApiService`), não
 * `patient.contractedServices` — o drawer fica aberto durante várias mutações (criar serviço,
 * associar prestador…) e cada uma precisa refletir na lista sem fechar/reabrir.
 *
 * ⚠️ `onSaved` do PAI só dispara ao FECHAR (não a cada save intermediário): `usePatientDetail`
 * põe a página inteira em `isLoading` durante o refetch e `PatientDetailPage` devolve
 * `<DetailSkeleton/>` enquanto isso — o que desmonta a árvore inteira, INCLUSIVE o `editing`
 * local do card que mantém este drawer aberto. Chamar `onSaved` a cada serviço salvo fecharia o
 * drawer sozinho no meio de uma sessão de "+ Nuevo servicio" × N (achado 03/09, e2e
 * `admission-c-servico-contratado`: o botão "+ Nuevo" ficava "detached from DOM, retrying" até
 * estourar o timeout). Os OUTROS drawers da ficha não batem nisso porque fecham a si mesmos no
 * mesmo instante que chamam `onSaved` — aqui o padrão é ficar aberto de propósito.
 */
export function PatientContractedServicesEditDrawer({ patient, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  const [show, setShow] = useState(false);
  const [services, setServices] = useState<PatientContractedServiceDetail[]>(patient.contractedServices);
  const [addingNew, setAddingNew] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [dirty, setDirty] = useState(false);

  const refetch = async (): Promise<void> => {
    try {
      const fresh = await AdminContractedServicesApiService.listContractedServices(patient.id);
      setServices(fresh);
      setLoadError(false);
    } catch {
      setLoadError(true);
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
    // Só agora propaga pro pai (refetch da PÁGINA inteira) — o drawer já está saindo, então o
    // flash de <DetailSkeleton/> não derruba nada que ainda precise ficar aberto.
    if (dirty) onSaved();
    setTimeout(onClose, CLOSE_MS);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChildSaved = async (): Promise<void> => {
    setAddingNew(false);
    setDirty(true);
    await refetch();
  };

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={handleClose}
        data-testid="patient-contracted-services-edit-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={te('contractedServicesTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-2xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="patient-contracted-services-edit-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={3} weight="semibold" color="primary">{te('contractedServicesTitle')}</Heading>
          <button type="button" onClick={handleClose} aria-label={te('close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-4">
          {loadError && (
            <Text size="sm" className="text-red-600" data-testid="contracted-services-load-error">{te('saveError')}</Text>
          )}

          {services.length === 0 && !addingNew && (
            <Text size="sm" color="muted" data-testid="contracted-services-empty">{te('noContractedServices')}</Text>
          )}

          {services.map((svc, i) => (
            <ContractedServiceFormRow
              key={svc.id}
              patientId={patient.id}
              service={svc}
              index={i + 1}
              onSaved={handleChildSaved}
            />
          ))}

          {addingNew && (
            <ContractedServiceFormRow
              patientId={patient.id}
              service={null}
              index={services.length + 1}
              onSaved={handleChildSaved}
              onCancelNew={() => setAddingNew(false)}
            />
          )}

          {!addingNew && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAddingNew(true)}
              className="flex items-center gap-1 w-fit"
              data-testid="contracted-service-add"
            >
              <Plus className="w-4 h-4" />
              {te('addContractedService')}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
