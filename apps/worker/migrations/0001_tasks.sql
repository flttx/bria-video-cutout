CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  file_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  fingerprint TEXT NOT NULL,
  params_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitting','processing','completed','failed','rejected','uncertain')),
  request_id TEXT,
  status_json TEXT,
  error_code TEXT,
  http_status INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  poll_token TEXT,
  poll_failures INTEGER NOT NULL DEFAULT 0
);
