import { STATUS_LABEL } from '../lib/rag';

// Small RAG status chip: a colored dot + label, both driven by theme tokens
// (rag-dot--{status}). `status` is one of green | yellow | red | none.
export default function RagChip({ status }) {
  const s = status || 'none';
  return (
    <span className={`rag-chip rag-chip--${s}`}>
      <span className={`rag-dot rag-dot--${s}`} aria-hidden="true" />
      {STATUS_LABEL[s] || 'No data'}
    </span>
  );
}
