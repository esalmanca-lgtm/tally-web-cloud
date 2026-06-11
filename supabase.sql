-- Tally Web Cloud — NO AUTH schema
-- Run this in: Supabase Dashboard > SQL Editor > New query > paste > Run
-- Drop old auth-based tables if they exist, then recreate without user_id

drop table if exists entries  cascade;
drop table if exists vouchers cascade;
drop table if exists ledgers  cascade;
drop table if exists groups   cascade;
drop view  if exists ledger_balances;

create table groups (
  id     bigint generated always as identity primary key,
  name   text not null unique,
  parent text not null default '',
  nature text not null default ''
);

create table ledgers (
  id      bigint generated always as identity primary key,
  name    text not null unique,
  parent  text not null default '',
  opening numeric not null default 0
);

create table vouchers (
  id       bigint generated always as identity primary key,
  date     text not null,
  vchtype  text not null default 'Journal',
  number   text not null default '',
  party    text not null default '',
  narration text not null default '',
  source   text not null default 'import'
);

create table entries (
  id     bigint generated always as identity primary key,
  vid    bigint not null references vouchers(id) on delete cascade,
  ledger text not null,
  amount numeric not null
);

create index idx_vouchers_date   on vouchers(date);
create index idx_entries_ledger  on entries(ledger);
create index idx_entries_vid     on entries(vid);

-- Disable RLS (no per-user isolation needed — single shared workspace)
alter table groups   disable row level security;
alter table ledgers  disable row level security;
alter table vouchers disable row level security;
alter table entries  disable row level security;

-- Allow anon role full access (the anon key is used in config.js)
grant all on groups,  ledgers, vouchers, entries to anon;
grant usage, select on all sequences in schema public to anon;

-- Ledger closing balances view
create or replace view ledger_balances as
select l.name, l.parent, l.opening,
       l.opening + coalesce(
         (select sum(e.amount) from entries e where e.ledger = l.name), 0
       ) as closing
from ledgers l;

grant select on ledger_balances to anon;

-- Config table for persistent settings (e.g. company name)
create table if not exists config (
  key   text primary key,
  value text not null
);

grant all on config to anon;
