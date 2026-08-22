/**
 * FR-050..FR-053 the submission queue and its decisions.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { Submission } from '../types.ts';
import { formatDateTime } from '../format.ts';
import { BudgetStateChip } from './Status.tsx';
import { t } from '../i18n/index.ts';

export function SubmissionsView({ canDecide }: { canDecide: boolean }): JSX.Element {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [comment, setComment] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const reload = () =>
    api.get<Submission[]>('/api/submissions').then(setSubmissions).catch(() => setSubmissions([]));

  useEffect(() => {
    void reload();
  }, []);

  const decide = async (id: string, decision: 'approve' | 'reject' | 'request_info') => {
    try {
      await api.post(`/api/submissions/${id}/decision`, { decision, comment });
      setComment('');
      setMessage(null);
      await reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not record the decision.');
    }
  };

  return (
    <>
      {message ? <p className="banner banner-error" role="alert">{message}</p> : null}

      {submissions.length === 0 ? (
        <p className="empty">{t('views.noSubmissionsForThisCycleYet')}</p>
      ) : null}

      {canDecide && submissions.length > 0 ? (
        <div className="field">
          <label htmlFor="decision-comment">{t('views.decisionCommentLabel')}</label>
          <textarea
            id="decision-comment"
            className="input"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
      ) : null}

      {submissions.map((s) => (
        <section className="panel" key={s.id}>
          <div className="panel-header">
            <h2>{s.entityCode} — {s.entityName}</h2>
            <BudgetStateChip state={s.state} />
            <span className="currency-code">
              submitted by {s.submittedBy}, {formatDateTime(s.submittedAt)}
            </span>
          </div>
          <div className="panel-body">
            <p className="currency-code">
              {s.linesApproved} lines approved · {s.linesRejected} rejected
            </p>
            {s.comment ? <p>{s.comment}</p> : null}
            {canDecide && (s.state === 'submitted' || s.state === 'changes_requested') ? (
              <div className="button-row">
                <button type="button" className="button button-primary" onClick={() => decide(s.id, 'approve')}>
                  {t('views.approve')}
                </button>
                <button type="button" className="button" onClick={() => decide(s.id, 'request_info')}>
                  {t('views.requestMoreInformation')}
                </button>
                <button type="button" className="button button-danger" onClick={() => decide(s.id, 'reject')}>
                  {t('views.reject')}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </>
  );
}
