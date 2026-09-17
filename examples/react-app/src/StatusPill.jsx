export function StatusPill({ saving }) {
  // The state worth pointing at: only on screen for 600ms.
  return <span className={saving ? 'pill saving' : 'pill idle'}>{saving ? 'saving…' : 'idle'}</span>;
}
