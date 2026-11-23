-- Fresh-install defaults: UTC weekly digest (editable in Settings -> Reports) and neutral email channel label.
UPDATE reports SET timezone = 'UTC'
WHERE id = 'weekly-digest' AND created_by = 'migration' AND last_sent_at IS NULL;

UPDATE notification_channels SET name = 'Alert email' WHERE id = 'email-owner' AND name = 'Email to the owner';
