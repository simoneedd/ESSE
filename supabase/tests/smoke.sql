-- Smoke test post-migrazione/post-restore (Personal OS): RLS, privilegi, isolamento tra utenti.
do $$
declare n integer; a uuid := 'aaaaaaaa-0000-4000-8000-0000000000aa'; b uuid := 'bbbbbbbb-0000-4000-8000-0000000000bb'; c uuid;
begin
  if exists (select 1 from pg_class cl join pg_namespace ns on ns.oid = cl.relnamespace
             where ns.nspname = 'public' and cl.relkind = 'r' and not (cl.relrowsecurity and cl.relforcerowsecurity)) then
    raise exception 'Tabella senza RLS forzata';
  end if;
  if (select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public') > 0 then
    raise exception 'Privilegi anon presenti';
  end if;
  if (select count(*) from pg_tables where schemaname = 'public') < 39 then
    raise exception 'Numero tabelle inatteso: %', (select count(*) from pg_tables where schemaname = 'public');
  end if;
  -- isolamento: B non vede i clienti di A
  perform set_config('request.jwt.claim.sub', a::text, true);
  set local role authenticated;
  insert into public.clients (name) values ('Smoke A') returning id into c;
  perform set_config('request.jwt.claim.sub', b::text, true);
  select count(*) into n from public.clients where id = c;
  if n <> 0 then raise exception 'Isolamento tra utenti violato'; end if;
  reset role;
  delete from public.clients where id = c;
end $$;
select 'smoke ok';
