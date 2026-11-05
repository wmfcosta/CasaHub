-- CasaHub: lista de compras compartilhada da família
-- Tabelas: familias, membros, listas, itens, catalogo

create extension if not exists pg_cron;

create table public.familias (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 80),
  codigo_convite text not null unique,
  criado_por uuid not null references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);

create table public.membros (
  familia_id uuid not null references public.familias(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 60),
  papel text not null default 'membro' check (papel in ('admin','membro')),
  criado_em timestamptz not null default now(),
  primary key (familia_id, user_id)
);
create index membros_user_idx on public.membros(user_id);

create table public.listas (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  status text not null default 'aberta' check (status in ('aberta','finalizada')),
  criado_em timestamptz not null default now(),
  criado_por uuid references auth.users(id) on delete set null,
  finalizada_em timestamptz,
  finalizada_por uuid references auth.users(id) on delete set null,
  total int,
  comprados int
);
-- só uma lista aberta por família
create unique index listas_uma_aberta on public.listas(familia_id) where status = 'aberta';
create index listas_familia_idx on public.listas(familia_id, status, finalizada_em);

create table public.itens (
  id uuid primary key default gen_random_uuid(),
  lista_id uuid not null references public.listas(id) on delete cascade,
  familia_id uuid not null references public.familias(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 80),
  secao text not null default 'outros',
  qtd text not null default '' check (char_length(qtd) <= 30),
  comprado boolean not null default false,
  adicionado_por uuid references auth.users(id) on delete set null,
  adicionado_em timestamptz not null default now(),
  comprado_por uuid references auth.users(id) on delete set null,
  comprado_em timestamptz
);
create index itens_lista_idx on public.itens(lista_id);
create index itens_familia_idx on public.itens(familia_id);

create table public.catalogo (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 80),
  secao text not null default 'outros',
  criado_por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now()
);
create unique index catalogo_nome_unico on public.catalogo(familia_id, lower(nome));

-- ---------- acesso ----------
create or replace function public.eh_membro(f uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.membros m where m.familia_id = f and m.user_id = (select auth.uid()));
$$;

alter table public.familias enable row level security;
alter table public.membros  enable row level security;
alter table public.listas   enable row level security;
alter table public.itens    enable row level security;
alter table public.catalogo enable row level security;

create policy "membros veem a familia" on public.familias for select to authenticated using (public.eh_membro(id));
create policy "admin renomeia familia" on public.familias for update to authenticated
  using (exists(select 1 from public.membros m where m.familia_id = id and m.user_id = (select auth.uid()) and m.papel = 'admin'));

create policy "membros veem membros" on public.membros for select to authenticated using (public.eh_membro(familia_id));
create policy "cada um edita o proprio nome" on public.membros for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "sair da familia" on public.membros for delete to authenticated using (user_id = (select auth.uid()));

create policy "membros leem listas" on public.listas for select to authenticated using (public.eh_membro(familia_id));

create policy "membros leem itens" on public.itens for select to authenticated using (public.eh_membro(familia_id));
create policy "membros incluem itens" on public.itens for insert to authenticated
  with check (public.eh_membro(familia_id)
    and exists(select 1 from public.listas l where l.id = lista_id and l.familia_id = itens.familia_id and l.status = 'aberta'));
create policy "membros alteram itens" on public.itens for update to authenticated
  using (public.eh_membro(familia_id)) with check (public.eh_membro(familia_id));
create policy "membros removem itens" on public.itens for delete to authenticated using (public.eh_membro(familia_id));

create policy "membros leem catalogo" on public.catalogo for select to authenticated using (public.eh_membro(familia_id));
create policy "membros incluem no catalogo" on public.catalogo for insert to authenticated with check (public.eh_membro(familia_id));
create policy "membros removem do catalogo" on public.catalogo for delete to authenticated using (public.eh_membro(familia_id));

