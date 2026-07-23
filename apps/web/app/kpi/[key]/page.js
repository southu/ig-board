import { KPIS } from '../../../lib/catalog';
import KpiTrendPage from './KpiTrendPage';

// Static export needs every KPI key up front for /kpi/<key> trend pages.
export function generateStaticParams() {
  return KPIS.map((k) => ({ key: k.key }));
}

export default function Page({ params }) {
  return <KpiTrendPage kpiKey={params.key} />;
}
