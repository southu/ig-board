// Board agenda pyramid layers — ordered bottom-up for the meeting (layer 1
// first, layer 5 last). Display names match the Phase 3 mission wording
// (Leadership Alignment → Enterprise Value). Positions align 1:1 with the
// scorecard catalog layer numbers so red/yellow KPIs map directly.

export const AGENDA_LAYERS = [
  {
    position: 1,
    name: 'Leadership Alignment',
    // Scorecard: Financial Health — cash, margin, and runway set the table.
    scorecardName: 'Financial Health'
  },
  {
    position: 2,
    name: 'Operational Discipline',
    scorecardName: 'Order Operations'
  },
  {
    position: 3,
    name: 'Revenue Growth',
    scorecardName: 'Sales & Growth'
  },
  {
    position: 4,
    name: 'Customer Outcomes',
    scorecardName: 'Customer & Quality'
  },
  {
    position: 5,
    name: 'Enterprise Value',
    scorecardName: 'People & Organization'
  }
];

export function agendaLayerByPosition(position) {
  return AGENDA_LAYERS.find((l) => l.position === Number(position)) || null;
}

export function agendaLayerName(position) {
  const layer = agendaLayerByPosition(position);
  return layer ? layer.name : `Layer ${position}`;
}

// Catalog layer position → agenda layer position (identity).
export function catalogLayerToAgenda(catalogLayer) {
  const n = Number(catalogLayer);
  if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
  return 1;
}
