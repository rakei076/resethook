-- Mark retracted events once, when the retraction is stored, instead of searching for a retraction on every read.
ALTER TABLE events ADD COLUMN retracted INTEGER NOT NULL DEFAULT 0;

UPDATE events SET retracted = 1
WHERE stage != 'retracted'
  AND EXISTS (SELECT 1 FROM events r WHERE r.stage = 'retracted' AND r.product = events.product AND r.post_id = events.post_id);

CREATE INDEX events_product_post ON events (product, post_id);
CREATE INDEX events_live ON events (product, retracted, stage, posted_at DESC);
CREATE INDEX events_live_any ON events (retracted, posted_at DESC);
CREATE INDEX events_posted ON events (posted_at DESC);

-- the database sets the flag, so no write path can forget it
CREATE TRIGGER events_retract AFTER INSERT ON events WHEN NEW.stage = 'retracted'
BEGIN
  UPDATE events SET retracted = 1 WHERE product = NEW.product AND post_id = NEW.post_id AND stage != 'retracted';
END;

CREATE TRIGGER events_born_retracted AFTER INSERT ON events WHEN NEW.stage != 'retracted'
  AND EXISTS (SELECT 1 FROM events r WHERE r.stage = 'retracted' AND r.product = NEW.product AND r.post_id = NEW.post_id)
BEGIN
  UPDATE events SET retracted = 1 WHERE id = NEW.id;
END;
