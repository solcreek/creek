-- organization/member rows created by the sign-up hook stored createdAt in
-- epoch milliseconds, while Better Auth reads and writes these tables through
-- drizzle's `timestamp` mode (epoch seconds). Normalise the millisecond rows.
-- Seconds today are ~1.7e9 and milliseconds ~1.7e12; 1e11 cleanly separates them.
UPDATE organization SET createdAt = createdAt / 1000 WHERE createdAt > 100000000000;
UPDATE member SET createdAt = createdAt / 1000 WHERE createdAt > 100000000000;
