-- the 7-day delivery log cleanup runs every minute; without this it scans the whole table
CREATE INDEX deliveries_at ON deliveries (at);
