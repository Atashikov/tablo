-- 03_atomic_apply.sql — выполнить в SQL Editor ПОСЛЕ 01_setup.sql (02_seed.sql уже выполнен). Повторный запуск безопасен.
-- Одна серверная функция для атомарных операций: импорт файла и сохранение списка Zoom ID.
-- Все изменения выполняются в одной транзакции: применяются либо все, либо ни одно.
-- Каждая операция несёт «ожидаемую версию» строки (updated_at, которую видел пользователь; null — строки не было).
-- Если на сервере версия другая (строку изменили, создали или удалили после снимка) — вся операция отклоняется.
--
-- ops: [{"table":"bookings","op":"upsert|delete","id":"...","expected":"<updated_at>"|null,"row":{...}}, ...]
create or replace function public.tablo_apply_changes(ops jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  o jsonb; t text; pk text; rid text; exp text; kind text; cur timestamptz;
  bad text[] := '{}'; r jsonb; cols text; sets text; affected bigint; n_up int := 0; n_del int := 0;
  allowed constant text[] := array['bookings','zoom_resources','tablo_categories','tablo_courses','tablo_settings'];
begin
  if ops is null or jsonb_typeof(ops) <> 'array' then
    raise exception 'ops must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(ops) > 5000 then
    raise exception 'too many operations' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(ops) as item
    group by item->>'table', item->>'id' having count(*) > 1
  ) then
    raise exception 'duplicate operations for the same record' using errcode = '22023';
  end if;

  -- Проход 1: проверка версий с блокировкой строк (for update): параллельные правки дождутся конца транзакции.
  for o in select * from jsonb_array_elements(ops) loop
    t := o->>'table'; kind := o->>'op'; rid := o->>'id'; exp := o->>'expected';
    if t is null or t <> all (allowed) then raise exception 'unknown table %', t using errcode = '22023'; end if;
    if kind is null or kind not in ('upsert','delete') or rid is null or rid = '' then raise exception 'bad operation' using errcode = '22023'; end if;
    pk := case when t = 'tablo_settings' then 'key' else 'id' end;
    cur := null;
    execute format('select updated_at from public.%I where %I::text = $1 for update', t, pk) into cur using rid;
    if kind = 'delete' then
      if cur is not null and (exp is null or cur <> exp::timestamptz) then bad := bad || (t || ':' || rid); end if;
      -- строка уже удалена кем-то другим: удалять нечего, это не конфликт
    elsif cur is null then
      if exp is not null then bad := bad || (t || ':' || rid); end if;   -- ожидалась существующая строка, её удалили
    elsif exp is null or cur <> exp::timestamptz then
      bad := bad || (t || ':' || rid);                                   -- строка изменена или создана после снимка
    end if;
  end loop;
  if coalesce(array_length(bad, 1), 0) > 0 then
    raise exception 'TABLO_CONFLICT' using errcode = 'TB409',
      detail = array_to_string(bad[1:20], ', '), hint = array_length(bad, 1)::text;
  end if;

  -- Проход 2: применение.
  for o in select * from jsonb_array_elements(ops) loop
    t := o->>'table'; kind := o->>'op'; rid := o->>'id'; exp := o->>'expected';
    pk := case when t = 'tablo_settings' then 'key' else 'id' end;
    if kind = 'delete' then
      -- Не удаляем запись, созданную после первого прохода с тем же ID.
      execute format('delete from public.%I where %I::text = $1 and updated_at = $2::timestamptz', t, pk) using rid, exp;
      get diagnostics affected = row_count;
      n_del := n_del + affected;
    else
      r := coalesce(o->'row', '{}'::jsonb) - 'created_at' - 'updated_at';   -- служебные поля ставит сервер
      r := jsonb_set(r, array[pk], to_jsonb(rid));
      select string_agg(format('%I', k), ','), string_agg(format('%I = excluded.%I', k, k), ',') filter (where k <> pk)
        into cols, sets from jsonb_object_keys(r) as k;
      if exp is null then
        -- Ожидалась новая запись. Обычный INSERT защищает и отсутствие строки:
        -- если её успели создать после проверки, уникальный ключ отклонит всю транзакцию.
        execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
          t, cols, cols, t) using r;
      else
        execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) where true on conflict (%I) do %s',
          t, cols, cols, t, pk, case when sets is null then 'nothing' else 'update set ' || sets end) using r;
      end if;
      n_up := n_up + 1;
    end if;
  end loop;
  return jsonb_build_object('upserts', n_up, 'deletes', n_del);
end $$;

revoke all on function public.tablo_apply_changes(jsonb) from public;
grant execute on function public.tablo_apply_changes(jsonb) to anon, authenticated;
