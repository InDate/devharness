import { useState } from 'preact/hooks';
import { OrderRow } from './OrderRow.jsx';
import { Toast } from './Toast.jsx';

const ORDERS = [
  { id: 1, customer: 'Ada Lovelace', total: 42.5 },
  { id: 2, customer: 'Grace Hopper', total: 128.0 },
  { id: 3, customer: 'Alan Turing', total: 7.25 },
];

export function App() {
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(null);

  // Deliberately transient: the status shows for 600ms and the toast for 1200ms,
  // which is the window the bench exists to hold open.
  const save = (order) => {
    setSaving(order.id);
    setTimeout(() => {
      setSaving(null);
      setToast(`Saved order #${order.id}`);
      setTimeout(() => setToast(null), 1200);
    }, 600);
  };

  return (
    <main>
      <h1>Orders</h1>
      <p className="hint">Each row is its own component, so a pick should name it.</p>
      <table>
        <thead>
          <tr><th>#</th><th>Customer</th><th>Total</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {ORDERS.map((order) => (
            <OrderRow key={order.id} order={order} saving={saving === order.id} onSave={save} />
          ))}
        </tbody>
      </table>
      <Toast message={toast} />
    </main>
  );
}
