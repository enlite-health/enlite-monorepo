/**
 * InsuranceProvidersPage — lista de obras sociais (spec 058 §4.2): busca por nome, "mostrar inativas" e criar SÓ com o nome, em modal.
 * O `code` é derivado do nome pelo back e nunca muda; `aliases` (outros nomes) é opcional. Se o nome não gera código
 * (`NAME_NOT_CODIFIABLE`) a tela passa a pedir o código. Criada, a obra social abre na página de cartões para ser completada.
 *
 * Tipo do pagador na lista é só leitura (quem classifica é o cartão Dados gerais).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, Plus } from 'lucide-react';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Heading } from '@presentation/components/atoms/Heading';
import { Input } from '@presentation/components/atoms/Input';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@presentation/components/atoms/Table';
import { Text } from '@presentation/components/atoms/Text';
import { Field } from './InsuranceProviderDetailPage/Field';
import { FormModal } from './InsuranceProviderDetailPage/FormModal';
import { ActionButton } from '@presentation/components/features/access';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import type { InsuranceProviderListItem } from '@domain/entities/InsuranceProviderDetail';
import { insuranceErrorCode, insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { parseAliases } from './InsuranceProviderDetailPage/aliases';

const NS = 'admin.insuranceProviders';

export default function InsuranceProvidersPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { visible } = useContainerAccess('catalog_insurance_providers');
  useEffect(() => {
    if (!visible) navigate('/admin', { replace: true });
  }, [visible, navigate]);

  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [items, setItems] = useState<InsuranceProviderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Busca com pequena espera: não chama a API a cada tecla.
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      AdminInsuranceApiService.listProviders({ search: search.trim() || undefined, includeInactive: includeInactive || undefined })
        .then((res) => { if (!cancelled) { setItems(res); setLoadError(null); } })
        .catch((err: unknown) => { if (!cancelled) setLoadError(insuranceErrorText(t, err)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, includeInactive, visible, t]);

  // ── criar só com o nome ──
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function openCreate(): void {
    setName(''); setAliases(''); setCode(''); setNeedsCode(false); setCreateError(null);
    setCreating(true);
  }

  async function create(): Promise<void> {
    if (name.trim() === '') return;
    const list = parseAliases(aliases);
    try {
      setSaving(true);
      setCreateError(null);
      const created = await AdminInsuranceApiService.createProvider({
        name: name.trim(),
        ...(needsCode && code.trim() !== '' ? { code: code.trim() } : {}),
        ...(list.length > 0 ? { aliases: list } : {}),
      });
      navigate(`/admin/obras-sociales/${encodeURIComponent(created.code)}`);
    } catch (err: unknown) {
      // Código derivado do nome: sem caractere codificável OU colidindo com outro (corte em 64) => o operador informa o código.
      const errCode = insuranceErrorCode(err);
      if (errCode === 'NAME_NOT_CODIFIABLE' || errCode === 'INSURANCE_PROVIDER_CODE_EXISTS') setNeedsCode(true);
      setCreateError(insuranceErrorText(t, err));
    } finally {
      setSaving(false);
    }
  }

  const payerKindText = (k: InsuranceProviderListItem['payerKind']): string =>
    k ? t(`admin.patients.detail.contractedServicesCard.payerKindOptions.${k}`) : t(`${NS}.unclassified`);

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Building2 className="w-6 h-6 text-primary" />
          <Heading level={1} weight="semibold" color="primary">{t(`${NS}.title`)}</Heading>
        </div>
        <ActionButton resource="catalog_insurance_providers" action="create" variant="primary" size="md" onClick={openCreate} data-testid="providers-new">
          <Plus className="w-4 h-4" />
          {t(`${NS}.newProvider`)}
        </ActionButton>
      </div>
      <Text size="sm" color="inherit" className="mb-6 text-slate-600">{t(`${NS}.subtitle`)}</Text>

      {creating && (
        <FormModal
          title={t(`${NS}.create.title`)}
          isDirty={name !== '' || aliases !== '' || code !== ''}
          onClose={() => setCreating(false)}
          busy={saving}
          testId="provider-create-form"
          saveLabel={t(`${NS}.create.submit`)}
          onSave={create}
          saving={saving}
          saveDisabled={name.trim() === ''}
          saveTestId="provider-create-submit"
          notice={createError && <Text size="sm" className="text-red-600" role="alert" data-testid="provider-create-error">{createError}</Text>}
        >
              <Field label={t(`${NS}.create.nameLabel`)} required hint={t(`${NS}.create.nameHelp`)} htmlFor="provider-create-name">
                <Input inputSize="compact" id="provider-create-name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} data-testid="provider-create-name" />
              </Field>
              <Field label={t(`${NS}.create.aliasesLabel`)} optional hint={t(`${NS}.create.aliasesHelp`)} htmlFor="provider-create-aliases">
                <Input inputSize="compact" id="provider-create-aliases" value={aliases} onChange={(e) => setAliases(e.target.value)} data-testid="provider-create-aliases" />
              </Field>
              {needsCode && (
                <Field label={t(`${NS}.create.codeLabel`)} required hint={t(`${NS}.create.codeNeeded`)} htmlFor="provider-create-code">
                  <Input inputSize="compact" id="provider-create-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} data-testid="provider-create-code" />
                </Field>
              )}
        </FormModal>
      )}

      <div className="flex items-end gap-6 flex-wrap mb-4">
        <Field label={t(`${NS}.searchLabel`)} htmlFor="providers-search" className="w-full max-w-sm">
          <Input inputSize="compact" id="providers-search" type="search" value={search} placeholder={t(`${NS}.searchPlaceholder`)} onChange={(e) => setSearch(e.target.value)} data-testid="providers-search" />
        </Field>
        <div className="pb-2">
          <Checkbox id="providers-include-inactive" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} label={t(`${NS}.showInactive`)} data-testid="providers-include-inactive" />
        </div>
      </div>

      {loadError ? (
        <div className="py-12 text-center" role="alert" data-testid="providers-load-error"><Text color="inherit" className="text-red-600">{loadError}</Text></div>
      ) : loading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-300 p-12 text-center" data-testid="providers-empty">
          <Text size="sm" color="inherit" className="text-slate-600">{search.trim() !== '' ? t(`${NS}.emptySearch`) : t(`${NS}.empty`)}</Text>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-300 overflow-x-auto" data-testid="providers-table">
          <Table>
            <TableHeader>
              <TableHead>{t(`${NS}.columns.name`)}</TableHead>
              <TableHead>{t(`${NS}.columns.payerKind`)}</TableHead>
              <TableHead>{t(`${NS}.columns.status`)}</TableHead>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.code} onClick={() => navigate(`/admin/obras-sociales/${encodeURIComponent(p.code)}`)} data-testid={`provider-row-${p.code}`}>
                  <TableCell unwrapped>
                    {/* O link é o alvo de teclado/leitor de tela; o clique na linha inteira é conveniência do mouse. */}
                    <Link to={`/admin/obras-sociales/${encodeURIComponent(p.code)}`} className="text-sm font-medium text-primary hover:underline" data-testid={`provider-name-${p.code}`}>{p.name}</Link>
                  </TableCell>
                  <TableCell unwrapped><Text as="span" size="sm" color={p.payerKind ? 'primary' : 'inherit'} className={p.payerKind ? '' : 'text-slate-600'} data-testid={`provider-kind-${p.code}`}>{payerKindText(p.payerKind)}</Text></TableCell>
                  <TableCell unwrapped>
                    <span
                      className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${p.active ? 'bg-green-50 text-green-900' : 'bg-slate-100 text-slate-700'}`}
                      data-testid={`provider-status-${p.code}`}
                    >
                      {p.active ? t(`${NS}.active`) : t(`${NS}.inactive`)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
