export default function ExitReadinessConditions({ result }) {
  if (!result || !Array.isArray(result.conditions)) return null;

  return (
    <section
      className="exit-readiness-conditions"
      aria-label="Exit-readiness conditions"
      data-testid="exit-readiness-conditions"
    >
      <h3>Exit-readiness conditions</h3>
      <ul>
        {result.conditions.map((condition) => (
          <li
            key={condition.key}
            className={condition.met ? 'condition condition--met' : 'condition condition--unmet'}
            data-condition={condition.key}
            data-met={condition.met ? 'true' : 'false'}
          >
            <span className="condition__indicator" aria-hidden="true">
              {condition.met ? '✓' : '×'}
            </span>
            <span>
              <strong>{condition.name}</strong>
              <span className="condition__state">
                {condition.met ? 'Met' : 'Unmet'}
              </span>
              <small>{condition.detail}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