-- ---------- funções ----------
create or replace function public.gerar_codigo()
returns text language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random()*32)::int, 1), '')
  from generate_series(1,6);
$$;

create or replace function public.criar_familia(p_nome_familia text, p_meu_nome text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_cod text;
begin
  if auth.uid() is null then raise exception 'login necessário'; end if;
  loop
    v_cod := public.gerar_codigo();
    exit when not exists(select 1 from public.familias where codigo_convite = v_cod);
  end loop;
  insert into public.familias(nome, codigo_convite, criado_por) values (trim(p_nome_familia), v_cod, auth.uid()) returning id into v_id;
  insert into public.membros(familia_id, user_id, nome, papel) values (v_id, auth.uid(), trim(p_meu_nome), 'admin');
  return v_id;
end $$;

create or replace function public.entrar_familia(p_codigo text, p_meu_nome text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'login necessário'; end if;
  select id into v_id from public.familias where codigo_convite = upper(trim(p_codigo));
  if v_id is null then raise exception 'Código de convite não encontrado'; end if;
  insert into public.membros(familia_id, user_id, nome) values (v_id, auth.uid(), trim(p_meu_nome))
  on conflict (familia_id, user_id) do update set nome = excluded.nome;
  return v_id;
end $$;

-- devolve a lista aberta da família, criando uma se não houver
create or replace function public.lista_aberta(p_familia uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.eh_membro(p_familia) then raise exception 'sem acesso'; end if;
  select id into v_id from public.listas where familia_id = p_familia and status = 'aberta';
  if v_id is not null then return v_id; end if;
  insert into public.listas(familia_id, criado_por) values (p_familia, auth.uid())
  on conflict (familia_id) where status = 'aberta' do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.listas where familia_id = p_familia and status = 'aberta';
  end if;
  return v_id;
end $$;

-- finaliza a lista; se p_levar, os itens não comprados vão para uma nova lista
create or replace function public.finalizar_lista(p_lista uuid, p_levar boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_fam uuid; v_nova uuid; v_total int; v_comp int;
begin
  select familia_id into v_fam from public.listas where id = p_lista and status = 'aberta' for update;
  if v_fam is null then raise exception 'Lista não está aberta'; end if;
  if not public.eh_membro(v_fam) then raise exception 'sem acesso'; end if;
  select count(*), count(*) filter (where comprado) into v_total, v_comp from public.itens where lista_id = p_lista;
  update public.listas set status = 'finalizada', finalizada_em = now(), finalizada_por = auth.uid(),
    total = v_total, comprados = v_comp where id = p_lista;
  if p_levar and v_total > v_comp then
    insert into public.listas(familia_id, criado_por) values (v_fam, auth.uid()) returning id into v_nova;
    insert into public.itens(lista_id, familia_id, nome, secao, qtd, adicionado_por)
      select v_nova, v_fam, nome, secao, qtd, adicionado_por from public.itens where lista_id = p_lista and not comprado;
  end if;
  return v_nova;
end $$;

revoke all on function public.criar_familia(text,text), public.entrar_familia(text,text),
  public.lista_aberta(uuid), public.finalizar_lista(uuid,boolean), public.gerar_codigo() from public, anon;
grant execute on function public.criar_familia(text,text), public.entrar_familia(text,text),
  public.lista_aberta(uuid), public.finalizar_lista(uuid,boolean) to authenticated;

-- ---------- tempo real ----------
alter publication supabase_realtime add table public.itens, public.listas, public.catalogo, public.membros;
alter table public.itens replica identity full;

-- ---------- histórico de 5 semanas ----------
create or replace function public.limpar_historico()
returns void language sql security definer set search_path = '' as $$
  delete from public.listas where status = 'finalizada' and finalizada_em < now() - interval '35 days';
$$;
revoke all on function public.limpar_historico() from public, anon, authenticated;

select cron.schedule('casahub-limpar-historico', '15 6 * * *', $$select public.limpar_historico()$$);
