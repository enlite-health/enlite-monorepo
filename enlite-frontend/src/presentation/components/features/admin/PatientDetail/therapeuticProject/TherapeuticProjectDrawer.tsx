/**
 * TherapeuticProjectDrawer — a modal LARGA do projeto terapêutico (Figma `6017:14962`; "igual à de
 * serviço contratado", Gabriel Obs2). Três modos:
 *   · `view`  — uma versão, em leitura; "Editar" (→ minor seguinte) e "Exportar PDF";
 *   · `new`   — "Novo": major seguinte, formulário vazio (CID pré-preenchido do cadastro);
 *   · `edit`  — "Editar" a versão de origem: formulário nasce dela; salvar cria a minor seguinte.
 * Subtítulo `V.M.m - Creado por: <nome>` na versão existente (Figma).
 *
 * Exportar (lex C13): busca a versão no servidor A CADA clique (`purpose=export`) — é isso que deixa
 * a linha `export_pdf` na trilha — e gera o PDF no navegador com o que a ficha já tem (C12).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileDown, Pencil } from 'lucide-react';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import type { TherapeuticFieldClass, TherapeuticProjectVersion, TherapeuticProjectVersionBody } from '@domain/entities/TherapeuticProject';
import { AdminTherapeuticProjectsApiService } from '@infrastructure/http/AdminTherapeuticProjectsApiService';
import { saveRefusalMessage } from './saveRefusalMessage';
import { useTherapeuticCatalogs } from '@hooks/admin/useTherapeuticProjects';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { TherapeuticProjectForm } from './TherapeuticProjectForm';
import { TherapeuticProjectVersionView } from './TherapeuticProjectVersionView';
import { buildTherapeuticProjectPdfInput } from './pdf/buildTherapeuticProjectPdfInput';
import { pdfFileName, renderTherapeuticProjectPdfBlob } from './pdf/renderTherapeuticProjectPdf';
import i18n from '@infrastructure/i18n/config';
import logoEnlite from '../../../../../../assets/logo-enlite.png';

export type TherapeuticProjectTarget =
  | { mode: 'new' }
  // D328 item 3: a tela SÓ oferece "Editar" quando `version` é a VIGENTE — `isCurrent` vem de quem
  // abre o drawer (o dono da lista completa), nunca recalculado aqui a partir de UMA versão isolada.
  | { mode: 'view'; version: TherapeuticProjectVersion; isCurrent: boolean }
  | { mode: 'edit'; version: TherapeuticProjectVersion };

interface Props {
  patient: PatientDetail;
  target: TherapeuticProjectTarget;
  /** Lista MACRO×MICRO da API (task 7.7) — o form lê daqui, nunca copia. */
  fieldClass: TherapeuticFieldClass;
  onClose: () => void;
  /** Uma versão foi criada — o pai recarrega a lista. */
  onSaved: () => void;
}

const CLOSE_MS = 300;


