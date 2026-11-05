-- CasaHub: passeios (registro de chegada nos lugares e de volta para casa)
-- A data e a hora vêm sempre do relógio do servidor (now()), no momento do toque.
-- O app não envia horário e ninguém pode incluir, editar ou apagar registros:
-- a única forma de gravar é pelas funções passeio_chegar e passeio_voltar.

create table if not exists public.passeios (
  id uuid primary key default gen_random_uuid(),
  familia_id uuid not null references public.familias(id) on delete cascade,
  user_id text not null,
  iniciado_em timestamptz not null default now(),
  voltou_em timestamptz,
  alterado_em timestamptz not null default now()
);
-- no máximo um passeio em andamento por pessoa
create unique index if not exists passeios_um_aberto on public.passeios(familia_id, user_id) where voltou_em is null;
create index if not exists passeios_familia_idx on public.passeios(familia_id, iniciado_em desc);

create table if not exists public.passeio_paradas (
  id uuid primary key default gen_random_uuid(),
  passeio_id uuid not null references public.passeios(id) on delete cascade,
  familia_id uuid not null references public.familias(id) on delete cascade,
  local text not null check (char_length(local) between 1 and 80),
  chegou_em timestamptz not null default now()
);
create index if not exists paradas_passeio_idx on public.passeio_paradas(passeio_id);
create index if not exists paradas_familia_idx on public.passeio_paradas(familia_id, chegou_em desc);

alter table public.passeios enable row level security;
alter table public.passeio_paradas enable row level security;

drop policy if exists passeios_ler on public.passeios;
create policy passeios_ler on public.passeios for select to authenticated using (public.eh_membro(familia_id));
drop policy if exists paradas_ler on public.passeio_paradas;
create policy paradas_ler on public.passeio_paradas for select to authenticated using (public.eh_membro(familia_id));

-- registra a chegada num lugar; abre o passeio se a pessoa estava em casa
-- devolve o horário registrado
create or replace function public.passeio_chegar(p_familia uuid, p_local text)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid text := auth.user_id(); v_local text := regexp_replace(trim(coalesce(p_local,'')), '\s+', ' ', 'g');
  v_id uuid; v_ult record; v_agora timestamptz := now();
begin
  if v_uid is null then raise exception 'Faça login novamente'; end if;
  if not public.eh_membro(p_familia) then raise exception 'Sem acesso a esta família'; end if;
  if v_local = '' then raise exception 'Informe onde você chegou'; end if;
  if char_length(v_local) > 80 then raise exception 'Nome do lugar muito longo'; end if;

  select id into v_id from public.passeios where familia_id = p_familia and user_id = v_uid and voltou_em is null for update;
  if v_id is null then
    insert into public.passeios(familia_id, user_id, iniciado_em) values (p_familia, v_uid, v_agora)
    on conflict (familia_id, user_id) where voltou_em is null do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.passeios where familia_id = p_familia and user_id = v_uid and voltou_em is null for update;
    end if;
  end if;

  -- toque repetido no mesmo lugar em menos de 2 minutos não duplica
  select local, chegou_em into v_ult from public.passeio_paradas where passeio_id = v_id order by chegou_em desc limit 1;
  if found and lower(v_ult.local) = lower(v_local) and v_ult.chegou_em > v_agora - interval '2 minutes' then
    return v_ult.chegou_em;
  end if;

  insert into public.passeio_paradas(passeio_id, familia_id, local, chegou_em) values (v_id, p_familia, v_local, v_agora);
  update public.passeios set alterado_em = v_agora where id = v_id;
  return v_agora;
end $$;

-- registra a volta para casa e encerra o passeio em andamento
create or replace function public.passeio_voltar(p_familia uuid)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid text := auth.user_id(); v_agora timestamptz := now(); v_n int;
begin
  if v_uid is null then raise exception 'Faça login novamente'; end if;
  if not public.eh_membro(p_familia) then raise exception 'Sem acesso a esta família'; end if;
  update public.passeios set voltou_em = v_agora, alterado_em = v_agora
    where familia_id = p_familia and user_id = v_uid and voltou_em is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Você não tem passeio em andamento'; end if;
  return v_agora;
end $$;

-- a marca de versão da família passa a considerar os passeios
create or replace function public.versao_familia(p_familia uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.eh_membro(p_familia) then concat_ws('|',
    (select count(*) || ':' || coalesce(max(alterado_em)::text,'') from public.itens where familia_id = p_familia),
    (select count(*) || ':' || coalesce(max(coalesce(finalizada_em, criado_em))::text,'') from public.listas where familia_id = p_familia),
    (select count(*) from public.catalogo where familia_id = p_familia),
    (select count(*) || ':' || string_agg(nome, ',' order by user_id) from public.membros where familia_id = p_familia),
    (select count(*) || ':' || coalesce(max(alterado_em)::text,'') from public.passeios where familia_id = p_familia)
  ) end;
$$;

-- ---------- permissões do Data API ----------
revoke all on function public.passeio_chegar(uuid,text), public.passeio_voltar(uuid) from public;
revoke all on public.passeios, public.passeio_paradas from anonymous;
grant select on public.passeios, public.passeio_paradas to authenticated;
grant execute on function public.passeio_chegar(uuid,text), public.passeio_voltar(uuid), public.versao_familia(uuid) to authenticated;
