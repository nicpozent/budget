/**
 * Idle-session warning (WCAG 2.2.1, ZT-004).
 *
 * The session dies after `SESSION_IDLE_MINUTES` of inactivity. Without a
 * warning that is a security control that silently eats work: someone comes
 * back from a meeting, types into a grid, and the save fails.
 *
 * WCAG 2.2.1 asks for two things — warn before the limit, and let the user
 * extend it with a simple action. This does both. It deliberately does *not*
 * keep the session alive on its own: an invisible keep-alive would make the
 * idle timeout decorative, which is the opposite of what ZT-004 wants. The
 * extension is an explicit choice, taken by someone who is actually there.
 *
 * The absolute TTL cannot be extended, and when that is what is about to expire
 * the dialog says so rather than offering a button that will not help.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { t } from '../i18n/index.ts';

export interface SessionDeadlines {
  idleDeadline: string;
  absoluteDeadline: string;
  warnSecondsBefore: number;
}

/** How often the countdown re-evaluates. A second is enough for a minutes-scale limit. */
const TICK_MS = 1000;

export function SessionGuard({ session }: { session: SessionDeadlines }): JSX.Element | null {
  const [deadlines, setDeadlines] = useState(session);
  const [now, setNow] = useState(() => Date.now());
  const [extending, setExtending] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const idleAt = new Date(deadlines.idleDeadline).getTime();
  const absoluteAt = new Date(deadlines.absoluteDeadline).getTime();
  // Whichever comes first is the one to warn about; only one of them can be
  // extended, and the copy has to reflect which.
  const expiresAt = Math.min(idleAt, absoluteAt);
  const extendable = idleAt <= absoluteAt;
  const secondsLeft = Math.max(0, Math.round((expiresAt - now) / 1000));

  const extend = useCallback(async () => {
    setExtending(true);
    try {
      const refreshed = await api.post<{ idleDeadline: string; absoluteDeadline: string }>(
        '/api/session/extend',
      );
      setDeadlines((d) => ({ ...d, ...refreshed }));
    } catch {
      // The session is already gone. Reloading lands on the sign-in screen,
      // which is the honest outcome rather than a dialog that does nothing.
      window.location.reload();
    } finally {
      setExtending(false);
    }
  }, []);

  useEffect(() => {
    if (secondsLeft === 0) window.location.reload();
  }, [secondsLeft]);

  if (secondsLeft > deadlines.warnSecondsBefore) return null;

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const remaining = minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;

  return (
    <div
      className="session-warning"
      // `alertdialog` rather than `alert`: this asks for a decision, and the
      // focused button below is that decision.
      role="alertdialog"
      aria-labelledby="session-warning-title"
      aria-describedby="session-warning-body"
    >
      <div className="session-warning-card">
        <h2 id="session-warning-title">{t('session.title')}</h2>
        <p id="session-warning-body">
          {extendable
            ? t('session.idleBody', { remaining })
            : t('session.absoluteBody', { remaining })}
        </p>
        <div className="button-row">
          {extendable ? (
            <button
              type="button"
              className="button button-primary"
              // Focused on appear so a keyboard user can act without hunting
              // for it — the criterion allows 20 seconds, and finding a button
              // should not eat them.
              autoFocus
              disabled={extending}
              onClick={() => void extend()}
            >
              {t('session.continue')}
            </button>
          ) : null}
          <button
            type="button"
            className="button"
            onClick={async () => {
              await api.post('/auth/logout').catch(() => undefined);
              window.location.assign('/');
            }}
          >
            {t('app.signOut')}
          </button>
        </div>
      </div>
    </div>
  );
}
