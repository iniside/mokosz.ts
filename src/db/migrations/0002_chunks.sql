-- Up Migration
CREATE TABLE chunks (
    id bigserial PRIMARY KEY,
    celex text NOT NULL,
    act text NOT NULL,
    lang text NOT NULL CHECK (lang IN ('en', 'pl')),
    element_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('paragraph', 'point', 'recital', 'annex')),
    article integer NULL,
    heading text NULL,
    text text NOT NULL,
    embedding vector(1024) NOT NULL,
    UNIQUE (celex, element_id, lang)
);

-- Down Migration
DROP TABLE chunks;
