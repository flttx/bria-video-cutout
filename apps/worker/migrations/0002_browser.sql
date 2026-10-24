CREATE TABLE browser_uploads (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  size INTEGER NOT NULL,
  multipart_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'uploading',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE browser_parts (
  upload_id TEXT NOT NULL REFERENCES browser_uploads(id),
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY(upload_id,part_number)
);
CREATE TABLE browser_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL);
CREATE INDEX browser_uploads_expiry ON browser_uploads(expires_at);
