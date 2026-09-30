-- 01_setup.sql — Supabase SQL Editor, проект zvzeyplkanvaazjhxcbv. Повторный запуск безопасен.
-- Ничего не удаляет и не перезаписывает существующие данные.
create extension if not exists btree_gist;

-- 1. Общая функция версии: updated_at меняется при каждом UPDATE (основа контроля конфликтов)
create or replace function public.tablo_touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := clock_timestamp(); return new; end $$;

-- 2. Существующие таблицы: новые поля
alter table public.zoom_resources add column if not exists join_url text;
alter table public.zoom_resources add column if not exists updated_at timestamptz not null default now();
alter table public.bookings add column if not exists course_id text;
alter table public.bookings add column if not exists updated_at timestamptz not null default now();

-- 3. Новые таблицы
create table if not exists public.tablo_categories (
  id text primary key, name text not null check (length(btrim(name)) > 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.tablo_courses (
  id text primary key, title text not null check (length(btrim(title)) > 0),
  category_id text not null references public.tablo_categories(id) on delete restrict,
  url text not null check (url ~* '^https?://'),
  sort_order int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists tablo_courses_category_idx on public.tablo_courses(category_id);
create table if not exists public.tablo_settings (
  key text primary key, value jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

-- 4. Связь занятие → курс: удаление курса только очищает связь
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_course_id_fkey') then
    alter table public.bookings add constraint bookings_course_id_fkey
      foreign key (course_id) references public.tablo_courses(id) on delete set null;
  end if;
end $$;

-- 5. Триггеры версии
do $$ declare t text; begin
  foreach t in array array['bookings','zoom_resources','tablo_categories','tablo_courses','tablo_settings'] loop
    if not exists (select 1 from pg_trigger where tgname = t || '_touch' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before update on public.%I for each row execute function public.tablo_touch_updated_at()', t || '_touch', t);
    end if;
  end loop;
end $$;

-- 6. Пересечения Zoom: отчёт вместо автоудаления
create or replace view public.tablo_booking_overlaps with (security_invoker = true) as
select a.id as booking_a, b.id as booking_b, a.zoom_resource_id, a.title as title_a, b.title as title_b,
       a.start_date as start_a, a.end_date as end_a, b.start_date as start_b, b.end_date as end_b
from public.bookings a join public.bookings b
  on a.zoom_resource_id = b.zoom_resource_id and a.id < b.id
 and daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
where a.zoom_resource_id is not null;

-- Ограничение на сервере (обе границы включены). Если оно уже есть — не трогаем;
-- если в данных есть пересечения — не создаём, а сообщаем (см. select * from tablo_booking_overlaps).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_no_overlap' and conrelid = 'public.bookings'::regclass) then
    if exists (select 1 from public.tablo_booking_overlaps) then
      raise warning 'Есть пересекающиеся бронирования: ограничение не создано. Выполните: select * from public.tablo_booking_overlaps;';
    else
      alter table public.bookings add constraint bookings_no_overlap exclude using gist
        (zoom_resource_id with =, daterange(start_date, end_date, '[]') with &&)
        where (zoom_resource_id is not null);
    end if;
  end if;
end $$;

-- 7. Права и RLS (только таблицы платформы; свободный гостевой доступ — выбранная модель)
do $$ declare t text; op text; begin
  foreach t in array array['bookings','zoom_resources','tablo_categories','tablo_courses','tablo_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
    foreach op in array array['select','insert','update','delete'] loop
      if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname='tablo_guest_'||op) then
        execute format('create policy %I on public.%I for %s to anon, authenticated %s',
          'tablo_guest_'||op, t, op,
          case op when 'select' then 'using (true)' when 'insert' then 'with check (true)'
                  when 'update' then 'using (true) with check (true)' else 'using (true)' end);
      end if;
    end loop;
  end loop;
end $$;
grant select on public.tablo_booking_overlaps to anon, authenticated;

-- 8. Realtime (INSERT/UPDATE/DELETE)
do $$ declare t text; begin
  foreach t in array array['bookings','zoom_resources','tablo_categories','tablo_courses','tablo_settings'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
