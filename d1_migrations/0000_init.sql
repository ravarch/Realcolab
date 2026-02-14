CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  source_url TEXT,
  created_at INTEGER,
  metadata TEXT
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT,
  chunk_index INTEGER,
  content TEXT
);
CREATE INDEX idx_chunks_doc ON chunks(document_id);
