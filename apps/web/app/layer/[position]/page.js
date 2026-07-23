import LayerDetail from './LayerDetail';

// Static export needs the concrete set of dynamic params up front. The five
// scorecard layers are fixed (positions 1–5), so we prerender exactly those.
export function generateStaticParams() {
  return [1, 2, 3, 4, 5].map((position) => ({ position: String(position) }));
}

// Server wrapper: exports generateStaticParams (a server-only export) and hands
// the position to the client detail component, which owns the auth guard, data
// fetch, and Recharts sparklines.
export default function LayerPage({ params }) {
  return <LayerDetail position={Number(params.position)} />;
}
