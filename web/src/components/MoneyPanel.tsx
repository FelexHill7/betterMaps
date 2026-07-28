import { useMemo, useState } from 'react';
import { useStore } from '../store.ts';
import { formatClock, formatMoney } from '../lib/geo.ts';

export function MoneyPanel() {
  const { trip, members, expenses, stops, user, typicalCents } = useStore();
  const addExpense = useStore((s) => s.addExpense);
  const removeExpense = useStore((s) => s.removeExpense);

  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');

  const spent = expenses.reduce((sum, e) => sum + e.amount_cents, 0);
  const budget = trip?.budget_cents ?? 0;

  /** What the remaining queue is likely to cost the whole car. */
  const planned = useMemo(
    () =>
      stops
        .filter((s) => s.status === 'queued')
        .reduce(
          (sum, s) => sum + (s.est_cost_cents ?? typicalCents[s.category] ?? 0) * members.length,
          0,
        ),
    [stops, typicalCents, members.length],
  );

  /** Even split: everyone owes total/heads; balance is what they've already paid. */
  const balances = useMemo(() => {
    const heads = Math.max(1, members.length);
    const share = spent / heads;
    return members
      .map((m) => {
        const paid = expenses
          .filter((e) => e.payer_id === m.id)
          .reduce((sum, e) => sum + e.amount_cents, 0);
        return { member: m, paid, balance: paid - share };
      })
      .sort((a, b) => b.balance - a.balance);
  }, [members, expenses, spent]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0 || !label.trim()) return;
    await addExpense({ amountCents: cents, label: label.trim() });
    setAmount('');
    setLabel('');
  };

  const overBudget = budget > 0 && spent > budget;

  return (
    <div className="list-section">
      <div>
        <div className="section-label">Spent so far</div>
        <div className="money-total" style={{ marginTop: 5 }}>
          <b>{formatMoney(spent)}</b>
          {budget > 0 && <span className="muted">of {formatMoney(budget)} budget</span>}
        </div>
        {budget > 0 && (
          <div className={`meter ${overBudget ? 'meter-over' : ''}`} style={{ marginTop: 9 }}>
            <i style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
          </div>
        )}
        <div className="faint" style={{ fontSize: 12, marginTop: 7 }}>
          {planned > 0 && <>About {formatMoney(planned)} more if you hit everything still queued. </>}
          {overBudget && <span style={{ color: 'var(--bad)' }}>Over budget.</span>}
        </div>
      </div>

      <form onSubmit={submit}>
        <div className="section-label">Log a payment</div>
        <div className="row" style={{ marginTop: 7 }}>
          <input
            className="input"
            style={{ width: 96 }}
            type="number"
            min="0"
            step="0.01"
            value={amount}
            placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            className="input grow"
            value={label}
            placeholder="Gas, snacks, tickets…"
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="btn btn-primary" disabled={!amount.trim() || !label.trim()}>
            Add
          </button>
        </div>
      </form>

      <div>
        <div className="section-label">Even split ({members.length} people)</div>
        {!expenses.length && (
          <div className="faint" style={{ fontSize: 13, marginTop: 7 }}>
            Nothing logged yet. Once someone pays for gas, this works out who owes whom.
          </div>
        )}
        {!!expenses.length &&
          balances.map(({ member, paid, balance }) => (
            <div key={member.id} className="split-row">
              <div className="avatar avatar-sm" style={{ borderColor: member.color }}>
                {member.emoji}
              </div>
              <span className="grow">
                {member.name}
                {member.id === user?.id && <span className="faint"> (you)</span>}
                <span className="faint" style={{ fontSize: 12, display: 'block' }}>
                  paid {formatMoney(paid)}
                </span>
              </span>
              <span className={balance >= 0 ? 'owe-pos' : 'owe-neg'}>
                {balance >= 0 ? 'gets back ' : 'owes '}
                {formatMoney(Math.abs(Math.round(balance)))}
              </span>
            </div>
          ))}
      </div>

      {!!expenses.length && (
        <div>
          <div className="section-label">History</div>
          {expenses.map((e) => {
            const payer = members.find((m) => m.id === e.payer_id);
            return (
              <div key={e.id} className="expense-row">
                <span className="grow">
                  {e.label}
                  <span className="faint" style={{ fontSize: 12, display: 'block' }}>
                    {payer?.name ?? 'someone'} · {formatClock(e.created_at)}
                  </span>
                </span>
                <span className="tnum" style={{ fontWeight: 650 }}>
                  {formatMoney(e.amount_cents)}
                </span>
                {e.payer_id === user?.id && (
                  <button
                    className="btn btn-icon btn-ghost btn-danger"
                    title="Delete"
                    onClick={() => removeExpense(e.id)}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
