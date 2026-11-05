-- Up Migration
CREATE TABLE invoices (
    id uuid PRIMARY KEY,
    status text NOT NULL CHECK (
        status IN ('running', 'pending_review', 'approved', 'rejected', 'done', 'failed')
    ),
    run_id uuid NOT NULL UNIQUE,
    thread_id text NOT NULL UNIQUE,
    pdf_path text NOT NULL,
    extracted jsonb NULL,
    failed_rules jsonb NULL,
    final jsonb NULL,
    decision text NULL CHECK (decision IN ('approve', 'edit', 'reject')),
    override boolean NULL,
    note text NULL,
    decided_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invoices_created ON invoices (created_at);

ALTER TABLE runs DROP CONSTRAINT runs_status_check;

ALTER TABLE runs ADD CONSTRAINT runs_status_check
    CHECK (status IN ('running', 'pending_review', 'done', 'failed'));

ALTER TABLE runs ADD CONSTRAINT runs_extraction_invoice
    CHECK (kind <> 'extraction' OR invoice_id IS NOT NULL);

ALTER TABLE runs ADD CONSTRAINT runs_invoice_id_key UNIQUE (invoice_id);

ALTER TABLE runs ADD CONSTRAINT runs_id_invoice_id_key UNIQUE (id, invoice_id);

ALTER TABLE runs ADD CONSTRAINT runs_invoice_id_fkey
    FOREIGN KEY (invoice_id) REFERENCES invoices (id);

-- The invoice row is inserted before its run, so this side is checked at commit.
ALTER TABLE invoices ADD CONSTRAINT invoices_run_id_fkey
    FOREIGN KEY (run_id, id) REFERENCES runs (id, invoice_id)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE run_events DROP CONSTRAINT run_events_type_check;

ALTER TABLE run_events ADD CONSTRAINT run_events_type_check
    CHECK (type IN ('step_started', 'step_finished', 'interrupt', 'final', 'error'));

-- Down Migration
ALTER TABLE run_events DROP CONSTRAINT run_events_type_check;

ALTER TABLE run_events ADD CONSTRAINT run_events_type_check
    CHECK (type IN ('step_started', 'step_finished', 'final', 'error'));

ALTER TABLE invoices DROP CONSTRAINT invoices_run_id_fkey;
ALTER TABLE runs DROP CONSTRAINT runs_invoice_id_fkey;
ALTER TABLE runs DROP CONSTRAINT runs_id_invoice_id_key;
ALTER TABLE runs DROP CONSTRAINT runs_invoice_id_key;
ALTER TABLE runs DROP CONSTRAINT runs_extraction_invoice;
ALTER TABLE runs DROP CONSTRAINT runs_status_check;

ALTER TABLE runs ADD CONSTRAINT runs_status_check
    CHECK (status IN ('running', 'done', 'failed'));

DROP TABLE invoices;
