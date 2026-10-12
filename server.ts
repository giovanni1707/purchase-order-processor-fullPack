import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleExtract } from './src/services/extractHandler';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

function getApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.API_KEY;
}

// Extraction endpoint (supports both /api/extract and /extract)
app.post(['/api/extract', '/extract'], async (req, res) => {
  const out = await handleExtract(
    req.body,
    getApiKey(),
    'GEMINI_API_KEY is not configured on the server. Please set GEMINI_API_KEY.',
  );
  res.status(out.status).json(out.body);
});

// Vite or static serving
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

// Start dev server unless in serverless context
if (!process.env.VERCEL) {
  startServer();
}

export default app;
