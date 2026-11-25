-- Conteggio esatto delle righe di ogni tabella public (output: "tabella|righe", ordinato).
-- Usato dal workflow di backup per confrontare sorgente e restore. Non stampa dati.
do $$
declare t record; n bigint;
begin
  create temp table if not exists _row_counts (tbl text primary key, n bigint);
  truncate _row_counts;
  for t in select tablename from pg_tables where schemaname = 'public' order by tablename loop
    execute format('select count(*) from public.%I', t.tablename) into n;
    insert into _row_counts values (t.tablename, n);
  end loop;
end $$;
select tbl || '|' || n from _row_counts order by tbl;
