const { useState, useEffect, useMemo, useRef } = React;

/* ---------- Setup ---------- */
const CONFIGURED = !!window.SUPABASE_URL && !window.SUPABASE_URL.includes('YOUR-PROJECT');
const db = CONFIGURED ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;

const SNAP_KEY = 'daily-ledger-snapshot';
const QUEUE_KEY = 'daily-ledger-queue';
const FAIL_KEY = 'daily-ledger-failures';

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
const shortDay = s => new Date(s + 'T00:00:00').toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

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

/* ---------- Icons ---------- */
const ICON_PATHS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  back: 'M19 12H5M12 19l-7-7 7-7',
  plus: 'M12 5v14M5 12h14',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  table: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16',
  calendar: 'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
  wallet: 'M3 7h18v12H3zM3 7l13-4v4M16 13h2',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chart: 'M3 3v18h18M7 14l4-4 3 3 5-6',
  star: 'M12 2l3 7 7 .6-5.3 4.8 1.6 7.2L12 17.8 5.7 21.6l1.6-7.2L2 9.6 9 9z',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  mail: 'M4 4h16v16H4zM4 6l8 6 8-6',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  dots: 'M5 12h.01M12 12h.01M19 12h.01'
};

function Icon({ name, size = 22, className = '' }) {
  return (
    <svg className={'icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name] || ''} />
    </svg>
  );
}

/* ---------- Offline data layer ---------- */
const EMPTY_SNAP = { goods: [], sales: [], expenses: [] };

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
      if (res.error.code === '23505') return { ok: true };
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
    if (g.error || s.error || e.error) return;
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

/* ---------- Navigation: one page at a time, with back and device back ---------- */
const ROOT = 'home';

function useNav() {
  const [stack, setStack] = useState(() => (history.state && history.state.stack) || [{ name: ROOT, params: {} }]);
  const stackRef = useRef(stack);

  const apply = s => { stackRef.current = s; setStack(s); };

  useEffect(() => {
    history.replaceState({ stack: stackRef.current }, '');
    const onPop = e => apply((e.state && e.state.stack) || [{ name: ROOT, params: {} }]);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Open a page on top of the current one (back returns to it)
  const go = (name, params = {}) => {
    const next = [...stackRef.current, { name, params }];
    apply(next);
    history.pushState({ stack: next }, '');
  };
  // Switch to a main section (no back history between sections)
  const root = (name, params = {}) => {
    const next = [{ name, params }];
    apply(next);
    history.replaceState({ stack: next }, '');
  };
  // Go back one page. The popstate listener restores the previous page.
  const back = () => {
    if (stackRef.current.length > 1) history.back();
    else root(ROOT);
  };

  return { stack, current: stack[stack.length - 1], depth: stack.length, go, root, back };
}

const PAGE_TITLES = {
  home: 'Sales tracker',
  record: 'Record a sale',
  expense: 'Add expense',
  goods: 'Goods',
  review: "Today's review",
  history: 'Past days',
  day: 'Day record',
  feedback: 'Feedback and ratings',
  settings: 'Settings',
  reminders: 'Reminders',
  updates: 'App updates',
  profile: 'Profile',
  password: 'Change password'
};

const SETTINGS_PAGES = ['settings', 'reminders', 'updates', 'profile', 'password'];

/* ---------- Theme ---------- */
function useTheme() {
  const [pref, setPref] = useState(() => readLS('daily-ledger-theme-pref', 'system'));
  useEffect(() => {
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && !!(mq && mq.matches));
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    };
    apply();
    writeLS('daily-ledger-theme-pref', pref);
    if (mq && pref === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [pref]);
  return [pref, setPref];
}

/* ---------- Small components ---------- */
function Card({ title, sub, actions, children }) {
  return (
    <section className="card">
      {(title || sub || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {sub && <p className="sub">{sub}</p>}
          </div>
          {actions}
        </div>
      )}
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
    text = pending ? `Offline · ${pending} saved` : 'Offline';
    cls = 'off';
  } else if (syncing || pending) {
    text = syncing ? 'Syncing…' : `${pending} to sync`;
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

function PasswordInput({ value, onChange, autoComplete, placeholder, id }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
      />
      <button type="button" className="pw-toggle" aria-pressed={show} onClick={() => setShow(s => !s)}>
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
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

/* ---------- Pages: heading (web) and menu rows ---------- */
function PageHead({ title, sub, onBack }) {
  return (
    <div className="page-head">
      {onBack && (
        <button className="back-btn" type="button" onClick={onBack}>
          <Icon name="back" size={18} /> Back
        </button>
      )}
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
    </div>
  );
}

function MenuList({ rows, onGo, onSignOut }) {
  return (
    <ul className="menu-list">
      {rows.map(r => (
        <li key={r.label}>
          <button
            type="button"
            className="menu-row"
            onClick={() => (r.action === 'signout' ? onSignOut() : onGo(r.go, r.params || {}))}
          >
            <span className="menu-ico" style={{ background: r.color }}><Icon name={r.icon} size={18} /></span>
            <span className="menu-label">{r.label}</span>
            {r.count != null && <span className="menu-count">{r.count}</span>}
            <span className="menu-chev" aria-hidden="true">›</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---------- Goods ---------- */
function GoodsPage({ goods, onSave, onDelete }) {
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
    <div className="stack">
      <Card title="Add or update goods" sub="Saved goods appear as suggestions when you record a sale.">
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
      </Card>
      <Card title={`Saved goods (${goods.length})`}>
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
    </div>
  );
}

/* ---------- Record a sale ---------- */
function RecordPage({ goods, onSaveGood, onRecordSale, onViewReview }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(null);
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [newCost, setNewCost] = useState('');
  const [needCost, setNeedCost] = useState(false);
  const [done, setDone] = useState(null);
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
    setDone({ name: good.name, total: p * q });
    setMsg({ text: '', err: false });
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
    <div className="stack">
      {done && (
        <div className="banner success" role="status">
          <strong>Sale recorded: {done.name}, {money(done.total)}.</strong>
          <div className="banner-actions">
            <button className="btn small" type="button" onClick={onViewReview}>View today's review</button>
            <button className="btn secondary small" type="button" onClick={() => setDone(null)}>Record another</button>
          </div>
        </div>
      )}
      <Card sub="Type a few letters of the goods name and pick it from the list.">
        <form className="form" onSubmit={submit}>
          <div className="field">
            <span>Goods</span>
            <Suggest
              value={name}
              onChange={v => { setName(v); setNeedCost(false); setDone(null); if (picked && v.trim() !== picked.name) setPicked(null); }}
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
    </div>
  );
}

/* ---------- Expenses ---------- */
function ExpensePage({ expenses, onAddExpense, onDeleteExpense }) {
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

  const total = expenses.reduce((a, x) => a + num(x.amount), 0);

  return (
    <div className="stack">
      <Card sub="Costs that are not goods, such as transport or electricity.">
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
          <div><button className="btn" type="submit">Add expense</button></div>
          <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
        </form>
      </Card>
      <Card title="Expenses today" actions={<span className="num">{money(total)}</span>}>
        <ul className="list">
          {expenses.length ? expenses.map(x => (
            <li key={x.id}>
              <span>{x.label}</span>
              <span className="r">
                <span className="num">{money(num(x.amount))}</span>
                <button className="del" aria-label="Delete this expense" onClick={() => onDeleteExpense(x)}>×</button>
              </span>
            </li>
          )) : <li className="empty">No expenses recorded today.</li>}
        </ul>
      </Card>
    </div>
  );
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
            <button className="btn secondary small" type="button" disabled={!hasRecords} onClick={() => onSavePdf(sales, expenses)}>
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
  const P = 4;
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
    doc.text('Sales tracker: Sales record', M, y);
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

/* ---------- Feedback ---------- */
function FeedbackPanel({ user }) {
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', err: false });
  const [sent, setSent] = useState(false);

  const submit = async e => {
    e.preventDefault();
    if (!rating) return setMsg({ text: 'Tap a star to rate the app.', err: true });
    if (!navigator.onLine) return setMsg({ text: 'Feedback needs an internet connection. Please try again when you are online.', err: true });
    setBusy(true);
    setMsg({ text: '', err: false });
    try {
      const { error } = await db.from('feedback').insert({
        user_id: user.id,
        rating,
        message: message.trim().slice(0, 1000)
      });
      if (error) throw error;
      setSent(true);
      setRating(0);
      setMessage('');
    } catch (err) {
      setMsg({ text: 'Could not send feedback: ' + (err.message || err), err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {sent && <div className="banner success" role="status">Thank you. Your feedback has been sent.</div>}
      <Card sub="Tell us what works, what does not, and what you need. We read every message.">
        <form className="form" onSubmit={submit}>
          <div className="field">
            <span>How would you rate Sales tracker?</span>
            <div className="stars" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map(n => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  className={'star' + (n <= rating ? ' on' : '')}
                  onClick={() => setRating(n)}
                >★</button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Your message (optional)</span>
            <textarea
              rows="4"
              maxLength="1000"
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="What should we improve or add?"
            />
          </div>
          <div><button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send feedback'}</button></div>
          <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
        </form>
      </Card>
    </div>
  );
}

/* ---------- Profile ---------- */
function ProfilePanel({ user, profile, onSaved }) {
  const [fullName, setFullName] = useState(profile.full_name || '');
  const [businessName, setBusinessName] = useState(profile.business_name || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', err: false });

  useEffect(() => {
    setFullName(profile.full_name || '');
    setBusinessName(profile.business_name || '');
  }, [profile.full_name, profile.business_name]);

  const submit = async e => {
    e.preventDefault();
    if (!fullName.trim()) return setMsg({ text: 'Enter your name.', err: true });
    if (!navigator.onLine) return setMsg({ text: 'Profile changes need an internet connection. Please try again when you are online.', err: true });
    setBusy(true);
    setMsg({ text: '', err: false });
    const next = { full_name: fullName.trim(), business_name: businessName.trim() };
    try {
      const { error } = await db.from('profiles').upsert(
        { user_id: user.id, ...next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      );
      if (error) throw error;
      onSaved(next);
      setMsg({ text: 'Profile saved.', err: false });
    } catch (err) {
      setMsg({ text: 'Could not save: ' + (err.message || err), err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card sub="Your name and business name appear at the top of the app.">
      <form className="form" onSubmit={submit}>
        <div className="field">
          <span>Your name</span>
          <input value={fullName} onChange={e => setFullName(e.target.value)} maxLength="100" autoComplete="name" />
        </div>
        <div className="field">
          <span>Business name</span>
          <input value={businessName} onChange={e => setBusinessName(e.target.value)} maxLength="150" placeholder="e.g. Mama Chi Provisions" />
        </div>
        <div className="field">
          <span>Email (cannot be changed here)</span>
          <input value={user.email || ''} disabled />
        </div>
        <div><button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button></div>
        <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
      </form>
    </Card>
  );
}

/* ---------- Background reminders (web push) ---------- */
function urlBase64ToUint8Array(b64) {
  const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

async function syncPush(user, reminders) {
  if (!CONFIGURED || !window.VAPID_PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (!reminders.enabled) {
    if (existing) await db.from('push_subscriptions').update({ enabled: false }).eq('endpoint', existing.endpoint);
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY)
  });
  const j = sub.toJSON();
  const { error } = await db.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint: j.endpoint,
    p256dh: j.keys.p256dh,
    auth: j.keys.auth,
    reminder_time: reminders.time || '18:00',
    utc_offset_minutes: -new Date().getTimezoneOffset(),
    enabled: true
  }, { onConflict: 'endpoint' });
  if (error) throw error;
}

function ReminderSettings({ user, reminders, onChange }) {
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState(supported ? Notification.permission : 'unsupported');
  const allow = async () => {
    if (!supported) return;
    const p = await Notification.requestPermission();
    setPerm(p);
    if (p === 'granted') syncPush(user, reminders).catch(() => {});
  };
  const hint = !supported
    ? 'This browser does not support notifications. Reminders still appear in the app when you open it.'
    : perm === 'granted'
      ? 'Notifications are on. You will get a reminder even when the app is closed.'
      : perm === 'denied'
        ? 'Notifications are blocked. Allow them in your browser or phone settings to get pop-up reminders.'
        : 'Allow notifications to get a reminder even when the app is closed. On iPhone, add the app to your home screen first.';
  return (
    <Card sub="Get a reminder when nothing has been recorded for today.">
      <div className="form">
        <label className="check">
          <input type="checkbox" checked={reminders.enabled} onChange={e => onChange({ ...reminders, enabled: e.target.checked })} />
          Remind me to record today's sales and expenses
        </label>
        <div className="field">
          <span>Reminder time</span>
          <input type="time" value={reminders.time} onChange={e => onChange({ ...reminders, time: e.target.value })} />
        </div>
        <p className="hint">{hint}</p>
        {supported && perm === 'default' && (
          <div><button className="btn secondary small" type="button" onClick={allow}>Allow notifications</button></div>
        )}
      </div>
    </Card>
  );
}

/* ---------- App updates ---------- */
function UpdateSettings() {
  const [auto, setAuto] = useState(() => {
    try { return localStorage.getItem('daily-ledger-auto-update') !== 'off'; } catch (e) { return true; }
  });
  const [msg, setMsg] = useState('');
  const toggle = e => {
    const on = e.target.checked;
    setAuto(on);
    try { localStorage.setItem('daily-ledger-auto-update', on ? 'on' : 'off'); } catch (err) {}
  };
  const checkNow = async () => {
    setMsg('Checking…');
    try {
      const reg = window.swRegistration || await navigator.serviceWorker.getRegistration();
      if (!reg) return setMsg('Updates are not available on this device yet.');
      await reg.update();
      setMsg(window.waitingWorker ? 'A new version is ready.' : 'You have the latest version.');
    } catch (err) {
      setMsg('Could not check for updates. Check your internet connection.');
    }
  };
  return (
    <Card sub="Keep Sales tracker up to date with the latest improvements.">
      <div className="form">
        <label className="check">
          <input type="checkbox" checked={auto} onChange={toggle} />
          Update the app automatically
        </label>
        <p className="hint">{auto
          ? 'New versions install by themselves. The app may reload once when this happens.'
          : 'You will see an "Update now" button when a new version is ready.'}</p>
        <div><button className="btn secondary small" type="button" onClick={checkNow}>Check for updates</button></div>
        <p className="hint" role="status">{msg}</p>
      </div>
    </Card>
  );
}

/* ---------- Change password (signed in) ---------- */
function NewPasswordForm({ submitLabel, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', err: false });

  const submit = async e => {
    e.preventDefault();
    if (pw.length < 6) return setMsg({ text: 'Use a password of at least 6 characters.', err: true });
    if (pw !== pw2) return setMsg({ text: 'The two passwords do not match.', err: true });
    if (!navigator.onLine) return setMsg({ text: 'You need an internet connection to change your password.', err: true });
    setBusy(true);
    const { error } = await db.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setMsg({ text: error.message, err: true });
    setPw(''); setPw2('');
    setMsg({ text: 'Your password has been updated.', err: false });
    if (onDone) onDone();
  };

  return (
    <form className="form" onSubmit={submit}>
      <div className="field">
        <span>New password</span>
        <PasswordInput value={pw} onChange={setPw} autoComplete="new-password" placeholder="At least 6 characters" />
      </div>
      <div className="field">
        <span>Confirm new password</span>
        <PasswordInput value={pw2} onChange={setPw2} autoComplete="new-password" placeholder="Type it again" />
      </div>
      <div><button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
      <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
    </form>
  );
}

/* ---------- Settings ---------- */
function SettingsPage({ theme, setTheme, onGo, onSignOut }) {
  const options = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' }
  ];
  const general = [
    { icon: 'bell', color: '#CA8A04', label: 'Reminders', go: 'reminders' },
    { icon: 'refresh', color: '#4F46E5', label: 'App updates', go: 'updates' }
  ];
  const account = [
    { icon: 'user', color: '#475569', label: 'Profile', go: 'profile' },
    { icon: 'lock', color: '#0F766E', label: 'Change password', go: 'password' }
  ];
  return (
    <div className="stack">
      <Card title="Appearance" sub="Choose how Sales tracker looks on this device.">
        <div className="seg" role="radiogroup" aria-label="Theme">
          {options.map(o => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={theme === o.id}
              className={'seg-btn' + (theme === o.id ? ' on' : '')}
              onClick={() => setTheme(o.id)}
            >{o.label}</button>
          ))}
        </div>
      </Card>
      <Card title="Preferences"><MenuList rows={general} onGo={onGo} /></Card>
      <Card title="Account"><MenuList rows={account} onGo={onGo} /></Card>
      <Card title="About">
        <p className="about-name">SamistInTech</p>
        <p className="sub">Web Developer and Digital Marketer</p>
      </Card>
      <button className="btn danger block" type="button" onClick={onSignOut}>Sign out</button>
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

/* ---------- Sign in, create account, reset password ---------- */
function AuthScreen() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', err: false });

  const titles = { signin: 'Sign in', signup: 'Create an account', forgot: 'Reset your password' };

  const submit = async e => {
    e.preventDefault();
    if (!navigator.onLine) return setMsg({ text: 'You need an internet connection to continue.', err: true });
    if (!email.trim()) return setMsg({ text: 'Enter your email address.', err: true });
    setBusy(true);
    setMsg({ text: '', err: false });
    try {
      if (mode === 'forgot') {
        const { error } = await db.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin + window.location.pathname
        });
        if (error) throw error;
        setMsg({ text: 'If an account exists for this email, a reset link has been sent. Open it on this device.', err: false });
        return;
      }
      if (password.length < 6) throw new Error('Use a password of at least 6 characters.');
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
      setMsg({ text: err.message || String(err), err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="brand-img" src="icon-192.png" alt="" width="36" height="36" />
          <div>
            <h1>Sales tracker</h1>
            <p className="sub">Your sales, expenses and profit in one place.</p>
          </div>
        </div>
        <Card title={titles[mode]} sub={mode === 'forgot' ? 'Enter your email and we will send a reset link.' : 'Your records are private to your account.'}>
          {mode !== 'forgot' && (
            <div className="seg" role="tablist" aria-label="Sign in or create account">
              <button type="button" role="tab" aria-selected={mode === 'signin'} className={'seg-btn' + (mode === 'signin' ? ' on' : '')} onClick={() => setMode('signin')}>Sign in</button>
              <button type="button" role="tab" aria-selected={mode === 'signup'} className={'seg-btn' + (mode === 'signup' ? ' on' : '')} onClick={() => setMode('signup')}>Create account</button>
            </div>
          )}
          <form className="form" onSubmit={submit}>
            <div className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
            </div>
            {mode !== 'forgot' && (
              <div className="field">
                <span>Password</span>
                <PasswordInput value={password} onChange={setPassword} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder="At least 6 characters" />
              </div>
            )}
            {mode === 'signin' && (
              <div className="link-row">
                <button type="button" className="link-btn" onClick={() => { setMode('forgot'); setMsg({ text: '', err: false }); }}>Forgot password?</button>
              </div>
            )}
            <div>
              <button className="btn block" type="submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'forgot' ? 'Send reset link' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </div>
            {mode === 'forgot' && (
              <div className="link-row">
                <button type="button" className="link-btn" onClick={() => { setMode('signin'); setMsg({ text: '', err: false }); }}>Back to sign in</button>
              </div>
            )}
            <p className={'msg' + (msg.err ? ' err' : '')} role="status">{msg.text}</p>
          </form>
        </Card>
      </div>
    </div>
  );
}

/* ---------- Choose a new password from a reset link ---------- */
function RecoverScreen({ onDone }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="brand-img" src="icon-192.png" alt="" width="36" height="36" />
          <div><h1>Sales tracker</h1><p className="sub">Choose a new password.</p></div>
        </div>
        <Card title="Set a new password" sub="Enter a new password for your account.">
          <NewPasswordForm submitLabel="Save new password" onDone={onDone} />
        </Card>
      </div>
    </div>
  );
}

/* ---------- Loading screen ---------- */
function Splash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <img src="apple-touch-icon.png" alt="" width="88" height="88" className="splash-icon" />
      <p className="splash-msg">Every sale counted. Every naira accounted for.</p>
      <p className="splash-sub">Loading…</p>
    </div>
  );
}

/* ---------- Main ledger ---------- */
const WEB_LINKS = [
  { id: 'home', label: 'Home' },
  { id: 'record', label: 'Record sales' },
  { id: 'goods', label: 'Goods' },
  { id: 'review', label: 'Review' },
  { id: 'history', label: 'Past days' },
  { id: 'feedback', label: 'Feedback' }
];

const BOTTOM_NAV = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'record', label: 'Record', icon: 'plus' },
  { id: 'goods', label: 'Goods', icon: 'box' },
  { id: 'review', label: 'Review', icon: 'table' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
];

function Ledger({ user, isApp, theme, setTheme }) {
  const profileKey = 'daily-ledger-profile:' + user.id;
  const remKey = 'daily-ledger-reminders:' + user.id;
  const dismissKey = 'daily-ledger-reminder-dismissed:' + user.id;
  const notifKey = 'daily-ledger-notified:' + user.id;

  const [profile, setProfile] = useState(() => readLS(profileKey, { full_name: '', business_name: '' }));
  const saveProfileLocal = p => { setProfile(p); writeLS(profileKey, p); };
  useEffect(() => {
    if (!CONFIGURED || !navigator.onLine) return;
    db.from('profiles').select('full_name, business_name').eq('user_id', user.id).maybeSingle()
      .then(({ data, error }) => { if (!error && data) saveProfileLocal(data); });
  }, []);

  const ledger = useLedger(user.id);
  const nav = useNav();
  const today = todayStr();

  const todaySales = useMemo(() => ledger.sales.filter(s => s.sale_date === today), [ledger.sales, today]);
  const todayExpenses = useMemo(() => ledger.expenses.filter(e => e.expense_date === today), [ledger.expenses, today]);
  const pastDates = useMemo(() => {
    const set = new Set([...ledger.sales.map(s => s.sale_date), ...ledger.expenses.map(e => e.expense_date)]);
    return [...set].filter(d => d !== today).sort().reverse();
  }, [ledger.sales, ledger.expenses, today]);
  const t = dayTotals(todaySales, todayExpenses);

  // Reminders
  const [reminders, setReminders] = useState(() => readLS(remKey, { enabled: true, time: '18:00' }));
  const saveReminders = r => { setReminders(r); writeLS(remKey, r); syncPush(user, r).catch(() => {}); };
  const [dismissedDay, setDismissedDay] = useState(() => readLS(dismissKey, ''));
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const nowDate = new Date(clock);
  const [rh, rm] = String(reminders.time || '18:00').split(':').map(Number);
  const reminderDue = reminders.enabled && (nowDate.getHours() * 60 + nowDate.getMinutes()) >= (rh * 60 + rm);
  const nothingRecordedToday = todaySales.length === 0 && todayExpenses.length === 0;
  const showReminder = reminderDue && nothingRecordedToday && dismissedDay !== today;
  const dismissReminder = () => { setDismissedDay(today); writeLS(dismissKey, today); };

  useEffect(() => {
    if (!showReminder || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (readLS(notifKey, '') === today) return;
    writeLS(notifKey, today);
    const title = 'Sales tracker';
    const body = 'Are you missing any sales or expenses today? Log in now and add them.';
    const fallback = () => { try { new Notification(title, { body }); } catch (e) {} };
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready
        .then(reg => reg.showNotification(title, { body, icon: 'icon-192.png', tag: 'daily-reminder' }))
        .catch(fallback);
    } else {
      fallback();
    }
  }, [showReminder, today]);

  useEffect(() => { syncPush(user, reminders).catch(() => {}); }, []);

  // Connection notice
  const [showOffline, setShowOffline] = useState(!navigator.onLine);
  useEffect(() => { setShowOffline(!ledger.online); }, [ledger.online]);

  // App updates
  const [updateReady, setUpdateReady] = useState(!!window.waitingWorker);
  useEffect(() => {
    const ready = () => setUpdateReady(true);
    window.addEventListener('updateready', ready);
    return () => window.removeEventListener('updateready', ready);
  }, []);
  const applyUpdateNow = () => {
    if (window.waitingWorker) window.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  };

  // Install (web)
  const [canInstall, setCanInstall] = useState(!!window.deferredInstall);
  useEffect(() => {
    const ready = () => setCanInstall(true);
    const done = () => setCanInstall(false);
    window.addEventListener('installready', ready);
    window.addEventListener('installdone', done);
    return () => {
      window.removeEventListener('installready', ready);
      window.removeEventListener('installdone', done);
    };
  }, []);
  const install = async () => {
    const evt = window.deferredInstall;
    if (!evt) return;
    evt.prompt();
    await evt.userChoice;
    window.deferredInstall = null;
    setCanInstall(false);
  };

  const signOut = async () => {
    if (ledger.pending > 0) {
      alert(`${ledger.pending} change(s) are not saved to the database yet. Reconnect to the internet and wait until everything is saved, then sign out.`);
      return;
    }
    await db.auth.signOut();
  };

  const cur = nav.current;
  const isRoot = nav.depth === 1;
  const initial = (profile.business_name || 'S').trim().charAt(0).toUpperCase();
  const exportPdf = (date, s, e) => {
    try { savePdf(date, s, e); } catch (err) { alert('Could not create the PDF: ' + (err && err.message ? err.message : err)); }
  };

  const menuRows = [
    { icon: 'plus', color: '#16A34A', label: 'Record sales', go: 'record' },
    { icon: 'box', color: '#2563EB', label: 'Goods', count: ledger.goods.length, go: 'goods' },
    { icon: 'table', color: '#F97316', label: "Today's review", go: 'review' },
    { icon: 'calendar', color: '#7C3AED', label: 'Past days', count: pastDates.length, go: 'history' },
    { icon: 'wallet', color: '#DC2626', label: 'Expenses today', count: todayExpenses.length, go: 'expense' },
    { icon: 'chat', color: '#0D9488', label: 'Feedback and ratings', go: 'feedback' },
    { icon: 'settings', color: '#64748B', label: 'Settings', go: 'settings' }
  ];

  const renderPage = r => {
    switch (r.name) {
      case 'home':
        return isApp ? (
          <section className="menu">
            <div className="menu-owner">
              <span className="menu-avatar" aria-hidden="true">{initial}</span>
              <span>{profile.business_name || 'Your business'}</span>
            </div>
            <h2 className="menu-title">Sales tracker</h2>
            <p className="menu-desc">Keep track of your sales, know your daily profit, daily total sales and expenses.</p>
            <div className="menu-meta">
              <span><Icon name="chart" size={16} /> Sales today <strong>{money(t.revenue)}</strong></span>
              <span><Icon name="star" size={16} /> {t.net >= 0 ? 'Net profit' : 'Net loss'} <strong className={t.net >= 0 ? 'pos' : 'neg'}>{money(t.net)}</strong></span>
            </div>
            <div className="menu-actions">
              <button className="btn menu-primary" type="button" onClick={() => nav.go('record')}>
                <Icon name="plus" size={18} /> Record sale
              </button>
            </div>
            <MenuList rows={menuRows} onGo={nav.go} onSignOut={signOut} />
          </section>
        ) : (
          <div className="stack">
            <section className="hero">
              <p className="hero-kicker">{profile.business_name || 'Welcome'} · {longDate(today)}</p>
              <h2 className="hero-title">Today at a glance</h2>
              <div className="kpis">
                <div className="kpi"><span>Sales today</span><strong>{money(t.revenue)}</strong></div>
                <div className="kpi"><span>Items sold</span><strong>{t.items}</strong></div>
                <div className="kpi"><span>Expenses</span><strong>{money(t.exp)}</strong></div>
                <div className="kpi featured"><span>{t.net >= 0 ? 'Net profit' : 'Net loss'}</span><strong className={t.net >= 0 ? 'pos' : 'neg'}>{money(t.net)}</strong></div>
              </div>
            </section>
            <div className="tiles">
              {menuRows.map(m => (
                <button key={m.label} type="button" className="tile" onClick={() => nav.go(m.go)}>
                  <span className="tile-ico" style={{ background: m.color }}><Icon name={m.icon} size={20} /></span>
                  <span className="tile-label">{m.label}</span>
                  {m.count != null && <span className="tile-count">{m.count}</span>}
                </button>
              ))}
            </div>
          </div>
        );

      case 'record':
        return <RecordPage goods={ledger.goods} onSaveGood={ledger.saveGood} onRecordSale={ledger.recordSale} onViewReview={() => nav.go('review')} />;

      case 'expense':
        return <ExpensePage expenses={todayExpenses} onAddExpense={ledger.addExpense} onDeleteExpense={ledger.deleteExpense} />;

      case 'goods':
        return <GoodsPage goods={ledger.goods} onSave={ledger.saveGood} onDelete={ledger.deleteGood} />;

      case 'review':
        return (
          <Card sub="Every sale and expense recorded today, with profit for each line.">
            <DayReview
              sales={todaySales}
              expenses={todayExpenses}
              onDeleteSale={ledger.deleteSale}
              onDeleteExpense={ledger.deleteExpense}
              onDeleteDay={() => { ledger.deleteDay(today); nav.root('home'); }}
              onSavePdf={(s, e) => exportPdf(today, s, e)}
            />
          </Card>
        );

      case 'history':
        return (
          <Card sub="Choose a day to review it, download it, or delete its records.">
            {pastDates.length ? pastDates.map(d => {
              const dt = dayTotals(ledger.sales.filter(s => s.sale_date === d), ledger.expenses.filter(e => e.expense_date === d));
              return (
                <button key={d} type="button" className="day-row" onClick={() => nav.go('day', { date: d })}>
                  <span>{longDate(d)}</span>
                  <span className={'num ' + (dt.net >= 0 ? 'pos' : 'neg')}>{dt.net >= 0 ? 'Profit ' : 'Loss '}{money(Math.abs(dt.net))}</span>
                  <span className="menu-chev" aria-hidden="true">›</span>
                </button>
              );
            }) : <p className="empty">Past days will appear here once you have recorded sales on another date.</p>}
          </Card>
        );

      case 'day': {
        const d = r.params.date;
        const ds = ledger.sales.filter(s => s.sale_date === d);
        const de = ledger.expenses.filter(e => e.expense_date === d);
        return (
          <Card title={longDate(d)} sub="Sales and expenses recorded on this day.">
            <DayReview
              sales={ds}
              expenses={de}
              onDeleteSale={ledger.deleteSale}
              onDeleteExpense={ledger.deleteExpense}
              onDeleteDay={() => { ledger.deleteDay(d); nav.back(); }}
              onSavePdf={(s, e) => exportPdf(d, s, e)}
            />
          </Card>
        );
      }

      case 'feedback':
        return <FeedbackPanel user={user} />;

      case 'settings':
        return <SettingsPage theme={theme} setTheme={setTheme} onGo={nav.go} onSignOut={signOut} />;

      case 'reminders':
        return <Card title="Reminders"><ReminderSettings user={user} reminders={reminders} onChange={saveReminders} /></Card>;

      case 'updates':
        return <Card title="App updates"><UpdateSettings /></Card>;

      case 'profile':
        return (
          <Card title="Profile">
            <ProfilePanel user={user} profile={profile} onSaved={saveProfileLocal} />
          </Card>
        );

      case 'password':
        return (
          <Card title="Change password" sub="Choose a new password. Use at least 6 characters.">
            <NewPasswordForm submitLabel="Update password" />
          </Card>
        );

      default:
        return null;
    }
  };

  const activeSection = SETTINGS_PAGES.includes(cur.name) ? 'settings' : cur.name;
  const pageTitle = PAGE_TITLES[cur.name] || 'Sales tracker';
  const pageSub = cur.name === 'day' ? null : null;

  return (
    <div className={'shell ' + (isApp ? 'mode-app' : 'mode-web')}>
      {isApp ? (
        <header className="appbar">
          {!isRoot ? (
            <button className="icon-btn" type="button" onClick={nav.back} aria-label="Back">
              <Icon name="back" size={22} />
            </button>
          ) : (
            <span className="avatar" aria-hidden="true">{initial}</span>
          )}
          <div className="appbar-title">{isRoot ? (profile.business_name || 'Sales tracker') : pageTitle}</div>
          <StatusPill online={ledger.online} syncing={ledger.syncing} pending={ledger.pending} />
        </header>
      ) : (
        <header className="sitenav">
          <button className="brand-btn" type="button" onClick={() => nav.root('home')}>
            <img className="brand-img" src="icon-192.png" alt="" width="36" height="36" />
            <span>Sales tracker</span>
          </button>
          <nav className="site-links" aria-label="Main">
            {WEB_LINKS.map(l => (
              <button
                key={l.id}
                type="button"
                className={'site-link' + (activeSection === l.id ? ' on' : '')}
                aria-current={activeSection === l.id ? 'page' : undefined}
                onClick={() => nav.root(l.id)}
              >{l.label}</button>
            ))}
          </nav>
          <div className="sitenav-right">
            <StatusPill online={ledger.online} syncing={ledger.syncing} pending={ledger.pending} />
            {canInstall && <button className="btn small" type="button" onClick={install}>Install app</button>}
            <button className={'site-link' + (SETTINGS_PAGES.includes(cur.name) ? ' on' : '')} type="button" onClick={() => nav.root('settings')}>Settings</button>
          </div>
        </header>
      )}

      <div className="notices">
        {showOffline && <OfflineDialog onClose={() => setShowOffline(false)} />}
        {!ledger.online && (
          <div className="banner" role="status">
            You are offline. Your entries are saved on this device and will sync when you reconnect.
          </div>
        )}
        {updateReady && (
          <div className="banner" role="status">
            <strong>A new version of Sales tracker is ready.</strong>
            <div className="banner-actions">
              <button className="btn small" type="button" onClick={applyUpdateNow}>Update now</button>
            </div>
          </div>
        )}
        {showReminder && (
          <div className="banner reminder" role="status">
            <strong>Are you missing any sales or expenses today?</strong>
            <p>Log in now and add them, so your profit figures are right.</p>
            <div className="banner-actions">
              <button className="btn small" type="button" onClick={() => nav.root('record')}>Record sales</button>
              <button className="btn secondary small" type="button" onClick={dismissReminder}>Dismiss</button>
            </div>
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
      </div>

      <main className="page-wrap" id="main">
        {!isApp && !isRoot && (
          <PageHead title={pageTitle} sub={pageSub} onBack={nav.back} />
        )}
        {!isApp && isRoot && cur.name !== 'home' && (
          <PageHead title={pageTitle} sub={null} />
        )}
        <div key={nav.depth + ':' + cur.name} className="page-anim">
          {renderPage(cur)}
        </div>
      </main>

      {isApp && (
        <nav className="bottom-nav" aria-label="Main">
          {BOTTOM_NAV.map(n => {
            const on = n.id === activeSection;
            return (
              <button
                key={n.id}
                type="button"
                className={'bn-item' + (on ? ' on' : '')}
                aria-current={on ? 'page' : undefined}
                onClick={() => nav.root(n.id)}
              >
                <span className="bn-pill"><Icon name={n.icon} size={22} /></span>
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {!isApp && (
        <footer className="site-footer">
          <span>Sales tracker</span>
          <span>SamistInTech · Web Developer and Digital Marketer</span>
        </footer>
      )}
    </div>
  );
}

/* ---------- App: session, recovery, and the right screen ---------- */
function App() {
  const [session, setSession] = useState(undefined);
  const [recovering, setRecovering] = useState(false);
  const [theme, setTheme] = useTheme();
  const isApp = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

  useEffect(() => {
    if (!CONFIGURED) return;
    db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = db.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!CONFIGURED) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Card title="Connect your database" sub="The app needs a Supabase project before it can save anything.">
            <p>Open <code>config.js</code> and paste your Supabase project URL and publishable key. Then run <code>schema.sql</code> once in the Supabase SQL editor.</p>
          </Card>
        </div>
      </div>
    );
  }
  if (session === undefined) return <Splash />;
  if (recovering) return <RecoverScreen onDone={() => setRecovering(false)} />;
  if (!session) return <AuthScreen />;
  return <Ledger key={session.user.id} user={session.user} isApp={isApp} theme={theme} setTheme={setTheme} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