export function TherapeuticProjectDrawer({ patient, target: initial, fieldClass, onClose, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const tf = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectForm.${k}`, o ?? {});
  const [show, setShow] = useState(false);
  const [target, setTarget] = useState<TherapeuticProjectTarget>(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const isForm = target.mode !== 'view';
  const { catalogs, error: catalogsError } = useTherapeuticCatalogs(isForm);

  // As seções do PDF seguem as MESMAS células dos cards (lex C12) — lidas aqui, uma vez.
  const reads = {
    identity: useContainerAccess('patient_identity').visible,
    coverage: useContainerAccess('patient_coverage').visible,
    address: useContainerAccess('patient_address').visible,
    family: useContainerAccess('patient_family').visible,
    careTeam: useContainerAccess('patient_care_team').visible,
    services: useContainerAccess('patient_services').visible,
  };

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const close = (): void => {
    setShow(false);
    closeTimer.current = setTimeout(onClose, CLOSE_MS);
  };
  const requestClose = (): void => {
    if (dirty && !window.confirm(tf('discardConfirm'))) return;
    close();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const handleSubmit = async (body: TherapeuticProjectVersionBody): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const created = target.mode === 'edit'
        ? await AdminTherapeuticProjectsApiService.createVersion(patient.id, { mode: 'edit', fromVersionId: target.version.id, version: body })
        : await AdminTherapeuticProjectsApiService.createVersion(patient.id, { mode: 'new', version: body });
      setDirty(false);
      onSaved();
      // A versão recém-criada é sempre a vigente (é a de `created_at` mais recente, D328).
      // Conserto 14/09 (achado no e2e da task 7.8, PR-7): `POST .../therapeutic-projects` devolve a
      // versão CRUA — `AdminTherapeuticProjectsController.create` nunca chama `resolveContacts`
      // (só `list`/`get` fazem isso) — então `created.contacts` vem `undefined`. Antes deste
      // conserto, `TherapeuticProjectVersionView` (`!compact`) lia `v.contacts.length` sem guarda e
      // a página INTEIRA quebrava (error boundary) assim que o "Guardar" fechava a modal de
      // criação/edição. `?? []` mantém a mesma verdade que a leitura já tinha ANTES desta versão
      // existir (nenhum contato resolvido ainda) — a lista completa (com nome/telefone) chega no
      // próximo `refetch` da tela (`onSaved`, já disparado acima), sem crashar nesse meio-tempo.
      setTarget({ mode: 'view', version: { ...created, contacts: created.contacts ?? [] }, isCurrent: true });
    } catch (err: unknown) {
      setSaveError(saveRefusalMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async (version: TherapeuticProjectVersion): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const fresh = await AdminTherapeuticProjectsApiService.getVersion(patient.id, version.id, { purpose: 'export' });
      const fixedEs = i18n.getFixedT('es');
      // Todo chamador passa fallback (o valor cru do enum); `defaultValue` cobre os dois casos.
      const tEs = (key: string, fallback?: string): string => fixedEs(key, { defaultValue: fallback });
      const input = buildTherapeuticProjectPdfInput({ patient, version: fresh, reads, tEs, logoSrc: logoEnlite });
      const blob = await renderTherapeuticProjectPdfBlob(input);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pdfFileName(input);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const title = target.mode === 'new' ? tf('newTitle') : t('admin.patients.detail.therapeuticProjectCard.title');
  const subtitle = target.mode === 'new'
    ? tf('newSubtitle')
    : tf('versionSubtitle', { version: target.version.version, author: target.version.createdByName ?? '—' });

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={requestClose}
        data-testid="therapeutic-project-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-6xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="therapeutic-project-drawer"
        data-mode={target.mode}
      >
        <div className="flex items-start justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <div className="flex flex-col gap-1">
            <Heading level={3} weight="semibold" color="primary">{title}</Heading>
            <Text size="base" weight="medium" color="primary" data-testid="therapeutic-project-subtitle">{subtitle}</Text>
          </div>
          <div className="flex items-center gap-2">
            {target.mode === 'view' && (
              <>
                {/* lex C13: exportar busca a versão de novo — é essa chamada que deixa a trilha `export_pdf`.
                    Célula `patient_therapeutic_project:export` (contrato PR-7) — sem ela o botão SOME (D269), mesmo mecanismo do Editar acima. */}
                <ActionButton resource="patient_therapeutic_project" action="export" variant="outline" size="sm" onClick={() => handleExport(target.version)} disabled={exporting || target.version.annulledAt !== null} className="flex items-center gap-1" data-testid="therapeutic-project-export-btn">
                  <FileDown className="w-4 h-4" />
                  {exporting ? tf('exporting') : tf('exportPdf')}
                </ActionButton>
                {/* D328 item 3: versão antiga (não vigente) não oferece edição na tela, mesmo não-anulada. */}
                {target.version.annulledAt === null && target.isCurrent && (
                  <ActionButton resource="patient_therapeutic_project" action="write" variant="primary" size="sm" onClick={() => setTarget({ mode: 'edit', version: target.version })} className="flex items-center gap-1" data-testid="therapeutic-project-edit-btn">
                    <Pencil className="w-4 h-4" />
                    {t('admin.patients.detail.edit')}
                  </ActionButton>
                )}
              </>
            )}
            <button type="button" onClick={requestClose} aria-label={t('common.close')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded" data-testid="therapeutic-project-close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {exportError && (
            <div className="mb-4 border border-red-300 bg-red-50 rounded-lg px-4 py-3" role="alert" data-testid="therapeutic-project-export-error">
              <Text size="sm" className="text-red-700">{exportError}</Text>
            </div>
          )}
          {target.mode === 'view' && <TherapeuticProjectVersionView version={target.version} services={patient.contractedServices} servicesRedacted={!reads.services} />}
          {isForm && catalogsError && (
            <Text size="sm" className="text-red-600" data-testid="therapeutic-project-catalogs-error">{catalogsError}</Text>
          )}
          {isForm && !catalogsError && !catalogs && (
            <Text size="sm" color="muted" data-testid="therapeutic-project-catalogs-loading">{tf('loadingCatalogs')}</Text>
          )}
          {isForm && catalogs && (
            <TherapeuticProjectForm
              services={patient.contractedServices}
              patientDiagnoses={patient.diagnoses}
              catalogs={catalogs}
              fieldClass={fieldClass}
              responsibles={patient.responsibles}
              externalContacts={patient.externalContacts ?? []}
              coverageEmergencyContacts={patient.coverageEmergencyContacts ?? []}
              professionals={patient.professionals}
              from={target.mode === 'edit' ? target.version : null}
              saving={saving}
              saveError={saveError}
              onSubmit={handleSubmit}
              onCancel={requestClose}
              onDirty={() => setDirty(true)}
            />
          )}
        </div>
      </div>
    </>
  );
}
