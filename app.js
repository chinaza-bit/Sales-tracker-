const { useState, useEffect, useMemo, useRef } = React;

/* ---------- Setup ---------- */
const CONFIGURED = !!window.SUPABASE_URL && !window.SUPABASE_URL.includes('YOUR-PROJECT');
const db = CONFIGURED ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;

const SNAP_KEY = 'daily-ledger-snapshot';   // last copy of the database on this device
const QUEUE_KEY = 'daily-ledger-queue';     // changes waiting to be sent
const FAIL_KEY = 'daily-ledger-failures';   // changes the database refused

/* ---------- Helpers ---------- */
const fmt = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const money = n => (n < 0 ? '−' : '') + fmt.format(Math.abs(n));
const num = v => Number(v) || 0;
const pad = n => String(n).padStart(2, '0');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const longDate = s => new Date(s + 'T00:00:00').toLocaleDateString('en-NG', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
});

const uuid = () => {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const readLS = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch (e) { return fallback; }
};
const writeLS = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
};

function dayTotals(sales, expenses) {
  const items = sales.reduce((a, s) => a + num(s.quantity), 0);
  const cost = sales.reduce((a, s) => a + num(s.cost_price) * num(s.quantity), 0);
  const revenue = sales.reduce((a, s) => a + num(s.selling_price) * num(s.quantity), 0);
  const exp = expenses.reduce((a, e) => a + num(e.amount), 0);
  const gross = revenue - cost;
  return { items, cost, revenue, gross, exp, net: gross - exp };
}

/* ---------- Offline data layer ---------- */
const EMPTY_SNAP = { goods: [], sales: [], expenses: [] };

// Shows the database copy with every queued change applied on top, in order
function applyQueue(snap, queue) {
  let goods = snap.goods, sales = snap.sales, expenses = snap.expenses;
  for (const op of queue) {
    switch (op.type) {
      case 'good':
        goods = [...goods.filter(g => g.name !== op.row.name), { id: op.row.name, name: op.row.name, cost_price: op.row.cost_price }];
        break;
      case 'sale':
        if (!sales.some(s => s.id === op.row.id)) sales = [...sales, op.row];
        break;
      case 'expense':
        if (!expenses.some(e => e.id === op.row.id)) expenses = [...expenses, op.row];
        break;
      case 'deleteSale': sales = sales.filter(s => s.id !== op.id); break;
      case 'deleteExpense': expenses = expenses.filter(e => e.id !== op.id); break;
      case 'deleteGood': goods = goods.filter(g => g.name !== op.name); break;
      case 'deleteDay':
        sales = sales.filter(s => s.sale_date !== op.date);
        expenses = expenses.filter(e => e.expense_date !== op.date);
        break;
      default: break;
    }
  }
  return { goods: [...goods].sort((a, b) => a.name.localeCompare(b.name)), sales, expenses };
}

function isNetworkError(err) {
  const msg = String((err && err.message) || err || '');
  return err instanceof TypeError || /fetch|network|load failed|internet|offline/i.test(msg);
}

// Sends one queued change. Returns { ok }, { network: true } to retry later, or { error } if refused.
async function sendOp(op, userId) {
  if (!navigator.onLine) return { network: true };
  try {
    let res;
    switch (op.type) {
      case 'good':
        res = await db.from('goods').upsert({ user_id: userId, name: op.row.name, cost_price: op.row.cost_price }, { onConflict: 'user_id,name' });
        break;
      case 'sale': {
        const { id, sale_date, goods_name, quantity, cost_price, selling_price } = op.row;
        res = await db.from('sales').insert({ user_id: userId, id, sale_date, goods_name, quantity, cost_price, selling_price });
        break;
      }
      case 'expense': {
        const { id, expense_date, label, amount } = op.row;
        res = await db.from('expenses').insert({ user_id: userId, id, expense_date, label, amount });
        break;
      }
      case 'deleteSale': res = await db.from('sales').delete().eq('id', op.id); break;
      case 'deleteExpense': res = await db.from('expenses').delete().eq('id', op.id); break;
      case 'deleteGood': res = await db.from('goods').delete().eq('name', op.name); break;
      case 'deleteDay':
        res = await db.from('sales').delete().eq('sale_date', op.date);
        if (!res.error) res = await db.from('expenses').delete().eq('expense_date', op.date);
        break;
      default: return { error: 'Unknown change type' };
    }
    if (res.error) {
      if (res.error.code === '23505') return { ok: true };   // already saved on an earlier try
      if (isNetworkError(res.error)) return { network: true };
      return { error: res.error.message };
    }
    return { ok: true };
  } catch (err) {
    return isNetworkError(err) ? { network: true } : { error: String((err && err.message) || err) };
  }
}

