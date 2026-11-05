-- Up Migration
CREATE TABLE runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('qa', 'extraction')),
    thread_id text NOT NULL,
    conversation_id uuid NULL,
    invoice_id uuid NULL,
    question text NULL,
    status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    profile text NOT NULL,
    models text[] NOT NULL DEFAULT '{}',
    tokens_in integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
    tokens_out integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
    cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    latency_ms integer NULL CHECK (latency_ms >= 0),
    path text[] NOT NULL DEFAULT '{}',
    error text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz NULL,
    CHECK (kind <> 'qa' OR (conversation_id IS NOT NULL AND question IS NOT NULL))
);

CREATE UNIQUE INDEX runs_one_running_per_conversation ON runs (conversation_id)
    WHERE status = 'running';

CREATE INDEX runs_conversation_created ON runs (conversation_id, created_at);

CREATE TABLE run_events (
    run_id uuid NOT NULL REFERENCES runs (id),
    seq integer NOT NULL CHECK (seq >= 1),
    type text NOT NULL
        CHECK (type IN ('step_started', 'step_finished', 'final', 'error')),
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
);

-- Down Migration
DROP TABLE run_events;
DROP TABLE runs;
