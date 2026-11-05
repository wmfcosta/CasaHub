-- CasaHub (Neon): lista de compras compartilhada da família
-- Login pelo Neon Auth; o id do usuário vem de auth.user_id() (texto).
-- Acesso pelo Data API com as regras de linha (RLS) abaixo.

create table if not exists public.familias (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 1 and 80),
  codigo_convite text not null unique,
  criado_por text not null,
  criado_em timestamptz not null default now()
);

create table if not exists public.membros (
  familia_id uuid not null references public.familias(id) on delete cascade,
  user_id text not null,
  nome text not null check (char_length(nome) between 1 and 60),
  papel text not null default 'membro' check (papel in ('admin','membro')),
  criado_em timestamptz not null default now(),
  primary key (familia_id, user_id)
);
create index if not exists membros_user_idx on public.membros(user_id);

create table if not exists public.listas (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  status text not null default 'aberta' check (status in ('aberta','finalizada')),
  criado_em timestamptz not null default now(),
  criado_por text,
  finalizada_em timestamptz,
  finalizada_por text,
  total int,
  comprados int
);
-- só uma lista aberta por família
create unique index if not exists listas_uma_aberta on public.listas(familia_id) where status = 'aberta';
create index if not exists listas_familia_idx on public.listas(familia_id, status, finalizada_em);

create table if not exists public.itens (
  id uuid primary key default gen_random_uuid(),
  lista_id uuid not null references public.listas(id) on delete cascade,
  familia_id uuid not null references public.familias(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 80),
  secao text not null default 'outros',
  qtd text not null default '' check (char_length(qtd) <= 30),
  comprado boolean not null default false,
  adicionado_por text,
  adicionado_em timestamptz not null default now(),
  comprado_por text,
  comprado_em timestamptz,
  alterado_em timestamptz not null default now()
);
create index if not exists itens_lista_idx on public.itens(lista_id);
create index if not exists itens_familia_idx on public.itens(familia_id, alterado_em);

create table if not exists public.catalogo (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 80),
  secao text not null default 'outros',
  criado_por text,
  criado_em timestamptz not null default now()
);
create unique index if not exists catalogo_nome_unico on public.catalogo(familia_id, lower(nome));

-- marca a hora da última mudança de cada item
create or replace function public.tocar_alterado_em() returns trigger language plpgsql as $$
begin new.alterado_em := now(); return new; end $$;
drop trigger if exists itens_alterado_em on public.itens;
create trigger itens_alterado_em before update on public.itens for each row execute function public.tocar_alterado_em();

-- ---------- acesso ----------
create or replace function public.eh_membro(f uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.membros m where m.familia_id = f and m.user_id = auth.user_id());
$$;

alter table public.familias enable row level security;
alter table public.membros  enable row level security;
alter table public.listas   enable row level security;
alter table public.itens    enable row level security;
alter table public.catalogo enable row level security;

drop policy if exists familias_ler on public.familias;
create policy familias_ler on public.familias for select to authenticated using (public.eh_membro(id));
drop policy if exists familias_admin on public.familias;
create policy familias_admin on public.familias for update to authenticated
  using (exists(select 1 from public.membros m where m.familia_id = id and m.user_id = auth.user_id() and m.papel = 'admin'));

drop policy if exists membros_ler on public.membros;
create policy membros_ler on public.membros for select to authenticated using (public.eh_membro(familia_id));
drop policy if exists membros_proprio_nome on public.membros;
create policy membros_proprio_nome on public.membros for update to authenticated
  using (user_id = auth.user_id()) with check (user_id = auth.user_id());
drop policy if exists membros_sair on public.membros;
create policy membros_sair on public.membros for delete to authenticated using (user_id = auth.user_id());

drop policy if exists listas_ler on public.listas;
create policy listas_ler on public.listas for select to authenticated using (public.eh_membro(familia_id));

drop policy if exists itens_ler on public.itens;
create policy itens_ler on public.itens for select to authenticated using (public.eh_membro(familia_id));
drop policy if exists itens_incluir on public.itens;
create policy itens_incluir on public.itens for insert to authenticated
  with check (public.eh_membro(familia_id)
    and exists(select 1 from public.listas l where l.id = lista_id and l.familia_id = itens.familia_id and l.status = 'aberta'));
drop policy if exists itens_alterar on public.itens;
create policy itens_alterar on public.itens for update to authenticated
  using (public.eh_membro(familia_id)) with check (public.eh_membro(familia_id));
drop policy if exists itens_remover on public.itens;
create policy itens_remover on public.itens for delete to authenticated using (public.eh_membro(familia_id));

drop policy if exists catalogo_ler on public.catalogo;
create policy catalogo_ler on public.catalogo for select to authenticated using (public.eh_membro(familia_id));
drop policy if exists catalogo_incluir on public.catalogo;
create policy catalogo_incluir on public.catalogo for insert to authenticated with check (public.eh_membro(familia_id));
drop policy if exists catalogo_remover on public.catalogo;
create policy catalogo_remover on public.catalogo for delete to authenticated using (public.eh_membro(familia_id));

