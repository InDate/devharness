import { StatusPill } from './StatusPill.jsx';

export function OrderRow({ order, saving, onSave }) {
  return (
    <tr data-testid={`order-${order.id}`}>
      <td>{order.id}</td>
      <td>{order.customer}</td>
      <td>{order.total.toFixed(2)}</td>
      <td><StatusPill saving={saving} /></td>
      <td><button onClick={() => onSave(order)}>Save</button></td>
    </tr>
  );
}
