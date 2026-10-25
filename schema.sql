-- Run this once in the Supabase dashboard: SQL Editor > New query > Run.

create table if not exists public.goods (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  cost_price numeric(14,2) not null check (cost_price >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_date date not null,
  goods_name text not null,
  quantity integer not null default 1 check (quantity > 0),
  cost_price numeric(14,2) not null check (cost_price >= 0),
  selling_price numeric(14,2) not null check (selling_price >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null,
  label text not null,
  amount numeric(14,2) not null check (amount >= 0),
  created_at timestamptz not null default now()
);

create index if not exists sales_sale_date_idx on public.sales (sale_date);
create index if not exists expenses_expense_date_idx on public.expenses (expense_date);

-- Row Level Security.
-- These policies let anyone with the site's anon key read, add and delete records.
-- That is fine for a private test, but before sharing the site widely, add sign-in
-- (Supabase Auth) and replace these policies with per-user rules.
alter table public.goods enable row level security;
alter table public.sales enable row level security;
alter table public.expenses enable row level security;

create policy "anon can manage goods" on public.goods
  for all to anon, authenticated using (true) with check (true);
create policy "anon can manage sales" on public.sales
  for all to anon, authenticated using (true) with check (true);
create policy "anon can manage expenses" on public.expenses
  for all to anon, authenticated using (true) with check (true);