-- ---------- funções ----------
create or replace function public.gerar_codigo()
returns text language sql volatile set search_path = public, pg_temp as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random()*32)::int, 1), '')
  from generate_series(1,6);
$$;

-- histórico de 5 semanas: apaga listas finalizadas há mais de 35 dias da família
create or replace function public.limpar_historico(p_familia uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from public.listas where familia_id = p_familia and status = 'finalizada' and finalizada_em < now() - interval '35 days';
$$;

create or replace function public.criar_familia(p_nome_familia text, p_meu_nome text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_cod text; v_uid text := auth.user_id();
begin
  if v_uid is null then raise exception 'Faça login novamente'; end if;
  loop
    v_cod := public.gerar_codigo();
    exit when not exists(select 1 from public.familias where codigo_convite = v_cod);
  end loop;
  insert into public.familias(nome, codigo_convite, criado_por) values (trim(p_nome_familia), v_cod, v_uid) returning id into v_id;
  insert into public.membros(familia_id, user_id, nome, papel) values (v_id, v_uid, trim(p_meu_nome), 'admin');
  return v_id;
end $$;

create or replace function public.entrar_familia(p_codigo text, p_meu_nome text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_uid text := auth.user_id();
begin
  if v_uid is null then raise exception 'Faça login novamente'; end if;
  select id into v_id from public.familias where codigo_convite = upper(trim(p_codigo));
  if v_id is null then raise exception 'Código de convite não encontrado'; end if;
  insert into public.membros(familia_id, user_id, nome) values (v_id, v_uid, trim(p_meu_nome))
  on conflict (familia_id, user_id) do update set nome = excluded.nome;
  return v_id;
end $$;

-- devolve a lista aberta da família, criando uma se não houver
create or replace function public.lista_aberta(p_familia uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.eh_membro(p_familia) then raise exception 'Sem acesso a esta família'; end if;
  perform public.limpar_historico(p_familia);
  select id into v_id from public.listas where familia_id = p_familia and status = 'aberta';
  if v_id is not null then return v_id; end if;
  insert into public.listas(familia_id, criado_por) values (p_familia, auth.user_id())
  on conflict (familia_id) where status = 'aberta' do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.listas where familia_id = p_familia and status = 'aberta';
  end if;
  return v_id;
end $$;

-- finaliza a lista; se p_levar, os itens não comprados vão para uma nova lista
create or replace function public.finalizar_lista(p_lista uuid, p_levar boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_fam uuid; v_nova uuid; v_total int; v_comp int;
begin
  select familia_id into v_fam from public.listas where id = p_lista and status = 'aberta' for update;
  if v_fam is null then raise exception 'Esta lista já foi finalizada'; end if;
  if not public.eh_membro(v_fam) then raise exception 'Sem acesso a esta família'; end if;
  select count(*), count(*) filter (where comprado) into v_total, v_comp from public.itens where lista_id = p_lista;
  update public.listas set status = 'finalizada', finalizada_em = now(), finalizada_por = auth.user_id(),
    total = v_total, comprados = v_comp where id = p_lista;
  if p_levar and v_total > v_comp then
    insert into public.listas(familia_id, criado_por) values (v_fam, auth.user_id()) returning id into v_nova;
    insert into public.itens(lista_id, familia_id, nome, secao, qtd, adicionado_por)
      select v_nova, v_fam, nome, secao, qtd, adicionado_por from public.itens where lista_id = p_lista and not comprado;
  end if;
  perform public.limpar_historico(v_fam);
  return v_nova;
end $$;

-- marca de versão da família: o app consulta isto a cada poucos segundos
-- e só recarrega os dados quando algo mudou
create or replace function public.versao_familia(p_familia uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.eh_membro(p_familia) then concat_ws('|',
    (select count(*) || ':' || coalesce(max(alterado_em)::text,'') from public.itens where familia_id = p_familia),
    (select count(*) || ':' || coalesce(max(coalesce(finalizada_em, criado_em))::text,'') from public.listas where familia_id = p_familia),
    (select count(*) from public.catalogo where familia_id = p_familia),
    (select count(*) || ':' || string_agg(nome, ',' order by user_id) from public.membros where familia_id = p_familia)
  ) end;
$$;

-- ---------- permissões do Data API ----------
revoke all on all functions in schema public from public;
revoke all on all tables in schema public from anonymous;
grant usage on schema public to authenticated;
grant select on public.familias, public.membros, public.listas, public.itens, public.catalogo to authenticated;
grant update (nome) on public.familias to authenticated;
grant update (nome) on public.membros to authenticated;
grant delete on public.membros to authenticated;
grant insert, delete on public.itens, public.catalogo to authenticated;
grant update (comprado, comprado_por, comprado_em, qtd, secao, nome) on public.itens to authenticated;
grant execute on function public.criar_familia(text,text), public.entrar_familia(text,text),
  public.lista_aberta(uuid), public.finalizar_lista(uuid,boolean), public.versao_familia(uuid),
  public.eh_membro(uuid), public.tocar_alterado_em() to authenticated;
