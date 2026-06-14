-- Narrow public metadata reader for monthly category share pages.

CREATE FUNCTION community.read_public_monthly_category_share_metadata(
  p_public_token TEXT
)
RETURNS TABLE(
  indexing_enabled BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, community
AS $$
BEGIN
  IF p_public_token IS NULL OR btrim(p_public_token) = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT share.indexing_enabled
  FROM community.monthly_category_share_keys AS key
  INNER JOIN community.monthly_category_shares AS share
    ON share.share_id = key.share_id
  WHERE key.public_token = p_public_token
    AND key.revoked_at IS NULL
    AND share.enabled = true
    AND share.blocked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION community.read_public_monthly_category_share_metadata(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION community.read_public_monthly_category_share_metadata(TEXT) FROM api_sql_executor;
GRANT EXECUTE ON FUNCTION community.read_public_monthly_category_share_metadata(TEXT) TO app;
