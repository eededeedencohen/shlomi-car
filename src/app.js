import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';

import authRoutes from './routes/authRoutes.js';
import bootstrapRoutes from './routes/bootstrapRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import serviceRoutes from './routes/serviceRoutes.js';
import templateRoutes from './routes/templateRoutes.js';
import bundleRoutes from './routes/bundleRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import searchRoutes from './routes/searchRoutes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** CLIENT_ORIGIN = comma separated list of allowed browser origins; empty = allow any origin. */
const allowedOrigins = String(process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Minimal hardening headers (no helmet dependency).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
// gzip: the bootstrap payload (the whole working set) shrinks about six times
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// PUBLIC health check (no auth)
app.get('/api/health', (req, res) => {
  res.json({ success: true, service: 'shlomi-garage-api', time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/bootstrap', bootstrapRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/bundles', bundleRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/search', searchRoutes);

// Production: serve the client build from Server/public with an SPA fallback for non-API GETs.
const publicDir = path.resolve(__dirname, '../public');
const indexHtml = path.join(publicDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  // Hashed bundles under /assets are immutable and can be cached for a year. index.html and every other
  // unhashed file must be revalidated on each load, so phones pick up a new build right after a deploy.
  const assetsDir = path.join(publicDir, 'assets') + path.sep;
  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders: (res, filePath) => {
        const immutable = filePath.startsWith(assetsDir);
        res.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    })
  );
  // The page carries link-preview tags (WhatsApp / Facebook) whose image address must be absolute:
  // __APP_URL__ in index.html becomes PUBLIC_URL (set it on Render) or, failing that, the request's own origin.
  const indexTemplate = fs.readFileSync(indexHtml, 'utf8');
  const publicUrlOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.set('Cache-Control', 'no-cache');
    return res.type('html').send(indexTemplate.replaceAll('__APP_URL__', publicUrlOf(req)));
  });
}

app.use(notFound);
app.use(errorHandler);

export default app;
