/**
 * InterviewHostsPage — `/admin/entrevistadores` (spec 055). Quem atende enquadre e admissão, em que países, e se já vinculou o Tactiq.
 * Cabe SÓ a usuário staff ativo (R1, no backend). Desligar os dois interruptores = Quitar (pede confirmação). A linha sem usuário no
 * sistema (ex.: Ana Joulie) fica marcada, sem interruptores, e só oferece "Quitar".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { UserCog, Plus } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Select } from '@presentation/components/atoms/Select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate, useContainerAccess } from '@presentation/hooks/useCellAccess';
import { AdminInterviewHostApiService } from '@infrastructure/http/AdminInterviewHostApiService';
import type { InterviewHost, InterviewHostInput } from '@domain/entities/InterviewHost';
import { InterviewHostPanel } from './InterviewHostsPage/InterviewHostPanel';
import { QuitInterviewHostModal } from './InterviewHostsPage/QuitInterviewHostModal';
import { InterviewHostSwitch } from './InterviewHostsPage/InterviewHostSwitch';
import { TactiqChip } from './InterviewHostsPage/TactiqChip';
import { interviewHostErrorMessage } from './InterviewHostsPage/interviewHostErrors';

type CountryFilter = 'ALL' | 'AR' | 'BR';
const FLOWS_OFF: Partial<InterviewHostInput> = { doesEnquadre: false, doesAdmission: false };
const nameOf = (h: InterviewHost) => h.displayName ?? h.email;

export default function InterviewHostsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Trava de rota pela CÉLULA da leitura que a tela faz (GET /interview-hosts → interview_host:read).
  const { visible } = useContainerAccess('interview_host');
  useEffect(() => {
    if (!visible) navigate('/admin', { replace: true });
  }, [visible, navigate]);
  const updateGate = useActionGate('interview_host', 'update');

  const [rows, setRows] = useState<InterviewHost[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CountryFilter>('ALL');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<InterviewHost | null>(null);
  const [toQuit, setToQuit] = useState<InterviewHost | null>(null);
  const [quitBusy, setQuitBusy] = useState(false);
  const [quitError, setQuitError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setRows(await AdminInterviewHostApiService.list());
    } catch {
      setLoadError(t('admin.interviewHosts.loadError'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const visibleRows = useMemo(() => rows.filter((r) => filter === 'ALL' || r.countries.includes(filter)), [rows, filter]);

  async function setFlow(row: InterviewHost, flow: 'doesEnquadre' | 'doesAdmission', next: boolean) {
    const after = { ...row, [flow]: next };
    // Desligar os dois interruptores = Quitar (pede confirmação; Cancelar mantém como estava).
    if (!after.doesEnquadre && !after.doesAdmission) {
      setQuitError(null);
      setToQuit(row);
      return;
    }
    setBusyId(row.id);
    setRowError(null);
    try {
      await AdminInterviewHostApiService.update(row.id, { [flow]: next });
      await load();
    } catch (err) {
      setRowError(interviewHostErrorMessage(err, t));
    } finally {
      setBusyId(null);
    }
  }

  async function confirmQuit() {
    if (!toQuit) return;
    setQuitBusy(true);
    setQuitError(null);
    try {
      await AdminInterviewHostApiService.update(toQuit.id, FLOWS_OFF);
      setToQuit(null);
      await load();
    } catch (err) {
      setQuitError(interviewHostErrorMessage(err, t));
    } finally {
      setQuitBusy(false);
    }
  }

  async function submitAdd({ user, countries, doesEnquadre, doesAdmission }: InterviewHostInput & { user: { uid: string } }) {
    await AdminInterviewHostApiService.create({ userUid: user.uid, countries, doesEnquadre, doesAdmission });
    setAddOpen(false);
    await load();
  }

  async function submitEdit({ countries, doesEnquadre, doesAdmission }: InterviewHostInput) {
    if (!editing) return;
    await AdminInterviewHostApiService.update(editing.id, { countries, doesEnquadre, doesAdmission });
    setEditing(null);
    await load();
  }

  return (
    <PageContainer>
      <div className="flex items-start justify-between gap-6 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <UserCog className="w-6 h-6 text-primary" />
            <Heading level={1} weight="semibold" color="primary">{t('admin.interviewHosts.title')}</Heading>
          </div>
          <Text size="sm" color="inherit" className="mt-2 max-w-2xl text-slate-700">{t('admin.interviewHosts.subtitle')}</Text>
        </div>
        <ActionButton resource="interview_host" action="update" variant="primary" onClick={() => setAddOpen(true)} data-testid="agregar-entrevistador">
          <Plus className="w-4 h-4" />
          {t('admin.interviewHosts.add')}
        </ActionButton>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <label htmlFor="ih-filter-country" className="text-sm font-medium text-slate-900">{t('admin.interviewHosts.filterCountry')}</label>
        <div className="w-44">
          <Select
            id="ih-filter-country"
            inputSize="dense"
            value={filter}
            onValueChange={(v) => setFilter(v as CountryFilter)}
            options={[
              { value: 'ALL', label: t('admin.interviewHosts.filterAll') },
              { value: 'AR', label: 'AR' },
              { value: 'BR', label: 'BR' },
            ]}
          />
        </div>
      </div>

      {rowError && (
        <Text size="sm" color="inherit" role="alert" className="mb-3 text-red-800" data-testid="row-error">{rowError}</Text>
      )}

      {loadError ? (
        <div className="py-12 text-center flex flex-col items-center gap-3" data-testid="load-error">
          <Text color="inherit" className="text-red-600">{loadError}</Text>
          <Button variant="outline" size="sm" onClick={() => { setIsLoading(true); void load(); }}>{t('admin.interviewHosts.retry')}</Button>
        </div>
      ) : isLoading ? (
        <TableSkeleton />
      ) : visibleRows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Text size="sm" color="muted" data-testid="empty">
            {rows.length === 0 ? t('admin.interviewHosts.empty') : t('admin.interviewHosts.emptyFiltered')}
          </Text>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-visible">
          <Table scrollable={false}>
            <TableHeader>
              <TableHead>{t('admin.interviewHosts.table.name')}</TableHead>
              <TableHead>{t('admin.interviewHosts.table.email')}</TableHead>
              <TableHead>{t('admin.interviewHosts.table.country')}</TableHead>
              <TableHead align="center">{t('admin.interviewHosts.table.encuadre')}</TableHead>
              <TableHead align="center">{t('admin.interviewHosts.table.admission')}</TableHead>
              <TableHead>{t('admin.interviewHosts.table.tactiq')}</TableHead>
              <TableHead align="right">{t('admin.interviewHosts.table.actions')}</TableHead>
            </TableHeader>
            <TableBody>
              {visibleRows.map((r) => {
                const frozen = r.userMissing || r.userInactive || updateGate.denied || busyId === r.id;
                return (
                  <TableRow key={r.id} clickable={false}>
                    <TableCell unwrapped>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-900">{nameOf(r)}</span>
                        {r.userInactive && (
                          <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800" data-testid="usuario-inactivo">
                            {t('admin.interviewHosts.userInactive')}
                          </span>
                        )}
                        {r.userMissing && (
                          <span
                            className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800"
                            title={t('admin.interviewHosts.userMissingHelp')}
                            data-testid="sin-usuario"
                          >
                            {t('admin.interviewHosts.userMissing')}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{r.email}</TableCell>
                    <TableCell>{r.countries.join(' · ')}</TableCell>
                    <TableCell align="center" unwrapped>
                      <InterviewHostSwitch
                        label={t('admin.interviewHosts.switchLabel', { flow: t('admin.interviewHosts.table.encuadre'), name: nameOf(r) })}
                        checked={r.doesEnquadre}
                        disabled={frozen}
                        onChange={(n) => void setFlow(r, 'doesEnquadre', n)}
                      />
                    </TableCell>
                    <TableCell align="center" unwrapped>
                      <InterviewHostSwitch
                        label={t('admin.interviewHosts.switchLabel', { flow: t('admin.interviewHosts.table.admission'), name: nameOf(r) })}
                        checked={r.doesAdmission}
                        disabled={frozen}
                        onChange={(n) => void setFlow(r, 'doesAdmission', n)}
                      />
                    </TableCell>
                    <TableCell unwrapped><TactiqChip linked={r.tactiq === 'linked'} id={r.id} /></TableCell>
                    <TableCell align="right" unwrapped>
                      {!updateGate.denied && (
                        <>
                          {!r.userMissing && !r.userInactive && (
                            <button
                              type="button"
                              onClick={() => setEditing(r)}
                              className="px-2 py-1 mr-1 rounded text-sm font-medium text-primary hover:bg-primary/5 transition-colors cursor-pointer"
                              data-testid={`editar-${r.id}`}
                            >
                              {t('admin.interviewHosts.edit')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => { setQuitError(null); setToQuit(r); }}
                            className="px-2 py-1 rounded text-sm font-medium text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
                            data-testid={`quitar-${r.id}`}
                          >
                            {t('admin.interviewHosts.quit')}
                          </button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {addOpen && <InterviewHostPanel onSubmit={submitAdd} onClose={() => setAddOpen(false)} />}
      {editing && <InterviewHostPanel editing={editing} onSubmit={submitEdit} onClose={() => setEditing(null)} />}
      {toQuit && (
        <QuitInterviewHostModal
          name={nameOf(toQuit)}
          busy={quitBusy}
          error={quitError}
          onClose={() => setToQuit(null)}
          onConfirm={() => void confirmQuit()}
        />
      )}
    </PageContainer>
  );
}
