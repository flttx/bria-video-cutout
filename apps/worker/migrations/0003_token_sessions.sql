CREATE TABLE browser_access_grants (
  token_hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  session_hash TEXT,
  session_expires_at INTEGER
);
CREATE UNIQUE INDEX browser_access_session ON browser_access_grants(session_hash);
