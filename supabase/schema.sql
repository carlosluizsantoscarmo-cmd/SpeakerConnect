-- =====================================================================
-- SpeakerConnect — banco de dados (Supabase)
-- Cole este arquivo inteiro no Supabase: SQL Editor > New query > Run.
-- Pode rodar de novo sem perder dados (cria só o que falta e atualiza as regras).
--
-- Regra de ouro: o navegador usa só a chave pública (anon). Quem protege os dados
-- são as regras abaixo (RLS). Pagamentos e o selo de verificado só mudam pelo
-- servidor (Cloudflare Worker, com a chave service_role).
-- =====================================================================

-- ---------- utilidades ----------
create schema if not exists private;
revoke all on schema private from public;
-- as regras de alteração (gatilhos) rodam com o usuário logado e precisam enxergar as funções daqui
grant usage on schema private to anon, authenticated;

-- Configurações internas (endereço e senha dos avisos por e-mail). Ninguém do app enxerga.
create table if not exists private.settings (
  key   text primary key,
  value text not null
);

-- Quem está chamando é o servidor (service_role) ou o próprio banco?
create or replace function private.is_backend() returns boolean
language sql stable as $$
  select coalesce(auth.role(), '') = 'service_role'
      or current_user in ('postgres', 'supabase_admin', 'service_role');
$$;

-- ---------- tabelas ----------
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  role              text not null default 'company' check (role in ('speaker', 'company', 'admin')),
  name              text not null check (char_length(name) between 2 and 100),
  email             text,
  phone             text check (phone is null or char_length(phone) <= 30),
  terms_version     text,
  terms_accepted_at timestamptz,
  created_at        timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Temas/categorias de palestra. A equipe pode incluir novas pelo painel.
create table if not exists public.categories (
  name   text primary key check (char_length(name) between 2 and 40),
  sort   int not null default 100,
  active boolean not null default true
);
insert into public.categories (name, sort) values
  ('Liderança', 10), ('Motivacional', 20), ('Vendas', 30), ('Gestão de Pessoas e RH', 40),
  ('Saúde e Bem-Estar', 50), ('Saúde Mental', 55), ('Segurança do Trabalho e SIPAT', 60),
  ('Direito', 70), ('Tecnologia e Inovação', 80), ('Empreendedorismo', 90), ('Marketing', 100),
  ('Finanças', 110), ('Meio Ambiente e ESG', 120), ('Diversidade e Inclusão', 130),
  ('Comunicação e Oratória', 140), ('Educação', 150)
on conflict (name) do nothing;

