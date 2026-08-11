-- Shared approval workflow v2: add the Rework/Reassign state to the status enum.
-- Its own migration so the value is committed before any later migration/runtime uses it.
alter type public.sd_status add value if not exists 'rework';
