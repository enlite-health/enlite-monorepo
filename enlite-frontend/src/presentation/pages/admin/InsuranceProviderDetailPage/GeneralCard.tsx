/**
 * GeneralCard — cartão "Dados gerais" da obra social (spec 058 §4.2): nome, razão social, CUIT/CNPJ, endereço, grupo de gestão,
 * tipo do pagador e `active`. `code` é só leitura (imutável). Edição em UMA modal própria do cartão (descarte pedido ao fechar alterado).
 *
 * PATCH: ausente = não toca; `null` limpa (só os anuláveis); `''` é 422 — por isso o corpo leva SÓ o que mudou e um campo opcional
 * apagado vai como `null`. O tipo do pagador, depois de informado, não tem opção "sem classificar" (o back recusa: `PAYER_KIND_CANNOT_UNSET`).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';
import { Field } from './Field';
import { FormModal } from './FormModal';
import { ActionButton } from '@presentation/components/features/access';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import { PAYER_KINDS, type PayerKind } from '@domain/entities/InsuranceContract';
import type { InsuranceProviderDetail } from '@domain/entities/InsuranceProviderDetail';
import { insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { ProviderCard } from './ProviderCard';
import { buildGeneralPatch, OPTIONAL_FIELDS, toDraft, type Draft } from './generalDraft';

interface Props {
  provider: InsuranceProviderDetail;
  onSaved: (provider: InsuranceProviderDetail) => void;
  /** Muda a cada pedido externo de edição (o link "Ir para Dados gerais" do cartão Contratos). */
  editRequest: number;
}

const NS = 'admin.insuranceProviders';
export function GeneralCard({ provider, onSaved, editRequest }: Props): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(provider));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(): void {
    setDraft(toDraft(provider));
    setError(null);
    setEditing(true);
  }
  useEffect(() => {
    if (editRequest > 0) startEdit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setDraft((d) => ({ ...d, [k]: v }));

  async function save(): Promise<void> {
    const body = buildGeneralPatch(provider, draft);
    if (draft.name.trim() === '') return;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      onSaved(await AdminInsuranceApiService.patchProvider(provider.code, body));
      setEditing(false);
    } catch (err: unknown) {
      setError(insuranceErrorText(t, err));
    } finally {
      setSaving(false);
    }
  }

  const payerKindLabel = (k: PayerKind | null): string =>
    k ? t(`admin.patients.detail.contractedServicesCard.payerKindOptions.${k}`) : t(`${NS}.general.payerKindNone`);
  const notInformed = t(`${NS}.detail.notInformed`);

  const actions = (
    <ActionButton resource="catalog_insurance_providers" action="update" variant="primary" size="sm" onClick={startEdit} data-testid="provider-general-edit">
      {t(`${NS}.detail.edit`)}
    </ActionButton>
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(provider));

  return (
    <>
    <ProviderCard id="provider-general-card" title={t(`${NS}.general.title`)} actions={actions}>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4" data-testid="provider-general-view">
          {[
            ['name', provider.name],
            ['code', provider.code],
            ['legalName', provider.legalName],
            ['taxId', provider.taxId],
            ['address', provider.address],
            ['managementChatId', provider.managementChatId],
            ['payerKind', payerKindLabel(provider.payerKind)],
            ['active', provider.active ? t(`${NS}.general.activeYes`) : t(`${NS}.general.activeNo`)],
          ].map(([key, value]) => (
            <div key={key} className="flex flex-col gap-0.5 border-b border-slate-300 pb-2">
              <dt><Text as="span" size="xs" color="inherit" className="text-slate-600">{t(`${NS}.general.fields.${key}`)}</Text></dt>
              <dd data-testid={`provider-general-${key}`}>
                <Text as="span" size="sm" weight="medium" color={value ? 'primary' : 'inherit'} className={value ? '' : 'text-slate-600'}>{value || notInformed}</Text>
              </dd>
            </div>
          ))}
      </dl>
    </ProviderCard>
    {editing && (
      <FormModal title={t(`${NS}.general.title`)} isDirty={dirty} onClose={() => setEditing(false)} busy={saving} testId="provider-general-modal"
        saveLabel={t(`${NS}.detail.save`)}
        onSave={save}
        saving={saving}
        saveDisabled={draft.name.trim() === ''}
        saveTestId="provider-general-save"
        notice={error && <Text size="sm" className="text-red-600" role="alert" data-testid="provider-general-error">{error}</Text>}
      >
        <div data-testid="provider-general-form" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={t(`${NS}.general.fields.name`)} required htmlFor="provider-general-name-input">
              <Input inputSize="compact" id="provider-general-name-input" value={draft.name} onChange={(e) => set('name', e.target.value)} data-testid="provider-general-name-input" />
            </Field>
            {OPTIONAL_FIELDS.map((f) => (
              <Field key={f} label={t(`${NS}.general.fields.${f}`)} optional htmlFor={`provider-general-${f}-input`}>
                <Input inputSize="compact" id={`provider-general-${f}-input`} value={draft[f]} onChange={(e) => set(f, e.target.value)} data-testid={`provider-general-${f}-input`} />
              </Field>
            ))}
            <Field label={t(`${NS}.general.fields.payerKind`)} optional hint={t(`${NS}.general.payerKindHint`)} htmlFor="provider-general-payerKind-input">
              <Select
                inputSize="compact"
                id="provider-general-payerKind-input"
                value={draft.payerKind}
                placeholder={provider.payerKind === null ? t(`${NS}.general.payerKindNone`) : undefined}
                options={PAYER_KINDS.map((k) => ({ value: k, label: payerKindLabel(k) }))}
                onValueChange={(v) => set('payerKind', v as PayerKind | '')}
                data-testid="provider-general-payerKind-input"
              />
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox
                id="provider-general-active-input"
                checked={draft.active}
                onChange={(e) => set('active', e.target.checked)}
                label={t(`${NS}.general.activeLabel`)}
                data-testid="provider-general-active-input"
              />
            </div>
          </div>
        </div>
      </FormModal>
    )}
    </>
  );
}
