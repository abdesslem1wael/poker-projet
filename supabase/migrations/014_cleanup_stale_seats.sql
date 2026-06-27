-- One-time cleanup: mark all active seated/spectating rows as left.
-- Ghost rows accumulate when the server crashes or is restarted mid-session
-- without a graceful shutdown — the socket disconnect handlers never fire, so
-- table_players rows remain 'seated' forever.
--
-- After this migration every player must rejoin, but no ghost players will appear.
-- The application-level fixes in this release prevent the problem from recurring.

UPDATE table_players
SET    status = 'left',
       seat_number = null,
       left_at = now()
WHERE  status != 'left';
