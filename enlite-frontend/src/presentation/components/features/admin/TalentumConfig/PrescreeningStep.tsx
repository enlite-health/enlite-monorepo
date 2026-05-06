import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface PrescreeningQuestion {
  question: string;
  responseType: string[];
  desiredResponse: string;
  weight: number;
  required: boolean;
  analyzed: boolean;
  earlyStoppage: boolean;
}

export interface FaqItem {
  question: string;
  answer: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PrescreeningStepProps {
  initialQuestions: PrescreeningQuestion[];
  initialFaq: FaqItem[];
  onNext: (data: { questions: PrescreeningQuestion[]; faq: FaqItem[] }) => void;
  onBack: () => void;
  isProcessing: boolean;
}

// ---------------------------------------------------------------------------
// Default factory
// ---------------------------------------------------------------------------

const defaultQuestion = (): PrescreeningQuestion => ({
  question: '',
  responseType: ['text', 'audio'],
  desiredResponse: '',
  weight: 5,
  required: false,
  analyzed: true,
  earlyStoppage: false,
});

// ---------------------------------------------------------------------------
// CSS helper
// ---------------------------------------------------------------------------

const fieldCls = (hasError: boolean) =>
  `border rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 ${hasError ? 'border-red-400' : 'border-[#D9D9D9]'}`;

// ---------------------------------------------------------------------------
// QuestionCard
// ---------------------------------------------------------------------------

interface QuestionCardProps {
  question: PrescreeningQuestion;
  index: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (updated: PrescreeningQuestion) => void;
  onDelete: () => void;
  errors: Record<string, string>;
}

function QuestionCard({
  question, index, expanded, onToggleExpanded, onChange, onDelete, errors,
}: QuestionCardProps) {
  const { t } = useTranslation();
  const ps = 'admin.vacancyDetail.prescreening';

  const toggleResponseType = (type: string) => {
    const cur = question.responseType;
    if (cur.includes(type)) {
      if (cur.length === 1) return;
      onChange({ ...question, responseType: cur.filter((r) => r !== type) });
    } else {
      onChange({ ...question, responseType: [...cur, type] });
    }
  };

  const advancedFlags = [
    { key: 'required' as const, label: t(`${ps}.required`) },
    { key: 'analyzed' as const, label: t(`${ps}.analyzed`) },
    { key: 'earlyStoppage' as const, label: t(`${ps}.earlyStoppage`) },
  ];

  return (
    <div className="border border-slate-200 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700">
          {t(`${ps}.questionLabel`, { n: index + 1 })}
        </span>
        <button type="button" onClick={onDelete}
          className="text-slate-400 hover:text-red-500 transition-colors">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          {t(`${ps}.responseType`)}
        </label>
        <div className="flex items-center gap-4">
          {(['text', 'audio'] as const).map((type) => (
            <label key={type} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
              <input type="checkbox" checked={question.responseType.includes(type)}
                onChange={() => toggleResponseType(type)}
                className="rounded border-slate-300" />
              {type === 'text' ? t(`${ps}.text`) : t(`${ps}.audio`)}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          {t(`${ps}.questionLabel`, { n: '' }).trim()}
        </label>
        <textarea rows={2} value={question.question}
          onChange={(e) => onChange({ ...question, question: e.target.value })}
          placeholder={t(`${ps}.questionPlaceholder`)}
          className={`${fieldCls(!!errors.question)} resize-none`} />
        {errors.question && <span className="text-xs text-red-500">{errors.question}</span>}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          {t(`${ps}.desiredResponse`)}
        </label>
        <textarea rows={2} value={question.desiredResponse}
          onChange={(e) => onChange({ ...question, desiredResponse: e.target.value })}
          placeholder={t(`${ps}.desiredResponsePlaceholder`)}
          className={`${fieldCls(!!errors.desiredResponse)} resize-none`} />
        {errors.desiredResponse && <span className="text-xs text-red-500">{errors.desiredResponse}</span>}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          {t(`${ps}.weight`)}
        </label>
        <input type="number" min={1} max={10} value={question.weight}
          onChange={(e) => onChange({ ...question, weight: Number(e.target.value) })}
          className={`w-24 ${fieldCls(!!errors.weight)}`} />
        {errors.weight && <span className="text-xs text-red-500">{errors.weight}</span>}
      </div>

      <button type="button" onClick={onToggleExpanded}
        className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors w-fit">
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {t(`${ps}.advancedConfig`)}
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 pl-2 border-l-2 border-slate-100">
          {advancedFlags.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer text-sm text-slate-700">
              <input type="checkbox" checked={question[key] as boolean}
                onChange={(e) => onChange({ ...question, [key]: e.target.checked })}
                className="rounded border-slate-300" />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FaqCard
// ---------------------------------------------------------------------------

function FaqCard({
  item, index, onDelete, onChange,
}: { item: FaqItem; index: number; onDelete: () => void; onChange: (f: keyof FaqItem, v: string) => void }) {
  const { t } = useTranslation();
  const ps = 'admin.vacancyDetail.prescreening';
  const baseCls = 'border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30';
  return (
    <div className="border border-slate-200 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700">FAQ {index + 1}</span>
        <button type="button" onClick={onDelete}
          className="text-slate-400 hover:text-red-500 transition-colors">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          {t(`${ps}.faqQuestion`)}
        </label>
        <input type="text" value={item.question}
          onChange={(e) => onChange('question', e.target.value)}
          placeholder={t(`${ps}.faqQuestionPlaceholder`)} className={baseCls} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 uppercase tracking-wide">
          {t(`${ps}.faqAnswer`)}
        </label>
        <textarea rows={2} value={item.answer}
          onChange={(e) => onChange('answer', e.target.value)}
          placeholder={t(`${ps}.faqAnswerPlaceholder`)} className={`${baseCls} resize-none`} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PrescreeningStep({
  initialQuestions, initialFaq, onNext, onBack, isProcessing,
}: PrescreeningStepProps) {
  const { t } = useTranslation();
  const ps = 'admin.vacancyDetail.prescreening';
  const cc = 'admin.createVacancy';

  const [questions, setQuestions] = useState<PrescreeningQuestion[]>(initialQuestions);
  const [faq, setFaq] = useState<FaqItem[]>(initialFaq);
  const [validationErrors, setValidationErrors] = useState<Array<Record<string, string>>>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [expandedAdvanced, setExpandedAdvanced] = useState<Set<number>>(new Set());

  const toggleAdvanced = (i: number) => setExpandedAdvanced((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const addQuestion = () => {
    setQuestions((p) => [...p, defaultQuestion()]);
    setValidationErrors((p) => [...p, {}]);
    setGlobalError(null);
  };

  const removeQuestion = (idx: number) => {
    setQuestions((p) => p.filter((_, i) => i !== idx));
    setValidationErrors((p) => p.filter((_, i) => i !== idx));
    setExpandedAdvanced((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => { if (i < idx) next.add(i); else if (i > idx) next.add(i - 1); });
      return next;
    });
  };

  const updateQuestion = (idx: number, updated: PrescreeningQuestion) => {
    setQuestions((p) => p.map((q, i) => (i === idx ? updated : q)));
    if (validationErrors[idx] && Object.keys(validationErrors[idx]).length > 0) {
      setValidationErrors((p) => p.map((e, i) => (i === idx ? {} : e)));
    }
    setGlobalError(null);
  };

  const updateFaq = (idx: number, field: keyof FaqItem, value: string) => {
    setFaq((p) => p.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const validate = (): boolean => {
    if (questions.length === 0) {
      setGlobalError(t(`${cc}.prescreeningMinQuestion`));
      return false;
    }
    const errors = questions.map((q) => {
      const err: Record<string, string> = {};
      if (!q.question.trim()) err.question = t(`${ps}.validation.questionRequired`);
      if (!q.desiredResponse.trim()) err.desiredResponse = t(`${ps}.validation.desiredResponseRequired`);
      if (q.weight < 1 || q.weight > 10) err.weight = t(`${ps}.validation.weightRange`);
      return err;
    });
    setValidationErrors(errors);
    return errors.every((e) => Object.keys(e).length === 0);
  };

  const handleNext = () => {
    if (!validate()) return;
    onNext({ questions, faq });
  };

  return (
    <div className="bg-white rounded-card shadow-small border border-slate-100 overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-100 px-6 py-5">
        <Typography variant="h3" weight="semibold" className="text-[#737373]">
          {t(`${ps}.title`)}
        </Typography>
      </div>

      <div className="p-6 flex flex-col gap-5">

      {/* Questions */}
      <div className="flex flex-col gap-3">
        {questions.length === 0 && (
          <p className="text-sm text-slate-400">{t(`${ps}.noQuestions`)}</p>
        )}
        {questions.map((q, i) => (
          <QuestionCard key={i} question={q} index={i} expanded={expandedAdvanced.has(i)}
            onToggleExpanded={() => toggleAdvanced(i)}
            onChange={(u) => updateQuestion(i, u)}
            onDelete={() => removeQuestion(i)}
            errors={validationErrors[i] ?? {}} />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addQuestion}
          className="flex items-center gap-2 w-fit">
          <Plus className="w-4 h-4" />{t(`${ps}.addQuestion`)}
        </Button>
      </div>

      <hr className="border-slate-100" />

      {/* FAQ */}
      <div className="flex flex-col gap-3">
        <Typography variant="h3" weight="semibold" className="text-[#737373] text-base">
          {t(`${ps}.faqTitle`)}
        </Typography>
        {faq.map((item, i) => (
          <FaqCard key={i} item={item} index={i}
            onDelete={() => setFaq((p) => p.filter((_, j) => j !== i))}
            onChange={(f, v) => updateFaq(i, f, v)} />
        ))}
        <Button type="button" variant="outline" size="sm"
          onClick={() => setFaq((p) => [...p, { question: '', answer: '' }])}
          className="flex items-center gap-2 w-fit">
          <Plus className="w-4 h-4" />{t(`${ps}.addFaq`)}
        </Button>
      </div>

      {/* Global error */}
      {globalError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <span className="text-sm text-red-600">{globalError}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
        <Button type="button" variant="outline" size="sm" onClick={onBack} disabled={isProcessing}
          className="rounded-pill border-2 border-slate-200 hover:border-slate-300">
          {t(`${cc}.back`)}
        </Button>
        <Button type="button" variant="primary" size="sm"
          onClick={handleNext} disabled={isProcessing}
          className="rounded-pill shadow-small flex items-center gap-2">
          {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
          {isProcessing ? t(`${cc}.processing`) : t(`${cc}.next`)}
        </Button>
      </div>
      </div>
    </div>
  );
}
