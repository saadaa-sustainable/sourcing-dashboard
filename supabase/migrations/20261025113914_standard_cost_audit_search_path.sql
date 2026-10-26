-- Audit helper has no relation lookups; prevent mutable search-path resolution.
alter function public.sd_cost_event_immutable() set search_path = '';
