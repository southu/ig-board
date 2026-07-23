// Complete, verbatim board-spec metadata shared by layer cards and KPI detail
// pages. Null spec values render as an explicit em dash; optional callouts and
// verification rows are omitted entirely when the seed does not define them.
export default function KpiBoardSpec({ kpi, definition }) {
  const thresholdText = kpi.thresholdText || {};

  return (
    <section
      className="kpi-board-spec"
      aria-label={`${kpi.name} board specification`}
      data-testid="kpi-board-spec"
    >
      <dl className="kpi-board-spec__meta">
        <SpecRow label="Definition" testId="kpi-definition">
          {definition || kpi.definition}
        </SpecRow>
        <SpecRow label="Owner" testId="kpi-owner">{kpi.owner}</SpecRow>
        <SpecRow label="Cadence" testId="kpi-cadence">{kpi.cadence}</SpecRow>
        <SpecRow label="Baseline" testId="kpi-baseline">{kpi.baseline}</SpecRow>
        <SpecRow label="Baseline source" testId="kpi-baseline-source">
          {kpi.baselineSource}
        </SpecRow>
      </dl>

      <div className="kpi-thresholds" data-testid="kpi-thresholds">
        <p className="kpi-thresholds__label">Thresholds</p>
        <dl className="kpi-thresholds__grid">
          <ThresholdRow status="green" value={thresholdText.green} />
          <ThresholdRow status="yellow" value={thresholdText.yellow} />
          <ThresholdRow status="red" value={thresholdText.red} />
        </dl>
      </div>

      {kpi.definitionNote ? (
        <aside
          className="kpi-definition-note"
          data-testid="kpi-definition-note"
          aria-label="Definition note"
        >
          <p className="kpi-definition-note__label">Definition note</p>
          <p>{kpi.definitionNote}</p>
        </aside>
      ) : null}

      {kpi.verification ? (
        <div className="kpi-verification" data-testid="kpi-verification">
          <p className="kpi-verification__label">Board verification</p>
          <p>{kpi.verification}</p>
        </div>
      ) : null}
    </section>
  );
}

function SpecRow({ label, testId, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-testid={testId}>{children == null || children === '' ? '—' : children}</dd>
    </div>
  );
}

function ThresholdRow({ status, value }) {
  const label = status[0].toUpperCase() + status.slice(1);
  return (
    <div className={`kpi-thresholds__item kpi-thresholds__item--${status}`}>
      <dt>{label}</dt>
      <dd data-testid={`kpi-threshold-${status}`}>
        {value == null || value === '' ? '—' : value}
      </dd>
    </div>
  );
}
