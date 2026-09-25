-- Step 4: forward-looking weather hazards, scored by growth stage.
--
-- The four weather types are namespaced `weather_*` so the existing partial
-- unique index keeps doing its job: one open alert per (farm, type), which
-- means a heat warning and a frost warning can coexist while a second heat
-- warning cannot pile up on the first.
alter table public.alerts drop constraint if exists alerts_type_check;

alter table public.alerts
  add constraint alerts_type_check
  check (type in ('drought', 'low_yield',
                  'weather_heat', 'weather_frost', 'weather_rain', 'weather_wind'));
