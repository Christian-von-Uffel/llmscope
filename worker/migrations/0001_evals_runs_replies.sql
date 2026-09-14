-- llmscope's registry: evals (the recipe, content-addressed), runs (one generation of replies, under a minted
-- id) and replies (one row each). Every id is the same six characters the CLI files things under in evals/
-- and out/, so `llmscope.dev/e/<id>` and `out/<id>.results.json` name the same run.
--
-- A run's JSON is kept whole across two tables — runs.meta is everything but the replies, replies.body is one
-- reply each — so reading a run back is one parse per row and no field is lost however the record grows. The
-- typed columns beside them are the ones worth asking the database about.

CREATE TABLE evals (
  id         TEXT PRIMARY KEY,   -- content-addressed: the same spec always files here, however often it is run
  spec       TEXT NOT NULL,      -- the normalized spec, JSON
  prompt     TEXT NOT NULL,      -- the first prompt with its slots spelled out, the way the card titles it
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,                    -- minted when the run started; never reused
  eval_id     TEXT NOT NULL REFERENCES evals(id),
  owner       TEXT NOT NULL,                       -- sha-256 of the token that saved it; only that token may replace or remove it
  provider    TEXT NOT NULL,
  measure     TEXT NOT NULL,                       -- refusal | keyword | sentiment
  prompt      TEXT NOT NULL,
  models      INTEGER NOT NULL,
  replies     INTEGER NOT NULL,
  cost_usd    REAL,
  finished_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  meta        TEXT NOT NULL                        -- the run record without its results, JSON
);
CREATE INDEX runs_by_eval ON runs (eval_id, finished_at DESC);
CREATE INDEX runs_by_owner ON runs (owner, finished_at DESC);

CREATE TABLE replies (
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,                      -- its place in the run's results array
  model     TEXT NOT NULL,
  variant   TEXT NOT NULL,                         -- the slot values this reply was asked with
  repeat    INTEGER NOT NULL,                      -- which of the eval's runs per cell this was
  refused   INTEGER,                               -- 1, 0, or NULL when unscored
  matched   INTEGER,
  sentiment REAL,
  error     TEXT,
  tokens    INTEGER,
  cost_usd  REAL,
  body      TEXT NOT NULL,                         -- the whole reply, JSON
  PRIMARY KEY (run_id, idx)
);
CREATE INDEX replies_by_model ON replies (model, refused);
