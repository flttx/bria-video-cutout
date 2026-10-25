ALTER TABLE browser_uploads ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE browser_jobs ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
CREATE INDEX browser_upload_device ON browser_uploads(owner,device_id);
CREATE INDEX browser_job_device ON browser_jobs(owner,device_id);
