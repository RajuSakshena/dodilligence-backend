// server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { sql } = require('./db');

const app = express();
app.use(express.json());

// -----------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------
// Allow local Vite dev origins out of the box. Add your production
// frontend URL here (or via the ALLOWED_ORIGINS env var, comma-separated)
// once it's known, e.g.:
//   ALLOWED_ORIGINS=https://myapp.com,https://www.myapp.com
const defaultOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];
const envOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = [...defaultOrigins, ...envOrigins];

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser requests (no Origin header, e.g. curl/Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
  })
);

// -----------------------------------------------------------------------
// Constants: the ONLY table and ONLY columns the backend is allowed to touch
// -----------------------------------------------------------------------
const TABLE = 'assessment_submissions';

// Columns a client is allowed to write via PATCH.
// id, created_at, updated_at are intentionally excluded.
const PATCHABLE_COLUMNS = new Set([
  'org_name',
  'registration_type',
  'primary_role',
  'state',
  'city',
  'year_established',
  'email',
  'contact_details',
  'foreign_funds',
  'confidentiality_accepted',
  'answers',
  'current_section_index',
  'completed_sections',
  'overall_score',
  'tier',
  'parameter_scores',
  'red_flags',
  'csr_ineligible',
  'gift_email',
  'gift_role',
  'connect_slot',
  'connect_agenda',
  'connect_share_report',
  'shared_with_email',
]);

// Columns stored as JSONB — values must be JSON-stringified before being
// sent as a query parameter, and the placeholder must be cast to ::jsonb.
const JSONB_COLUMNS = new Set([
  'answers',
  'completed_sections',
  'parameter_scores',
  'red_flags',
]);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value) {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

// -----------------------------------------------------------------------
// ⚠️  ADMIN ROUTES HAVE NO AUTHENTICATION — TEMPORARY / DEV-ONLY  ⚠️
// -----------------------------------------------------------------------
// At the caller's explicit request, requireAdminAuth and all Basic Auth
// logic have been removed. GET/DELETE /api/admin/submissions and
// GET /management.html below are reachable by ANYONE who knows (or
// guesses) the URL — no username, password, token, or session required.
//
// Concretely, that means:
//   - Every field of every submission (org name, email, contact details,
//     foreign-funding info, etc.) is publicly readable.
//   - Anyone can permanently delete any or all submissions.
//
// This should not be exposed on a public Render URL without re-adding
// some form of access control first (Basic Auth, a shared-secret header,
// IP allowlisting, etc.).
// -----------------------------------------------------------------------
// -----------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------

// Simple health check — handy for confirming the server + DB are up,
// and useful once deployed on Render.
app.get('/api/health', async (req, res) => {
  try {
    await sql.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Health check DB error:', err.message);
    res.status(500).json({ status: 'error', error: 'Database unreachable' });
  }
});

// ---- 1. POST /api/submissions -----------------------------------------
// Creates exactly ONE new row. Used only by the Profile step.
app.post('/api/submissions', async (req, res) => {
  try {
    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }

    const {
      org_name,
      registration_type,
      primary_role,
      state,
      city,
      year_established,
      email,
      contact_details,
      foreign_funds,
      confidentiality_accepted,
    } = body;

    const id = crypto.randomUUID();

    const rows = await sql.query(
      `INSERT INTO ${TABLE} (
         id,
         org_name,
         registration_type,
         primary_role,
         state,
         city,
         year_established,
         email,
         contact_details,
         foreign_funds,
         confidentiality_accepted,
         created_at,
         updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
       RETURNING id`,
      [
        id,
        org_name ?? null,
        registration_type ?? null,
        primary_role ?? null,
        state ?? null,
        city ?? null,
        year_established ?? null,
        email ?? null,
        contact_details ?? null,
        foreign_funds ?? null,
        confidentiality_accepted ?? null,
      ]
    );

    return res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('POST /api/submissions error:', err.message);
    return res.status(500).json({ error: 'Failed to create submission.' });
  }
});

// ---- 2. PATCH /api/submissions/:id -------------------------------------
// Dynamically updates only the allowed columns present in the body.
app.patch('/api/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid submission id (must be a UUID).' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Request body must be a JSON object.' });
    }

    // Only keep keys that are real, patchable columns.
    const keys = Object.keys(body).filter((key) => PATCHABLE_COLUMNS.has(key));

    if (keys.length === 0) {
      return res.status(400).json({
        error: 'No valid fields to update were provided.',
        allowedFields: Array.from(PATCHABLE_COLUMNS),
      });
    }

    // Build "column = $n" pieces and the matching parameter list.
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const key of keys) {
      let value = body[key];

      if (JSONB_COLUMNS.has(key)) {
        setClauses.push(`${key} = $${paramIndex}::jsonb`);
        values.push(JSON.stringify(value ?? null));
      } else {
        setClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
      }
      paramIndex += 1;
    }

    // Always bump updated_at.
    setClauses.push('updated_at = now()');

    // Final parameter is the id, used in the WHERE clause.
    values.push(id);
    const idParamIndex = paramIndex;

    const query = `
      UPDATE ${TABLE}
      SET ${setClauses.join(', ')}
      WHERE id = $${idParamIndex}
      RETURNING *
    `;

    const rows = await sql.query(query, values);

    if (rows.length === 0) {
      return res.status(404).json({ error: `No submission found with id ${id}.` });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/submissions/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to update submission.' });
  }
});

// ---- 3. GET /api/submissions/:id ---------------------------------------
app.get('/api/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid submission id (must be a UUID).' });
    }

    const rows = await sql.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: `No submission found with id ${id}.` });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/submissions/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch submission.' });
  }
});

// -----------------------------------------------------------------------
// Admin routes — NO authentication (see warning above).
// These are the only routes allowed to return every column/row, and the
// only routes allowed to delete a submission. They still only ever touch
// the single assessment_submissions table, using parameterised SQL, and
// never accept a table or column name from the client.
// -----------------------------------------------------------------------

// ---- GET /api/admin/submissions ----------------------------------------
// Returns every column for every row, newest first. PUBLIC — no auth.
app.get('/api/admin/submissions', async (req, res) => {
  try {
    const rows = await sql.query(
      `SELECT * FROM ${TABLE} ORDER BY created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    console.error('GET /api/admin/submissions error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch submissions.' });
  }
});

// ---- DELETE /api/admin/submissions/:id ----------------------------------
// Permanently deletes one row by UUID. PUBLIC — no auth.
app.delete('/api/admin/submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidUUID(id)) {
      return res.status(400).json({ error: 'Invalid submission id (must be a UUID).' });
    }

    const rows = await sql.query(
      `DELETE FROM ${TABLE} WHERE id = $1 RETURNING id`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: `No submission found with id ${id}.` });
    }

    return res.json({ success: true, deletedId: rows[0].id });
  } catch (err) {
    console.error('DELETE /api/admin/submissions/:id error:', err.message);
    return res.status(500).json({ error: 'Failed to delete submission.' });
  }
});

// ---- GET /management.html -----------------------------------------------
// The admin dashboard itself. PUBLIC — no auth. Anyone with this URL can
// view and delete every submission.
app.get('/management.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'management.html'));
});

// -----------------------------------------------------------------------
// 404 fallback for unknown routes
// -----------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// -----------------------------------------------------------------------
// Central error handler (e.g. CORS rejection, malformed JSON body)
// -----------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body.' });
  }

  return res.status(500).json({ error: 'Internal server error.' });
});

// -----------------------------------------------------------------------
// Start server
// -----------------------------------------------------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server listening on port ${PORT}`);
});
