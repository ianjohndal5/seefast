const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = process.env.PORT || 4000;

app.get('/orders', async (req, res) => {
  jwt.verify(req.headers.authorization, process.env.JWT_SECRET);
  const { rows } = await pool.query('select * from orders');
  res.json(rows);
});

app.listen(port, () => console.log(`listening on ${port}`));