create table if not exists public.speakers (
  id             uuid primary key references public.profiles(id) on delete cascade,
  public_name    text not null check (char_length(public_name) between 2 and 100),
  headline       text check (headline is null or char_length(headline) <= 120),
  bio            text check (bio is null or char_length(bio) <= 4000),
  categories     text[] not null default '{}' check (cardinality(categories) <= 5),
  topics         text check (topics is null or char_length(topics) <= 1500),
  city           text check (city is null or char_length(city) <= 60),
  uf             text check (uf is null or uf ~ '^[A-Z]{2}$'),
  formats        text[] not null default '{presencial,online}' check (formats <@ array['presencial', 'online']::text[]),
  fee_from_cents int check (fee_from_cents is null or fee_from_cents between 0 and 100000000),
  photo_url      text check (photo_url is null or photo_url ~ '^https://'),
  video_url      text check (video_url is null or video_url ~ '^https://'),
  instagram      text check (instagram is null or char_length(instagram) <= 60),
  linkedin       text check (linkedin is null or linkedin ~ '^https://'),
  status         text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected', 'suspended')),
  review_note    text,
  verified_until timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists speakers_status_idx on public.speakers (status);

create table if not exists public.companies (
  id           uuid primary key references public.profiles(id) on delete cascade,
  company_name text not null check (char_length(company_name) between 2 and 120),
  cnpj         text check (cnpj is null or cnpj ~ '^[0-9]{14}$'),
  city         text check (city is null or char_length(city) <= 60),
  uf           text check (uf is null or uf ~ '^[A-Z]{2}$'),
  website      text check (website is null or char_length(website) <= 200),
  created_at   timestamptz not null default now()
);

-- Pedido de orçamento: a empresa pede, o palestrante manda o valor, a empresa aceita e paga.
create table if not exists public.quotes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  speaker_id     uuid not null references public.speakers(id) on delete cascade,
  company_name   text,
  speaker_name   text,
  title          text not null check (char_length(title) between 3 and 120),
  event_date     date,
  format         text not null default 'presencial' check (format in ('presencial', 'online')),
  city           text check (city is null or char_length(city) <= 60),
  uf             text check (uf is null or uf ~ '^[A-Z]{2}$'),
  audience       int check (audience is null or audience between 1 and 100000),
  duration_min   int check (duration_min is null or duration_min between 10 and 1440),
  message        text check (message is null or char_length(message) <= 2000),
  status         text not null default 'requested'
                 check (status in ('requested', 'proposed', 'accepted', 'paid', 'done', 'declined', 'cancelled')),
  amount_cents   int check (amount_cents is null or amount_cents between 100 and 100000000),
  speaker_note   text check (speaker_note is null or char_length(speaker_note) <= 1000),
  proposed_at    timestamptz,
  accepted_at    timestamptz,
  paid_at        timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists quotes_company_idx on public.quotes (company_id, created_at desc);
create index if not exists quotes_speaker_idx on public.quotes (speaker_id, created_at desc);

create table if not exists public.quote_messages (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  sender_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists quote_messages_idx on public.quote_messages (quote_id, created_at);

-- Pagamentos (selo de verificado e contratações). Só o servidor grava.
create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('verified', 'quote')),
  user_id          uuid references public.profiles(id) on delete set null,
  quote_id         uuid references public.quotes(id) on delete set null,
  speaker_id       uuid references public.speakers(id) on delete set null,
  description      text,
  amount_cents     int not null check (amount_cents > 0),
  commission_cents int not null default 0,
  payout_cents     int not null default 0,
  status           text not null default 'pending',
  mp_payment_id    text,
  payer_name       text,
  payer_email      text,
  payout_done_at   timestamptz,
  paid_at          timestamptz,
  refunded_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists payments_user_idx on public.payments (user_id, created_at desc);

-- ---------- novo usuário: cria o perfil sozinho ----------
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r     text  := case when m->>'role' = 'speaker' then 'speaker' else 'company' end; -- nunca 'admin'
  nm    text  := left(coalesce(nullif(trim(m->>'name'), ''), split_part(new.email, '@', 1)), 100);
begin
  if char_length(nm) < 2 then nm := nm || ' ' || nm; end if;
  insert into public.profiles (id, role, name, email, phone, terms_version, terms_accepted_at)
  values (new.id, r, nm, new.email, left(nullif(trim(m->>'phone'), ''), 30),
          left(m->>'terms_version', 30), case when m ? 'terms_version' then now() end)
  on conflict (id) do nothing;
  if r = 'speaker' then
    insert into public.speakers (id, public_name) values (new.id, nm) on conflict (id) do nothing;
  else
    insert into public.companies (id, company_name)
    values (new.id, left(coalesce(nullif(trim(m->>'company_name'), ''), nm), 120))
    on conflict (id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Mantém o e-mail do perfil igual ao do login.
create or replace function private.sync_user_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_email on auth.users;
create trigger on_auth_user_email after update of email on auth.users
  for each row execute function private.sync_user_email();

-- ---------- regras de alteração (o que cada um pode mudar) ----------
create or replace function private.guard_profiles() returns trigger
language plpgsql as $$
begin
  if private.is_backend() or public.is_admin() then return new; end if;
  if new.id <> old.id or new.role <> old.role or new.email is distinct from old.email
     or new.created_at <> old.created_at then
    raise exception 'Você não pode alterar esse campo.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_profiles on public.profiles;
create trigger guard_profiles before update on public.profiles
  for each row execute function private.guard_profiles();

create or replace function private.guard_speakers() returns trigger
language plpgsql as $$
declare bad text;
begin
  new.updated_at := now();
  -- categorias precisam existir na lista
  select string_agg(c, ', ') into bad from unnest(new.categories) c
   where not exists (select 1 from public.categories k where k.name = c);
  if bad is not null then raise exception 'Categoria inválida: %', bad using errcode = '23514'; end if;

  if private.is_backend() or public.is_admin() then return new; end if;

  if new.verified_until is distinct from old.verified_until or new.review_note is distinct from old.review_note
     or new.created_at <> old.created_at or new.id <> old.id then
    raise exception 'Você não pode alterar esse campo.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    -- o palestrante só pode enviar o perfil para análise (ou voltar para rascunho enquanto espera)
    if not ((old.status in ('draft', 'rejected') and new.status = 'pending')
         or (old.status = 'pending' and new.status = 'draft')) then
      raise exception 'Mudança de situação não permitida.' using errcode = '42501';
    end if;
  end if;
  if new.status = 'pending' and (
       char_length(coalesce(new.headline, '')) < 10 or char_length(coalesce(new.bio, '')) < 80
       or cardinality(new.categories) = 0 or new.city is null or new.uf is null) then
    raise exception 'Complete o perfil antes de enviar: título, apresentação (mín. 80 letras), tema, cidade e UF.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_speakers on public.speakers;
create trigger guard_speakers before insert or update on public.speakers
  for each row execute function private.guard_speakers();

create or replace function private.guard_companies() returns trigger
language plpgsql as $$
begin
  if private.is_backend() or public.is_admin() then return new; end if;
  if new.id <> old.id or new.created_at <> old.created_at then
    raise exception 'Você não pode alterar esse campo.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_companies on public.companies;
create trigger guard_companies before update on public.companies
  for each row execute function private.guard_companies();

-- Pedido de orçamento: preenche os nomes e controla quem muda o quê.
create or replace function private.guard_quotes() returns trigger
language plpgsql set search_path = public as $$
declare me uuid := auth.uid();
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.company_name := (select company_name from public.companies where id = new.company_id);
    new.speaker_name := (select public_name from public.speakers where id = new.speaker_id);
    if private.is_backend() or public.is_admin() then return new; end if;
    if new.company_id is distinct from me then
      raise exception 'Só a própria empresa pode pedir orçamento.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.speakers where id = new.speaker_id and status = 'approved') then
      raise exception 'Este palestrante não está disponível.' using errcode = '23514';
    end if;
    if new.status <> 'requested' or new.amount_cents is not null or new.speaker_note is not null
       or new.paid_at is not null or new.proposed_at is not null or new.accepted_at is not null then
      raise exception 'Pedido inválido.' using errcode = '42501';
    end if;
    new.created_at := now();
    return new;
  end if;

  -- UPDATE
  if private.is_backend() or public.is_admin() then return new; end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.speaker_id <> old.speaker_id
     or new.company_name is distinct from old.company_name or new.speaker_name is distinct from old.speaker_name
     or new.created_at <> old.created_at or new.paid_at is distinct from old.paid_at then
    raise exception 'Você não pode alterar esse campo.' using errcode = '42501';
  end if;

  if me = old.speaker_id then
    -- o palestrante não mexe nos dados do evento
    if (new.title, new.event_date, new.format, new.city, new.uf, new.audience, new.duration_min, new.message)
       is distinct from (old.title, old.event_date, old.format, old.city, old.uf, old.audience, old.duration_min, old.message)
       or new.accepted_at is distinct from old.accepted_at then
      raise exception 'Só a empresa pode mudar os dados do evento.' using errcode = '42501';
    end if;
    if new.status = 'proposed' and old.status in ('requested', 'proposed') then
      if new.amount_cents is null then raise exception 'Informe o valor da proposta.' using errcode = '23514'; end if;
      new.proposed_at := now();
      return new;
    end if;
    if new.status = 'declined' and old.status in ('requested', 'proposed') then
      return new;
    end if;
    if new.status = old.status and new.amount_cents is not distinct from old.amount_cents
       and new.speaker_note is not distinct from old.speaker_note then
      return new;
    end if;
    raise exception 'Mudança não permitida neste momento.' using errcode = '42501';
  end if;

  if me = old.company_id then
    if new.amount_cents is distinct from old.amount_cents or new.speaker_note is distinct from old.speaker_note
       or new.proposed_at is distinct from old.proposed_at then
      raise exception 'Só o palestrante define o valor.' using errcode = '42501';
    end if;
    -- dados do evento só podem mudar antes da proposta
    if old.status <> 'requested' and
       (new.title, new.event_date, new.format, new.city, new.uf, new.audience, new.duration_min, new.message)
       is distinct from (old.title, old.event_date, old.format, old.city, old.uf, old.audience, old.duration_min, old.message) then
      raise exception 'Depois da proposta, combine mudanças pelas mensagens.' using errcode = '42501';
    end if;
    if new.status = old.status then
      if new.accepted_at is distinct from old.accepted_at then
        raise exception 'Mudança não permitida.' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.status = 'accepted' and old.status = 'proposed' then new.accepted_at := now(); return new; end if;
    if new.status = 'cancelled' and old.status in ('requested', 'proposed', 'accepted') then return new; end if;
    if new.status = 'done' and old.status = 'paid' then return new; end if;
    raise exception 'Mudança não permitida neste momento.' using errcode = '42501';
  end if;

  raise exception 'Sem permissão.' using errcode = '42501';
end $$;
drop trigger if exists guard_quotes on public.quotes;
create trigger guard_quotes before insert or update on public.quotes
  for each row execute function private.guard_quotes();

-- ---------- RLS: quem enxerga o quê ----------
alter table public.profiles       enable row level security;
alter table public.categories     enable row level security;
alter table public.speakers       enable row level security;
alter table public.companies      enable row level security;
alter table public.quotes         enable row level security;
alter table public.quote_messages enable row level security;
alter table public.payments       enable row level security;

-- Sem acesso para visitantes, a não ser o que for liberado abaixo.
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.categories to anon, authenticated;
grant select on public.speakers to anon, authenticated;
grant update (public_name, headline, bio, categories, topics, city, uf, formats, fee_from_cents,
              photo_url, video_url, instagram, linkedin, status) on public.speakers to authenticated;
grant select, update (name, phone, terms_version, terms_accepted_at) on public.profiles to authenticated;
grant select, update (company_name, cnpj, city, uf, website) on public.companies to authenticated;
grant select, insert, update on public.quotes to authenticated;
grant select, insert on public.quote_messages to authenticated;
grant select on public.payments to authenticated;
-- a equipe (admin) também precisa destes:
grant insert, update, delete on public.categories to authenticated;
grant update, delete on public.speakers to authenticated;
grant update (role) on public.profiles to authenticated;
grant update (payout_done_at, status) on public.payments to authenticated;
grant delete on public.quotes to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- profiles: cada um vê o seu; a equipe vê todos.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- categories: todos leem; só a equipe muda.
drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select using (true);
drop policy if exists categories_admin on public.categories;
create policy categories_admin on public.categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- speakers: perfis aprovados são públicos; o dono e a equipe veem o resto.
drop policy if exists speakers_read on public.speakers;
create policy speakers_read on public.speakers for select
  using (status = 'approved' or id = auth.uid() or public.is_admin());
drop policy if exists speakers_update on public.speakers;
create policy speakers_update on public.speakers for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
drop policy if exists speakers_delete on public.speakers;
create policy speakers_delete on public.speakers for delete to authenticated using (public.is_admin());

-- companies: a própria empresa, a equipe e o palestrante que recebeu pedido dela.
drop policy if exists companies_read on public.companies;
create policy companies_read on public.companies for select to authenticated
  using (id = auth.uid() or public.is_admin()
         or exists (select 1 from public.quotes q where q.company_id = companies.id and q.speaker_id = auth.uid()));
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- quotes: só as duas partes e a equipe.
drop policy if exists quotes_read on public.quotes;
create policy quotes_read on public.quotes for select to authenticated
  using (company_id = auth.uid() or speaker_id = auth.uid() or public.is_admin());
drop policy if exists quotes_insert on public.quotes;
create policy quotes_insert on public.quotes for insert to authenticated
  with check (company_id = auth.uid());
drop policy if exists quotes_update on public.quotes;
create policy quotes_update on public.quotes for update to authenticated
  using (company_id = auth.uid() or speaker_id = auth.uid() or public.is_admin())
  with check (company_id = auth.uid() or speaker_id = auth.uid() or public.is_admin());
drop policy if exists quotes_delete on public.quotes;
create policy quotes_delete on public.quotes for delete to authenticated using (public.is_admin());

-- mensagens: só quem participa do pedido.
drop policy if exists qm_read on public.quote_messages;
create policy qm_read on public.quote_messages for select to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id
                 and (q.company_id = auth.uid() or q.speaker_id = auth.uid() or public.is_admin())));
