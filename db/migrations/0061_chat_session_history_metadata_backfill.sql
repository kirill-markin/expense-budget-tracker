-- Backfill chat history metadata while keeping chat reads available.

SET LOCAL lock_timeout = '30s';

-- Live chat transactions lock their session before writing chat items. An
-- EXCLUSIVE session lock waits for those transactions and prevents new writers
-- while remaining compatible with ordinary SELECT reads.
LOCK TABLE public.chat_sessions IN EXCLUSIVE MODE;

-- Block direct item writes after the session writer gate is established.
-- SHARE remains compatible with ordinary SELECT reads.
LOCK TABLE public.chat_items IN SHARE MODE;

SELECT pg_catalog.set_config(
  'app.chat_session_history_metadata_backfill',
  'enabled',
  true
);

WITH first_user_messages AS (
  SELECT DISTINCT ON (item.session_id)
    item.session_id,
    item.payload
  FROM public.chat_items AS item
  WHERE item.item_kind = 'message'
    AND item.payload ->> 'role' = 'user'
  ORDER BY item.session_id, item.item_order
),
derived_titles AS (
  SELECT
    first_message.session_id,
    LEFT(
      COALESCE(message_text.title, attachment.title),
      200
    ) AS title
  FROM first_user_messages AS first_message
  LEFT JOIN LATERAL (
    SELECT NULLIF(
      btrim(
        regexp_replace(
          pg_catalog.string_agg(
            content_part.value ->> 'text',
            ''
            ORDER BY content_part.ordinality
          ),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ),
      ''
    ) AS title
    FROM jsonb_array_elements(first_message.payload -> 'content')
      WITH ORDINALITY AS content_part(value, ordinality)
    WHERE content_part.value ->> 'type' = 'text'
  ) AS message_text
    ON true
  LEFT JOIN LATERAL (
    SELECT normalized_attachment.title
    FROM (
      SELECT
        attachment_part.ordinality,
        NULLIF(
          btrim(
            regexp_replace(
              attachment_part.value ->> 'fileName',
              '[[:space:]]+',
              ' ',
              'g'
            )
          ),
          ''
        ) AS title
      FROM jsonb_array_elements(first_message.payload -> 'content')
        WITH ORDINALITY AS attachment_part(value, ordinality)
      WHERE attachment_part.value ->> 'type' = 'file'
    ) AS normalized_attachment
    WHERE normalized_attachment.title IS NOT NULL
    ORDER BY normalized_attachment.ordinality
    LIMIT 1
  ) AS attachment
    ON true
),
message_activity AS (
  SELECT
    item.session_id,
    MAX(GREATEST(item.created_at, item.updated_at)) AS last_message_at
  FROM public.chat_items AS item
  WHERE item.item_kind = 'message'
  GROUP BY item.session_id
),
session_metadata AS (
  SELECT
    title.session_id,
    title.title,
    activity.last_message_at
  FROM derived_titles AS title
  JOIN message_activity AS activity
    ON activity.session_id = title.session_id
)
UPDATE public.chat_sessions AS session
SET
  title = metadata.title,
  last_message_at = metadata.last_message_at
FROM session_metadata AS metadata
WHERE session.session_id = metadata.session_id;
