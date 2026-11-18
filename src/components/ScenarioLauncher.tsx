import { SCENARIOS, type Scenario, type ScenarioId } from '../lib/scenarios';

interface LauncherProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onRun: (id: ScenarioId) => void;
}

function ToolChips({ scenario }: { scenario: Scenario }) {
  return (
    <span className="scenario-tools">
      {scenario.tools.map((tool) => (
        <span className="scenario-tool mono" key={tool}>
          {tool}
        </span>
      ))}
    </span>
  );
}

function PlanFlag({ scenario }: { scenario: Scenario }) {
  if (!scenario.plan) return null;
  return <span className="scenario-flag mono">plan 승인 포함</span>;
}

/** The launcher sheet — three cards, one click each. */
export function ScenarioLauncher({ open, busy, onClose, onRun }: LauncherProps) {
  if (!open) return null;
  return (
    <div className="scenario-overlay" role="presentation" onClick={onClose}>
      <section
        className="scenario-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="실전 에이전트 시나리오"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="scenario-head">
          <div className="scenario-head-copy">
            <span className="scenario-kicker mono">scenarios · damon-agent-core</span>
            <h2>실전 에이전트 시나리오</h2>
            <p>
              파일 읽기·diff·테스트 실행, 계획 승인, 툴 아코디언까지 실제 턴처럼 재생됩니다. 옆의 JSON-RPC 인스펙터를 열어 두면 같은
              순간의 프레임이 흐르는 걸 볼 수 있습니다.
            </p>
          </div>
          <button type="button" className="icon-btn scenario-close" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        <div className="scenario-grid">
          {SCENARIOS.map((scenario) => (
            <button
              type="button"
              className="scenario-card"
              key={scenario.id}
              onClick={() => onRun(scenario.id)}
              disabled={busy}
            >
              <span className="scenario-card-top mono">
                <span className="scenario-card-index">{scenario.index}</span>
                <span className="scenario-card-label">{scenario.label}</span>
                <PlanFlag scenario={scenario} />
              </span>
              <span className="scenario-card-title">{scenario.title}</span>
              <span className="scenario-card-summary">{scenario.summary}</span>
              <ToolChips scenario={scenario} />
              <span className="scenario-card-run mono">{busy ? '턴 진행 중…' : '실행 →'}</span>
            </button>
          ))}
        </div>

        <p className="scenario-foot mono">
          demo 모드는 스크립트를 그대로 재생하고, daemon·openai 연결에서는 같은 요청을 실제 에이전트에 보냅니다.
        </p>
      </section>
    </div>
  );
}

/** The same three, as a compact strip inside the empty screen. */
export function ScenarioStrip({ busy, onRun }: { busy: boolean; onRun: (id: ScenarioId) => void }) {
  return (
    <div className="scenario-strip">
      <div className="scenario-strip-head mono">
        <span>실전 시나리오</span>
        <span className="faint">1클릭 실행 · 툴·계획·프레임</span>
      </div>
      <div className="scenario-strip-grid">
        {SCENARIOS.map((scenario) => (
          <button type="button" className="scenario-mini" key={scenario.id} onClick={() => onRun(scenario.id)} disabled={busy}>
            <span className="scenario-mini-kicker mono">{`${scenario.index} / ${scenario.label}`}</span>
            <span className="scenario-mini-title">{scenario.title}</span>
            <span className="scenario-mini-tools mono">{scenario.tools.join(' · ')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