drop policy if exists qm_insert on public.quote_messages;
create policy qm_insert on public.quote_messages for insert to authenticated
  with check (sender_id = auth.uid() and exists (
    select 1 from public.quotes q where q.id = quote_id
      and (q.company_id = auth.uid() or q.speaker_id = auth.uid())
      and q.status not in ('declined', 'cancelled')));

-- payments: o pagante vê os seus; o palestrante vê os da contratação dele; a equipe vê todos.
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated
  using (user_id = auth.uid() or public.is_admin()
         or (kind = 'quote' and status = 'paid' and speaker_id = auth.uid()));
drop policy if exists payments_admin on public.payments;
create policy payments_admin on public.payments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- contato liberado só depois do pagamento ----------
create or replace function public.quote_contacts(qid uuid)
returns table (company_contact text, company_phone text, company_email text,
               speaker_contact text, speaker_phone text, speaker_email text)
language sql stable security definer set search_path = public as $$
  select pc.name, pc.phone, pc.email, ps.name, ps.phone, ps.email
    from public.quotes q
    join public.profiles pc on pc.id = q.company_id
    join public.profiles ps on ps.id = q.speaker_id
   where q.id = qid
     and q.status in ('paid', 'done')
     and (q.company_id = auth.uid() or q.speaker_id = auth.uid() or public.is_admin());
