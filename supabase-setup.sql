-- Dieses Skript im Supabase SQL Editor ausführen (siehe Anleitung).

create table if not exists horses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner text,
  pin text not null,
  status text not null default 'weide_normal',
  comment text default '',
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Echtzeit-Updates aktivieren
alter publication supabase_realtime add table horses;

-- Row Level Security aktivieren, aber offenen Zugriff erlauben.
-- Wichtig: Das bedeutet, jeder mit dem Link kann lesen/schreiben,
-- geschützt nur durch den Code (PIN) auf App-Ebene, nicht durch echte Nutzer-Rechte.
alter table horses enable row level security;

create policy "Öffentlicher Lesezugriff" on horses
  for select using (true);

create policy "Öffentlicher Schreibzugriff" on horses
  for insert with check (true);

create policy "Öffentlicher Änderungszugriff" on horses
  for update using (true);

create policy "Öffentlicher Löschzugriff" on horses
  for delete using (true);
