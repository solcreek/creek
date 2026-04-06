-- Add renderMode and assetCount columns to sandbox table
ALTER TABLE sandbox ADD COLUMN renderMode TEXT NOT NULL DEFAULT 'spa';
ALTER TABLE sandbox ADD COLUMN assetCount INTEGER NOT NULL DEFAULT 0;