const OP_LABEL = {
  good: 'Goods', sale: 'Sale', expense: 'Expense',
  deleteSale: 'Sale deletion', deleteExpense: 'Expense deletion',
  deleteGood: 'Goods deletion', deleteDay: 'Day deletion'
};

function useLedger(userId) {
  const snapKey = SNAP_KEY + ':' + userId;
  const queueKey = QUEUE_KEY + ':' + userId;
  const failKey = FAIL_KEY + ':' + userId;
  const [snap, setSnap] = useState(() => readLS(snapKey, EMPTY_SNAP));
  const [queue, setQueue] = useState(() => readLS(queueKey, []));
  const [failures, setFailures] = useState(() => readLS(failKey, []));
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const queueRef = useRef(queue);
  const busy = useRef(false);

  const commitQueue = q => { queueRef.current = q; setQueue(q); writeLS(queueKey, q); };
  const commitSnap = s => { setSnap(s); writeLS(snapKey, s); };

  const refresh = async () => {
    if (!CONFIGURED || !navigator.onLine || queueRef.current.length) return;
    const [g, s, e] = await Promise.all([
      db.from('goods').select('*').order('name'),
      db.from('sales').select('*').order('created_at'),
      db.from('expenses').select('*').order('created_at')
    ]);
    if (g.error || s.error || e.error) return;   // keep the copy we already have
    commitSnap({ goods: g.data, sales: s.data, expenses: e.data });
  };

  const sync = async () => {
    if (!CONFIGURED || busy.current || !navigator.onLine) return;
    busy.current = true;
    setSyncing(true);
    let retryLater = false;
    try {
      while (queueRef.current.length) {
        const op = queueRef.current[0];
        const res = await sendOp(op, userId);
        if (res.network) { retryLater = true; break; }
        if (res.error) {
          setFailures(f => {
            const next = [...f, { id: uuid(), label: OP_LABEL[op.type] || 'Change', message: res.error }];
            writeLS(failKey, next);
            return next;
          });
        }
        commitQueue(queueRef.current.slice(1));
      }
      if (!queueRef.current.length) await refresh();
    } catch (err) {
      retryLater = true;
    } finally {
      busy.current = false;
      setSyncing(false);
      if (retryLater) setTimeout(sync, 15000);
      else if (queueRef.current.length) setTimeout(sync, 0);
    }
  };

  useEffect(() => {
    const up = () => { setOnline(true); sync(); };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const timer = setInterval(sync, 60000);
    sync();
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      clearInterval(timer);
    };
  }, []);

  const enqueue = op => { commitQueue([...queueRef.current, op]); sync(); };

  const view = useMemo(() => applyQueue(snap, queue), [snap, queue]);

  const dismissFailures = () => { setFailures([]); writeLS(failKey, []); };

  return {
    ...view,
    online, syncing, pending: queue.length, failures, dismissFailures,
    saveGood(name, cost) {
      enqueue({ type: 'good', row: { name, cost_price: cost } });
      return { id: name, name, cost_price: cost };
    },
    recordSale(good, price, qty) {
      const row = {
        id: uuid(), sale_date: todayStr(), goods_name: good.name,
        quantity: qty, cost_price: num(good.cost_price), selling_price: price
      };
      enqueue({ type: 'sale', row });
      return row;
    },
    addExpense(label, amount) {
      const row = { id: uuid(), expense_date: todayStr(), label, amount };
      enqueue({ type: 'expense', row });
      return row;
    },
    deleteGood: g => enqueue({ type: 'deleteGood', name: g.name }),
    deleteSale: s => enqueue({ type: 'deleteSale', id: s.id }),
    deleteExpense: e => enqueue({ type: 'deleteExpense', id: e.id }),
    deleteDay: date => enqueue({ type: 'deleteDay', date })
  };
}

/* ---------- Theme ---------- */
function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('daily-ledger-theme', theme); } catch (e) {}
  }, [theme]);
  return [theme, setTheme];
}

