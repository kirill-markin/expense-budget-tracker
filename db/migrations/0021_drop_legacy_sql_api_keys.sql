DROP TRIGGER IF EXISTS trg_revoke_api_keys_on_member_removal ON public.workspace_members;

DROP FUNCTION IF EXISTS public.on_workspace_member_removed_api_keys();
DROP FUNCTION IF EXISTS public.validate_api_key(TEXT);

DROP TABLE IF EXISTS public.api_keys;