$$;
revoke all on function public.quote_contacts(uuid) from public, anon;
grant execute on function public.quote_contacts(uuid) to authenticated;

-- ---------- avisos por e-mail (o servidor monta e envia o e-mail) ----------
-- Precisa da extensão pg_net (Database > Extensions > pg_net) e destas duas linhas, com os seus valores:
--   insert into private.settings values ('notify_url', 'https://SEU-SITE/api/aviso') on conflict (key) do update set value = excluded.value;
--   insert into private.settings values ('notify_secret', 'A MESMA SENHA DO NOTIFY_SECRET NO CLOUDFLARE') on conflict (key) do update set value = excluded.value;
-- Sem isso, nada é enviado e o resto funciona normalmente.
create or replace function private.notify(kind text, ref uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare u text; s text;
begin
  select value into u from private.settings where key = 'notify_url';
  select value into s from private.settings where key = 'notify_secret';
  if u is null or s is null then return; end if;
  begin
    perform net.http_post(
      url := u,
      body := jsonb_build_object('type', kind, 'id', ref),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-sc-secret', s)
    );
  exception when others then
    raise warning 'aviso não enviado: %', sqlerrm; -- nunca trava a ação do usuário
  end;
end $$;

create or replace function private.on_quote_change() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'INSERT' then
    perform private.notify('pedido_novo', new.id);
  elsif new.status is distinct from old.status then
    if new.status = 'proposed' then perform private.notify('proposta_recebida', new.id);
    elsif new.status = 'accepted' then perform private.notify('proposta_aceita', new.id);
    elsif new.status = 'declined' then perform private.notify('pedido_recusado', new.id);
    elsif new.status = 'cancelled' then perform private.notify('pedido_cancelado', new.id);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists on_quote_change on public.quotes;
create trigger on_quote_change after insert or update on public.quotes
  for each row execute function private.on_quote_change();

create or replace function private.on_speaker_change() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'pending' then perform private.notify('perfil_para_analise', new.id);
    elsif new.status = 'approved' then perform private.notify('perfil_aprovado', new.id);
    elsif new.status = 'rejected' then perform private.notify('perfil_recusado', new.id);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists on_speaker_change on public.speakers;
create trigger on_speaker_change after update on public.speakers
  for each row execute function private.on_speaker_change();

create or replace function private.on_message() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  -- no máximo um aviso por conversa a cada 30 minutos, para não lotar a caixa de entrada
  if not exists (select 1 from public.quote_messages m
                  where m.quote_id = new.quote_id and m.sender_id = new.sender_id and m.id <> new.id
                    and m.created_at > now() - interval '30 minutes') then
    perform private.notify('mensagem_nova', new.id);
  end if;
  return null;
end $$;
drop trigger if exists on_message on public.quote_messages;
create trigger on_message after insert on public.quote_messages
  for each row execute function private.on_message();

-- ---------- Mercado Pago dos palestrantes (Split) ----------
-- O palestrante conecta a conta dele; o pagamento da empresa cai direto lá e a plataforma recebe só a comissão.
-- Os tokens ficam cifrados pelo servidor e só o servidor (service_role) lê esta tabela.
create table if not exists public.speaker_mp_accounts (
  speaker_id    uuid primary key references public.speakers(id) on delete cascade,
  mp_user_id    text not null,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.speaker_mp_accounts enable row level security;
revoke all on public.speaker_mp_accounts from anon, authenticated;

alter table public.payments add column if not exists split boolean not null default false;
alter table public.payments add column if not exists mp_seller_id text;

-- Diz só se o palestrante já conectou a conta (sem mostrar nada da conta).
create or replace function public.mp_connected(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.speaker_mp_accounts where speaker_id = sid);
$$;
revoke all on function public.mp_connected(uuid) from public, anon;
grant execute on function public.mp_connected(uuid) to authenticated;

-- ---------- fotos dos palestrantes (Storage) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- o envio da foto também precisa enxergar os próprios arquivos (o Supabase confere isso ao gravar)
drop policy if exists fotos_select on storage.objects;
create policy fotos_select on storage.objects for select to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists fotos_insert on storage.objects;
create policy fotos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists fotos_update on storage.objects;
create policy fotos_update on storage.objects for update to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists fotos_delete on storage.objects;
create policy fotos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Ninguém chama estas funções diretamente; só os gatilhos.
revoke execute on function private.notify(text, uuid) from public, anon, authenticated;
revoke execute on function private.handle_new_user() from public, anon, authenticated;
revoke execute on function private.sync_user_email() from public, anon, authenticated;

-- ---------- primeiro acesso da equipe ----------
-- Depois de criar sua conta pelo app, rode (trocando o e-mail):
--   update public.profiles set role = 'admin' where email = 'seu-email@exemplo.com';
