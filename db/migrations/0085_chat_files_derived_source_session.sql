-- Keep a derivative inside the session of the file it was derived from.
--
-- Migration 0083 ties origin = 'derived' to the presence of source_file_id, and
-- points source_file_id at chat_files(file_id) alone. That names a row, not a
-- row of this session, and foreign key validation runs as the table owner and
-- bypasses row-level security - so the only thing standing between a derivative
-- and a source in another session was application code. The policy of 0083 does
-- not close it either: it checks the row's OWN session against the caller, and a
-- user's two sessions of one workspace both pass that check. A derivative could
-- therefore sit in session A describing bytes of session B, where the manifest
-- of A names a path whose content A never held and deleting B silently removes a
-- file of A.
--
-- The fix is the composite foreign key, which needs a UNIQUE on exactly the
-- referenced pair. (session_id, file_id) is already unique, because file_id is
-- the primary key; the constraint is added for the foreign key to reference, not
-- for a uniqueness this table lacked.
--
-- Purely additive. The single-column foreign key of 0083 stays: its guarantee is
-- implied by the one added here, so it constrains nothing new, and dropping it
-- would mean naming a constraint PostgreSQL generated rather than one this
-- repository chose. The second ON DELETE CASCADE path it keeps deletes exactly
-- the rows the new one does.

SET LOCAL lock_timeout = '30s';

-- Derivatives have never been written: this migration ships with the first
-- layer that writes them. Prove that before the foreign key validation scan
-- does, so an escaped row is reported as itself rather than as a bare foreign
-- key violation naming no session.
DO $$
DECLARE
  v_escaped RECORD;
BEGIN
  SELECT
    derivative.file_id,
    derivative.session_id,
    source.session_id AS source_session_id
    INTO v_escaped
    FROM public.chat_files AS derivative
    JOIN public.chat_files AS source
      ON source.file_id = derivative.source_file_id
    WHERE derivative.session_id IS DISTINCT FROM source.session_id
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'chat_files derivative session invariant failed: file % of session % names a source in session %',
      v_escaped.file_id,
      v_escaped.session_id,
      v_escaped.source_session_id;
  END IF;
END;
$$;

ALTER TABLE public.chat_files
  ADD CONSTRAINT chat_files_session_id_file_id_key
  UNIQUE (session_id, file_id);

-- Validated rather than NOT VALID: the check above proved every stored row
-- satisfies it right now, so the scan has nothing to find.
ALTER TABLE public.chat_files
  ADD CONSTRAINT chat_files_source_file_session_fkey
  FOREIGN KEY (session_id, source_file_id)
  REFERENCES public.chat_files (session_id, file_id)
  ON DELETE CASCADE;

-- Supports the cascade scan of the foreign key above. The 0083 index on
-- source_file_id alone serves the single-column foreign key that stays; this
-- one is the pair that cascade actually searches on.
CREATE INDEX chat_files_session_id_source_file_id_idx
  ON public.chat_files (session_id, source_file_id);

-- Verify before commit, so a shape that silently failed to constrain anything
-- cannot be recorded as applied.
DO $$
DECLARE
  v_fk_columns TEXT[];
  v_fk_referenced_columns TEXT[];
  v_fk_delete_action "char";
  v_fk_validated BOOLEAN;
  v_unique_validated BOOLEAN;
BEGIN
  SELECT constraint_record.convalidated
    INTO v_unique_validated
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.chat_files'::regclass
      AND constraint_record.conname = 'chat_files_session_id_file_id_key'
      AND constraint_record.contype = 'u';

  IF NOT FOUND OR NOT v_unique_validated THEN
    RAISE EXCEPTION
      'chat_files derivative session invariant failed: chat_files_session_id_file_id_key must exist as a validated unique constraint';
  END IF;

  SELECT
    constraint_record.convalidated,
    constraint_record.confdeltype,
    ARRAY(
      SELECT attribute.attname::TEXT
      FROM pg_catalog.unnest(constraint_record.conkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_record.conrelid
        AND attribute.attnum = key.attnum
      ORDER BY key.position
    ),
    ARRAY(
      SELECT attribute.attname::TEXT
      FROM pg_catalog.unnest(constraint_record.confkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_record.confrelid
        AND attribute.attnum = key.attnum
      ORDER BY key.position
    )
    INTO v_fk_validated, v_fk_delete_action, v_fk_columns, v_fk_referenced_columns
    FROM pg_catalog.pg_constraint AS constraint_record
    WHERE constraint_record.conrelid = 'public.chat_files'::regclass
      AND constraint_record.conname = 'chat_files_source_file_session_fkey'
      AND constraint_record.contype = 'f';

  IF NOT FOUND
    OR NOT v_fk_validated
    -- 'c' is ON DELETE CASCADE. A derivative outliving its source would name an
    -- object the session no longer holds.
    OR v_fk_delete_action <> 'c'
    OR v_fk_columns IS DISTINCT FROM ARRAY['session_id', 'source_file_id']::TEXT[]
    OR v_fk_referenced_columns IS DISTINCT FROM ARRAY['session_id', 'file_id']::TEXT[]
  THEN
    RAISE EXCEPTION
      'chat_files derivative session invariant failed: chat_files_source_file_session_fkey must be a validated ON DELETE CASCADE foreign key from % to %, found % to % with delete action %',
      ARRAY['session_id', 'source_file_id']::TEXT[],
      ARRAY['session_id', 'file_id']::TEXT[],
      v_fk_columns,
      v_fk_referenced_columns,
      v_fk_delete_action;
  END IF;
END;
$$;

SET LOCAL lock_timeout = '0';
