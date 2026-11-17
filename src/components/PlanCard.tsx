import { useState } from 'react';
import { planDecisionLabel } from '../lib/plan';
import type { PlanDecision, PlanRequest } from '../lib/types';

interface PlanCardProps {
  plan: PlanRequest;
  onDecide: (decision: PlanDecision, feedback?: string) => void;
}

/**
 * A plan the agent parked for review — `plan.respond` as a card.
 *
 * The reply is `kind: plan` with the plan text; the card is the durable
 * review surface (`planId` + revision CAS), so a decision sent from here
 * is the same decision a phone or a chat bot would send.
 */
export function PlanCard({ plan, onDecide }: PlanCardProps) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState('');
  const pending = plan.status === 'awaiting_review';
  const busy = plan.submitting === true;

  const decide = (decision: PlanDecision) => {
    onDecide(decision, decision === 'request_changes' ? feedback : undefined);
    if (decision === 'request_changes') setRevising(false);
  };

  return (
    <section className={`plan ${plan.status}`}>
      <header className="plan-head">
        <span className="plan-kind mono">plan</span>
        <span className="plan-title">{plan.title}</span>
        {plan.revision ? <span className="plan-rev mono">r{plan.revision}</span> : null}
        <span className={`plan-status mono ${plan.status}`}>{busy ? 'sending…' : planDecisionLabel(plan.status)}</span>
      </header>

      {plan.steps.length > 0 ? (
        <ol className="plan-steps">
          {plan.steps.map((step, index) => (
            <li className="plan-step" key={`${index}-${step.title}`}>
              <span className="plan-step-no mono">{String(index + 1).padStart(2, '0')}</span>
              <span className="plan-step-body">
                <span className="plan-step-title">{step.title}</span>
                {step.detail ? <span className="plan-step-detail">{step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="plan-content">{plan.content}</p>
      )}

      {plan.files.length > 0 ? (
        <div className="plan-files">
          <span className="plan-files-label mono">files</span>
          <div className="plan-file-chips">
            {plan.files.map((file) => (
              <span className="plan-file mono" key={file}>
                {file}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {plan.risks.length > 0 ? (
        <ul className="plan-risks">
          {plan.risks.map((risk) => (
            <li key={risk}>{risk}</li>
          ))}
        </ul>
      ) : null}

      <details className="plan-raw">
        <summary className="mono">raw plan</summary>
        <pre className="plan-raw-body mono">{plan.content}</pre>
      </details>

      {pending ? (
        <div className="plan-actions">
          <button type="button" className="ghost-btn accent" disabled={busy} onClick={() => decide('approve')}>
            approve
          </button>
          <button
            type="button"
            className={`ghost-btn ${revising ? 'on' : ''}`}
            disabled={busy}
            onClick={() => setRevising((current) => !current)}
          >
            request changes
          </button>
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => decide('defer')}>
            defer
          </button>
          <span className="plan-hint mono">plan.respond · {plan.planId ? plan.planId.slice(0, 14) : 'live ask'}</span>
        </div>
      ) : (
        <div className="plan-decision">
          <span className={`plan-status mono ${plan.status}`}>{planDecisionLabel(plan.status)}</span>
          {plan.decidedAt ? (
            <span className="faint mono">
              {new Date(plan.decidedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : null}
          {plan.feedback ? <span className="plan-feedback-text">“{plan.feedback}”</span> : null}
        </div>
      )}

      {revising && pending ? (
        <div className="plan-revise">
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            rows={2}
            placeholder="무엇을 바꿔야 하는지 적어 주세요 — 이 문장이 deny 메시지로 에이전트에 그대로 갑니다"
            spellCheck={false}
          />
          <button
            type="button"
            className="ghost-btn accent"
            disabled={busy || feedback.trim().length === 0}
            onClick={() => decide('request_changes')}
          >
            send request
          </button>
        </div>
      ) : null}

      {plan.error ? <p className="plan-error">{plan.error}</p> : null}
    </section>
  );
}
