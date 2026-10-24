ALTER TABLE browser_access_grants ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0,1));
CREATE TABLE browser_token_sessions (
  session_hash TEXT PRIMARY KEY,
  grant_hash TEXT NOT NULL REFERENCES browser_access_grants(token_hash) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX browser_token_session_grant ON browser_token_sessions(grant_hash);
CREATE INDEX browser_token_session_expiry ON browser_token_sessions(expires_at);