function ThemeToggle({ theme, onToggle }) {
  const next = theme === 'dark' ? 'Light' : 'Dark';
  return (
    <button type="button" className="theme-toggle" onClick={onToggle} aria-label={`Switch to ${next.toLowerCase()} mode`}>
      <span className="dot" aria-hidden="true" />
      {next} mode
    </button>
  );
}

/* ---------- Small components ---------- */
function Card({ title, sub, actions, children }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {sub && <p className="sub">{sub}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ConfirmButton({ label, confirmLabel, onConfirm, className = 'btn secondary small', disabled }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        if (!armed) { setArmed(true); return; }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

function StatusPill({ online, syncing, pending }) {
  let text, cls;
  if (!online) {
    text = pending ? `Offline · ${pending} saved on this device` : 'Offline · saved on this device';
    cls = 'off';
  } else if (syncing || pending) {
    text = syncing ? 'Syncing…' : `${pending} waiting to sync`;
    cls = 'sync';
  } else {
    text = 'All saved';
    cls = 'ok';
  }
  return (
    <span className={'status ' + cls} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function Suggest({ value, onChange, onPick, goods, placeholder, inputRef }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const q = value.trim().toLowerCase();
  const items = q ? goods.filter(g => g.name.toLowerCase().includes(q)).slice(0, 8) : [];
  const show = open && items.length > 0;

  const choose = g => { onPick(g); setOpen(false); setActive(-1); };

  const onKey = e => {
    if (!show) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="field">
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKey}
      />
      {show && (
        <ul className="suggest" role="listbox">
          {items.map((g, i) => (
            <li key={g.name}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={'opt' + (i === active ? ' on' : '')}
                onMouseDown={e => { e.preventDefault(); choose(g); }}
              >
                <span>{g.name}</span>
                <small>{money(num(g.cost_price))}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Goods ---------- */
function GoodsPanel({ goods, onSave, onDelete }) {
  const [name, setName] = useState('');
  const [cost, setCost] = useState('');
  const [msg, setMsg] = useState({ text: '', err: false });
  const costRef = useRef(null);

  const pick = g => { setName(g.name); setCost(String(num(g.cost_price))); costRef.current?.focus(); };

  const submit = e => {
    e.preventDefault();
    const n = name.trim();
    const c = parseFloat(cost);
    if (!n) return setMsg({ text: 'Enter the goods name.', err: true });
    if (!(c >= 0)) return setMsg({ text: 'Enter the cost price as a number.', err: true });
    onSave(n, c);
    setName(''); setCost('');
    setMsg({ text: `${n} saved.`, err: false });
  };

  return (
    <Card title="Goods" sub="Items you sell. Saved goods appear as suggestions when you record a sale.">
      <form className="form" onSubmit={submit}>
        <div className="row equal">
          <div className="field">
            <span>Goods name</span>
            <Suggest value={name} onChange={setName} onPick={pick} goods={goods} placeholder="e.g. Indomie chicken" />
          </div>
          <div className="field">
            <span>Cost price (₦)</span>
            <input ref={costRef} value={cost} onChange={e => setCost(e.target.value)} type="number" min="0" step="any" inputMode="decimal" />
          </div>
        </div>
        <div><button className="btn" type="submit">Save goods</button></div>
        <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
      </form>

      <h3 className="section">Saved goods ({goods.length})</h3>
      <ul className="list">
        {goods.length ? goods.map(g => (
          <li key={g.name}>
            <span>{g.name}</span>
            <span className="r">
              <span className="num">{money(num(g.cost_price))}</span>
              <button className="del" aria-label={`Remove ${g.name}`} onClick={() => onDelete(g)}>×</button>
            </span>
          </li>
        )) : <li className="empty">No goods yet. Save your first item above.</li>}
      </ul>
    </Card>
  );
}

/* ---------- Sales and expenses ---------- */
function SalePanel({ goods, onSaveGood, onRecordSale }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(null);
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [newCost, setNewCost] = useState('');
  const [needCost, setNeedCost] = useState(false);
  const [msg, setMsg] = useState({ text: '', err: false });
  const priceRef = useRef(null);
  const costRef = useRef(null);

  useEffect(() => { if (needCost) costRef.current?.focus(); }, [needCost]);

  const pick = g => { setPicked(g); setName(g.name); setNeedCost(false); priceRef.current?.focus(); };

  const readPrice = () => {
    const p = parseFloat(price);
    if (!(p >= 0)) { setMsg({ text: 'Enter the selling price.', err: true }); return null; }
    return p;
  };
  const readQty = () => Math.max(1, parseInt(qty, 10) || 1);

  const record = (good, p, q) => {
    onRecordSale(good, p, q);
    setMsg({ text: `Sale added: ${good.name}, ${money(p * q)}.`, err: false });
    setName(''); setPicked(null); setPrice(''); setQty('1');
    setNewCost(''); setNeedCost(false);
  };

  const submit = e => {
    e.preventDefault();
    const typed = name.trim().toLowerCase();
    if (!typed) return setMsg({ text: 'Enter the goods name.', err: true });
    const good = picked && picked.name.toLowerCase() === typed
      ? picked
      : goods.find(g => g.name.toLowerCase() === typed);
    if (!good) {
      setNeedCost(true);
      return setMsg({ text: 'That item is not in your goods list.', err: true });
    }
    const p = readPrice();
    if (p === null) return;
    record(good, p, readQty());
  };

  const addAndRecord = e => {
    e.preventDefault();
    const n = name.trim();
    const c = parseFloat(newCost);
    if (!(c >= 0)) return setMsg({ text: 'Enter the cost price as a number.', err: true });
    const p = readPrice();
    if (p === null) return;
    const good = onSaveGood(n, c);
    record(good, p, readQty());
  };

  return (
    <Card title="Record a sale" sub="Type a few letters of the goods name and pick it from the list.">
      <form className="form" onSubmit={submit}>
        <div className="field">
          <span>Goods</span>
          <Suggest
            value={name}
            onChange={v => { setName(v); setNeedCost(false); if (picked && v.trim() !== picked.name) setPicked(null); }}
            onPick={pick}
            goods={goods}
            placeholder="Type a few letters"
          />
        </div>
        <p className="hint">{picked ? `Cost price: ${money(num(picked.cost_price))} each` : '\u00A0'}</p>
        <div className="row">
          <div className="field">
            <span>Selling price (₦)</span>
            <input ref={priceRef} value={price} onChange={e => setPrice(e.target.value)} type="number" min="0" step="any" inputMode="decimal" />
          </div>
          <div className="field">
            <span>Quantity</span>
            <input value={qty} onChange={e => setQty(e.target.value)} type="number" min="1" step="1" inputMode="numeric" />
          </div>
        </div>
        <div><button className="btn" type="submit">Add sale</button></div>
        {!needCost && <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>}
      </form>

      {needCost && (
        <form className="add-good form" onSubmit={addAndRecord}>
          <p className="msg err" role="status">{msg.text}</p>
          <p className="sub">Enter the cost price to save "{name.trim()}" to your goods and record this sale.</p>
          <div className="row equal">
            <div className="field">
              <span>Cost price for {name.trim()} (₦)</span>
              <input ref={costRef} value={newCost} onChange={e => setNewCost(e.target.value)} type="number" min="0" step="any" inputMode="decimal" />
            </div>
            <div className="field">
              <span>Selling price (₦)</span>
              <input value={price} onChange={e => setPrice(e.target.value)} type="number" min="0" step="any" inputMode="decimal" />
            </div>
          </div>
          <div><button className="btn" type="submit">Add to goods and record sale</button></div>
        </form>
      )}
    </Card>
  );
}

function ExpensePanel({ onAddExpense }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState({ text: '', err: false });

  const submit = e => {
    e.preventDefault();
    const a = parseFloat(amount);
    if (!(a >= 0)) return setMsg({ text: 'Enter the amount as a number.', err: true });
    onAddExpense(label.trim() || 'Expense', a);
    setLabel(''); setAmount('');
    setMsg({ text: 'Expense added.', err: false });
  };

  return (
    <Card title="Expenses" sub="Costs that are not goods, such as transport or electricity.">
      <form className="form" onSubmit={submit}>
        <div className="row equal">
          <div className="field">
            <span>What for</span>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Transport" />
          </div>
          <div className="field">
            <span>Amount (₦)</span>
            <input value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" step="any" inputMode="decimal" />
          </div>
        </div>
        <div><button className="btn secondary" type="submit">Add expense</button></div>
        <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
      </form>
    </Card>
  );
}

/* ---------- PDF export ---------- */
function savePdf(date, sales, expenses) {
  if (!window.jspdf) {
    alert('The PDF tool could not load. Check your internet connection and try again.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const P = 4;   // padding between columns
  const cols = [
    { h: 'Date', w: 66, a: 'left' },
    { h: 'Goods', w: 116, a: 'left' },
    { h: 'Qty', w: 34, a: 'right' },
    { h: 'Cost price', w: 62, a: 'right' },
    { h: 'Selling price', w: 66, a: 'right' },
    { h: 'Total cost', w: 58, a: 'right' },
    { h: 'Total sales', w: 58, a: 'right' },
    { h: 'Profit', w: 55, a: 'right' }
  ];
  const money2 = v => (v < 0 ? '-' : '') + 'NGN ' + Math.round(Math.abs(v)).toLocaleString('en-US');
  const shortDate = s => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

  let y = M;
  const writeRow = (values, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    let x = M;
    cols.forEach((c, i) => {
      const text = String(values[i] == null ? '' : values[i]);
      if (c.a === 'right') doc.text(text, x + c.w - P, y, { align: 'right' });
      else doc.text(text, x + P, y);
      x += c.w;
    });
  };
  const header = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('Daily Ledger: Sales record', M, y);
    y += 20;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(longDate(date), M, y);
    y += 22;
    doc.setFontSize(8.5);
    writeRow(cols.map(c => c.h), true);
    y += 6;
    doc.setLineWidth(0.6);
    doc.line(M, y, W - M, y);
    y += 13;
    doc.setFont('helvetica', 'normal');
  };
  const newPageIfNeeded = need => {
    if (y + need > H - M) { doc.addPage(); y = M; header(); }
  };

  doc.setFontSize(8.5);
  header();

  if (!sales.length) {
    doc.text('No sales recorded for this day.', M, y);
    y += 16;
  }
  sales.forEach(s => {
    newPageIfNeeded(16);
    const q = num(s.quantity), tc = num(s.cost_price) * q, ts = num(s.selling_price) * q, pr = ts - tc;
    writeRow([
      shortDate(s.sale_date), clip(s.goods_name, 22), q,
      money2(num(s.cost_price)), money2(num(s.selling_price)),
      money2(tc), money2(ts), money2(pr)
    ], false);
    y += 16;
  });

  const t = dayTotals(sales, expenses);
  if (sales.length) {
    newPageIfNeeded(30);
    doc.setLineWidth(0.4);
    doc.line(M, y - 8, W - M, y - 8);
    writeRow(['', 'Total', t.items, '', '', money2(t.cost), money2(t.revenue), money2(t.gross)], true);
    y += 22;
  }

  // Expenses
  newPageIfNeeded(40);
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Expenses', M, y);
  y += 16;
  doc.setFontSize(8.5);
  if (!expenses.length) {
    doc.setFont('helvetica', 'normal');
    doc.text('No expenses recorded for this day.', M, y);
    y += 16;
  }
  expenses.forEach(e => {
    newPageIfNeeded(16);
    writeRow([shortDate(e.expense_date), clip(e.label, 40), '', '', '', '', money2(num(e.amount)), ''], false);
    y += 16;
  });
  if (expenses.length) {
    writeRow(['', 'Total expenses', '', '', '', '', money2(t.exp), ''], true);
    y += 16;
  }

  // Summary
  newPageIfNeeded(80);
  y += 12;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Summary', M, y);
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const line = (label, value, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(label, M, y);
    doc.text(value, W - M, y, { align: 'right' });
    y += 16;
  };
  line('Gross profit (sales minus cost)', money2(t.gross));
  line('Expenses', money2(t.exp));
  line(t.net >= 0 ? 'Net profit' : 'Net loss', money2(t.net), true);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text('Generated ' + new Date().toLocaleString('en-GB'), M, H - 24);

  // Build the file in memory and start a download link, which works on phones and desktops
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sales-${date}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------- Review a day ---------- */
function DayReview({ sales, expenses, onDeleteSale, onDeleteExpense, onDeleteDay, onSavePdf }) {
  const t = dayTotals(sales, expenses);
  const hasRecords = sales.length > 0 || expenses.length > 0;
  return (
    <div>
      <div className="table-wrap">
        <table className="sheet">
          <thead>
            <tr>
              <th>#</th><th>Goods</th>
              <th className="n">Qty</th><th className="n">Cost price</th><th className="n">Selling price</th>
              <th className="n">Total cost</th><th className="n">Total sales</th><th className="n">Profit</th><th></th>
            </tr>
          </thead>
          <tbody>
            {sales.length ? sales.map((s, i) => {
              const q = num(s.quantity), tc = num(s.cost_price) * q, ts = num(s.selling_price) * q, pr = ts - tc;
              return (
                <tr key={s.id}>
                  <td>{i + 1}</td>
                  <td>{s.goods_name}</td>
                  <td className="n">{q}</td>
                  <td className="n">{money(num(s.cost_price))}</td>
                  <td className="n">{money(num(s.selling_price))}</td>
                  <td className="n">{money(tc)}</td>
                  <td className="n">{money(ts)}</td>
                  <td className={'n ' + (pr >= 0 ? 'pos' : 'neg')}>{money(pr)}</td>
                  <td><button className="del" aria-label="Delete this sale" onClick={() => onDeleteSale(s)}>×</button></td>
                </tr>
              );
            }) : (
              <tr><td colSpan="9" className="empty">No sales recorded for this day.</td></tr>
            )}
          </tbody>
          {sales.length > 0 && (
            <tfoot>
              <tr>
                <th colSpan="2">Total</th>
                <th className="n">{t.items}</th><th></th><th></th>
                <th className="n">{money(t.cost)}</th>
                <th className="n">{money(t.revenue)}</th>
                <th className={'n ' + (t.gross >= 0 ? 'pos' : 'neg')}>{money(t.gross)}</th>
                <th></th>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <h3 className="section">Expenses</h3>
      <div className="table-wrap">
        <table className="sheet">
          <thead>
            <tr><th>#</th><th>Expense</th><th className="n">Amount</th><th></th></tr>
          </thead>
          <tbody>
            {expenses.length ? expenses.map((e, i) => (
              <tr key={e.id}>
                <td>{i + 1}</td>
                <td>{e.label}</td>
                <td className="n">{money(num(e.amount))}</td>
                <td><button className="del" aria-label="Delete this expense" onClick={() => onDeleteExpense(e)}>×</button></td>
              </tr>
            )) : (
              <tr><td colSpan="4" className="empty">No expenses recorded for this day.</td></tr>
            )}
          </tbody>
          {expenses.length > 0 && (
            <tfoot>
              <tr><th colSpan="2">Total expenses</th><th className="n">{money(t.exp)}</th><th></th></tr>
            </tfoot>
          )}
        </table>
      </div>

      <h3 className="section">Summary</h3>
      <div className="summary">
        <div className="item"><span>Gross profit (sales minus cost)</span><strong className={t.gross >= 0 ? 'pos' : 'neg'}>{money(t.gross)}</strong></div>
        <div className="item"><span>Expenses</span><strong>{money(t.exp)}</strong></div>
        <div className="item wide">
          <span>{t.net >= 0 ? 'Net profit' : 'Net loss'}</span>
          <strong className={t.net >= 0 ? 'pos' : 'neg'}>{money(t.net)}</strong>
        </div>
      </div>

      {(onSavePdf || onDeleteDay) && (
        <div className="actions-row">
          {onSavePdf && (
            <button
              className="btn secondary small"
              type="button"
              disabled={!hasRecords}
              onClick={() => onSavePdf(sales, expenses)}
            >
              Download PDF
            </button>
          )}
          {onDeleteDay && (
            <ConfirmButton
              label="Delete all records for this day"
              confirmLabel="Tap again to delete this day"
              onConfirm={onDeleteDay}
              className="btn danger small"
              disabled={!hasRecords}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Offline notice ---------- */
function OfflineDialog({ onClose }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="offline-title" aria-describedby="offline-desc">
        <h2 id="offline-title">You are offline</h2>
        <p id="offline-desc">
          Your sales, expenses and goods are saved on this device and will be sent to the database
          when you reconnect. Keep using this same browser until everything has synced, so nothing is lost.
        </p>
        <div className="actions-row">
          <button className="btn" type="button" onClick={onClose} autoFocus>I understand</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- App ---------- */
const TABS = [
  { id: 'sell', label: 'Record sales' },
  { id: 'goods', label: 'Goods' },
  { id: 'review', label: "Today's review" },
  { id: 'history', label: 'Past days' }
];

function Ledger({ user }) {
  const [theme, setTheme] = useTheme();
  const [tab, setTab] = useState('sell');
  const [openDay, setOpenDay] = useState(null);
  const [showOffline, setShowOffline] = useState(!navigator.onLine);
  const ledger = useLedger(user.id);
  const today = todayStr();

  // Show the offline notice once each time the connection drops
  useEffect(() => {
    if (!ledger.online) setShowOffline(true);
    else setShowOffline(false);
  }, [ledger.online]);

  const todaySales = useMemo(() => ledger.sales.filter(s => s.sale_date === today), [ledger.sales, today]);
  const todayExpenses = useMemo(() => ledger.expenses.filter(e => e.expense_date === today), [ledger.expenses, today]);
  const pastDates = useMemo(() => {
    const set = new Set([...ledger.sales.map(s => s.sale_date), ...ledger.expenses.map(e => e.expense_date)]);
    return [...set].filter(d => d !== today).sort().reverse();
  }, [ledger.sales, ledger.expenses, today]);

  const exportPdf = (date, s, e) => {
    try {
      savePdf(date, s, e);
    } catch (err) {
      alert('Could not create the PDF: ' + (err && err.message ? err.message : err));
    }
  };

  const t = dayTotals(todaySales, todayExpenses);

  const signOut = async () => {
    if (ledger.pending > 0) {
      alert(`${ledger.pending} change(s) are not saved to the database yet. Reconnect to the internet and wait until everything is saved, then sign out.`);
      return;
    }
    await db.auth.signOut();
  };

  const header = (
    <header className="topbar">
      <div className="brand">
        <h1>Daily Ledger</h1>
        <p>{longDate(today)}</p>
      </div>
      <div className="topbar-actions">
        <StatusPill online={ledger.online} syncing={ledger.syncing} pending={ledger.pending} />
        <button type="button" className="btn secondary small" onClick={signOut}>Sign out</button>
        <ThemeToggle theme={theme} onToggle={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
      </div>
    </header>
  );

  if (!CONFIGURED) {
    return (
      <div className="app">
        {header}
        <Card title="Connect your database" sub="The app needs a Supabase project before it can save anything.">
          <p>Open <code>config.js</code> and paste your Supabase project URL and publishable key. Then run <code>schema.sql</code> once in the Supabase SQL editor.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="app">
      {header}

      {showOffline && <OfflineDialog onClose={() => setShowOffline(false)} />}
      {!ledger.online && (
        <div className="banner" role="status">
          You are offline. Your entries are saved on this device and will sync when you reconnect.
        </div>
      )}
      {ledger.failures.length > 0 && (
        <div className="banner" role="alert">
          <strong>{ledger.failures.length} change{ledger.failures.length > 1 ? 's' : ''} could not be saved to the database.</strong>
          <ul className="fail-list">
            {ledger.failures.map(f => <li key={f.id}>{f.label}: {f.message}</li>)}
          </ul>
          <button className="btn secondary small" type="button" onClick={ledger.dismissFailures}>Dismiss</button>
        </div>
      )}

      <div className="kpis" role="region" aria-label="Today's totals">
        <div className="kpi"><span>Sales today</span><strong>{money(t.revenue)}</strong></div>
        <div className="kpi"><span>Items sold</span><strong>{t.items}</strong></div>
        <div className="kpi"><span>Expenses</span><strong>{money(t.exp)}</strong></div>
        <div className="kpi featured">
          <span>{t.net >= 0 ? 'Net profit today' : 'Net loss today'}</span>
          <strong className={t.net >= 0 ? 'pos' : 'neg'}>{money(t.net)}</strong>
        </div>
      </div>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map(x => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls="panel"
            className="tab"
            onClick={() => setTab(x.id)}
          >
            {x.label}
          </button>
        ))}
      </nav>

      <main id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'sell' && (
          <div className="grid-2">
            <SalePanel goods={ledger.goods} onSaveGood={ledger.saveGood} onRecordSale={ledger.recordSale} />
            <div className="stack">
              <ExpensePanel onAddExpense={ledger.addExpense} />
              <Card title="Latest sales today" sub="The five most recent sales. Open Today's review for the full sheet.">
                <ul className="list">
                  {todaySales.length ? todaySales.slice(-5).reverse().map(s => (
                    <li key={s.id}>
                      <div><strong>{s.goods_name}</strong><small>{num(s.quantity)} × {money(num(s.selling_price))}</small></div>
                      <span className="r">
                        <span className="num">{money(num(s.selling_price) * num(s.quantity))}</span>
                        <button className="del" aria-label="Delete this sale" onClick={() => ledger.deleteSale(s)}>×</button>
                      </span>
                    </li>
                  )) : <li className="empty">No sales yet today.</li>}
                </ul>
              </Card>
            </div>
          </div>
        )}

        {tab === 'goods' && (
          <GoodsPanel goods={ledger.goods} onSave={ledger.saveGood} onDelete={ledger.deleteGood} />
        )}

        {tab === 'review' && (
          <Card title="Today's review" sub="Every sale and expense recorded today, with profit for each line.">
            <DayReview
              sales={todaySales}
              expenses={todayExpenses}
              onDeleteSale={ledger.deleteSale}
              onDeleteExpense={ledger.deleteExpense}
              onSavePdf={(s, e) => exportPdf(today, s, e)}
              onDeleteDay={() => ledger.deleteDay(today)}
            />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Past days" sub="Select a day to review it, or delete its records.">
            {pastDates.length ? pastDates.map(d => {
              const ds = ledger.sales.filter(s => s.sale_date === d);
              const de = ledger.expenses.filter(e => e.expense_date === d);
              const dt = dayTotals(ds, de);
              const open = openDay === d;
              return (
                <div className="day" key={d}>
                  <button className="day-head" aria-expanded={open} onClick={() => setOpenDay(open ? null : d)}>
                    <span>{longDate(d)}</span>
                    <span className={'num ' + (dt.net >= 0 ? 'pos' : 'neg')}>
                      {dt.net >= 0 ? 'Profit ' : 'Loss '}{money(Math.abs(dt.net))}
                    </span>
                  </button>
                  {open && (
                    <div className="day-body">
                      <DayReview
                        sales={ds}
                        expenses={de}
                        onDeleteSale={ledger.deleteSale}
                        onDeleteExpense={ledger.deleteExpense}
                        onSavePdf={(s, e) => exportPdf(d, s, e)}
                        onDeleteDay={() => ledger.deleteDay(d)}
                      />
                    </div>
                  )}
                </div>
              );
            }) : <p className="empty">Past days will appear here once you have recorded sales on another date.</p>}
          </Card>
        )}
      </main>
    </div>
  );
}

/* ---------- Sign in ---------- */
function AuthScreen() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', err: false });

  const submit = async e => {
    e.preventDefault();
    if (!navigator.onLine) return setMsg({ text: 'You need an internet connection to sign in or create an account.', err: true });
    if (!email.trim()) return setMsg({ text: 'Enter your email address.', err: true });
    if (password.length < 6) return setMsg({ text: 'Use a password of at least 6 characters.', err: true });
    setBusy(true);
    setMsg({ text: '', err: false });
    try {
      if (mode === 'signup') {
        const { data, error } = await db.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) {
          setMsg({ text: 'Account created. Open the confirmation link sent to your email, then sign in.', err: false });
          setMode('signin');
        }
      } else {
        const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (err) {
      setMsg({ text: err.message, err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app narrow">
      <header className="topbar">
        <div className="brand">
          <h1>Daily Ledger</h1>
          <p>Sign in to see your own records</p>
        </div>
      </header>
      <Card title={mode === 'signin' ? 'Sign in' : 'Create an account'} sub="Your sales, expenses and goods are private to your account.">
        <nav className="tabs" role="tablist" aria-label="Sign in or create account">
          <button type="button" role="tab" aria-selected={mode === 'signin'} className="tab" onClick={() => setMode('signin')}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className="tab" onClick={() => setMode('signup')}>Create account</button>
        </nav>
        <form className="form" onSubmit={submit}>
          <div className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          </div>
          <div><button className="btn block" type="submit" disabled={busy}>{busy ? 'Please wait…' : (mode === 'signin' ? 'Sign in' : 'Create account')}</button></div>
          <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
        </form>
      </Card>
    </div>
  );
}

/* ---------- App: decides between sign-in and the ledger ---------- */
function App() {
  const [session, setSession] = useState(undefined);   // undefined while checking

  useEffect(() => {
    if (!CONFIGURED) return;
    db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = db.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!CONFIGURED) {
    return (
      <div className="app narrow">
        <Card title="Connect your database" sub="The app needs a Supabase project before it can save anything.">
          <p>Open <code>config.js</code> and paste your Supabase project URL and publishable key. Then run <code>schema.sql</code> once in the Supabase SQL editor.</p>
        </Card>
      </div>
    );
  }
  if (session === undefined) return <div className="app narrow"><p className="empty">Loading…</p></div>;
  if (!session) return <AuthScreen />;
  return <Ledger key={session.user.id} user={session.user} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
