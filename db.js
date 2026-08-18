// db.js
// Central place for the Neon serverless Postgres connection.
// Reads the connection string from process.env.DATABASE_URL only.
// Do NOT hardcode any connection string here.

const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  // Fail fast and loudly at startup if the connection string is missing,
  // rather than failing confusingly on the first query.
  throw new Error(
    'Missing required environment variable: DATABASE_URL. ' +
    'Make sure backend/.env contains DATABASE_URL and that dotenv is loaded before this module.'
  );
}

// `sql` can be used two ways with the installed @neondatabase/serverless version:
//   1. Tagged template:      sql`SELECT * FROM t WHERE id = ${id}`
//   2. Conventional call:    sql.query('SELECT * FROM t WHERE id = $1', [id])
// Calling `sql(...)` directly as a plain function (not a tagged template)
// throws: "This function can now be called only as a tagged-template
// function... use sql.query(...) for a conventional function call."
// We use sql.query(...) throughout server.js so we can build parameterized
// queries dynamically (e.g. for PATCH) without ever interpolating
// user-supplied values into the SQL string.
const sql = neon(process.env.DATABASE_URL);

module.exports = { sql };   