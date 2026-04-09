// src/middleware/dashboard.js
// Serves the built React dashboard from the same Express server
// After running `npm run build` in /dashboard, the built files go to /dashboard/build
// This middleware serves them at the root URL

const path = require('path');
const express = require('express');

function serveDashboard(app) {
  const buildPath = path.join(__dirname, '../../dashboard/build');

  // Try to serve the dashboard — gracefully skip if not built yet
  try {
    const fs = require('fs');
    if (fs.existsSync(buildPath)) {
      app.use(express.static(buildPath));
      app.get('/', (req, res) => {
        res.sendFile(path.join(buildPath, 'index.html'));
      });
      console.log('[Server] Dashboard: serving from /dashboard/build');
    } else {
      app.get('/', (req, res) => {
        res.json({
          message: 'LinkedIn Nurture System API',
          dashboard: 'Not built yet — run: cd dashboard && npm install && npm run build',
          api: '/api/',
          health: '/health',
          webhook: '/webhook/heyreach'
        });
      });
      console.log('[Server] Dashboard: not built (run npm run build in /dashboard)');
    }
  } catch (err) {
    console.warn('[Server] Dashboard serve error:', err.message);
  }
}

module.exports = { serveDashboard };
