import { handleDetectSupplier } from '../src/services/extractHandler.js';

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: `Method ${req.method} not allowed. Send a POST request with { pdfBase64 }.`,
    });
  }

  try {
    let body = req.body;

    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON request payload.',
        });
      }
    } else if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf8'));
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON request payload.',
        });
      }
    } else if (!body && typeof req.on === 'function') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return res.status(400).json({
            success: false,
            error: 'Invalid JSON request payload.',
          });
        }
      }
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    const out = await handleDetectSupplier(body, apiKey);
    return res.status(out.status).json(out.body);
  } catch (err: any) {
    console.error('Vercel detect-supplier handler error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to detect supplier.' });
  }
}
