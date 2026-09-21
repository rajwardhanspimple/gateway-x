-- ============================================================================
--  OPTIONAL seed — wires up ONE upstream so you can test end to end.
--  Replace the values with the real third-party API you want to resell.
--  Nothing here is fake data for the UI: it only fills the routing table.
--  You can do all of this from the Admin panel instead.
-- ============================================================================

-- 1. the original API you are hiding behind your own gateway
insert into public.upstreams (name, slug, base_url, chat_path, models_path, health_path,
                              auth_scheme, auth_header, priority, timeout_ms, notes)
values ('Primary provider', 'primary',
        'https://api.example-provider.com/v1',   -- <<< the ORIGINAL api base url
        '/chat/completions', '/models', '/models',
        'bearer', 'Authorization', 10, 60000,
        'Replace base_url with the real provider endpoint.')
on conflict (slug) do nothing;

-- 2. the API key that provider gave you (status starts as "unknown" until tested)
insert into public.upstream_keys (upstream_id, label, api_key, weight)
select id, 'primary-key-1', 'PASTE-THE-PROVIDER-API-KEY-HERE', 100
from public.upstreams where slug = 'primary'
on conflict (upstream_id, api_key) do nothing;

-- 3. public alias -> hidden real model id
insert into public.models (public_id, display_name, upstream_id, upstream_model_id,
                           description, context_window, max_output_tokens,
                           price_in_per_m, price_out_per_m, capabilities,
                           status, is_default, sort_order)
select 'rs-core', 'RageStar Core', u.id,
       'the-real-upstream-model-id',              -- <<< never shown to users
       'General purpose routed model.', 128000, 8192,
       0, 0, array['chat','streaming'], 'active', true, 10
from public.upstreams u where u.slug = 'primary'
on conflict (public_id) do nothing;

select 'seed applied' as result;
