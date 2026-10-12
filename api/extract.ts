import { handleExtract } from '../src/services/extractHandler.js';

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req: any, res: any) {
  // CORS headers
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

    // Handle string or buffer bodies if Vercel did not auto-parse JSON
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
      // Fallback: read incoming stream if body was not consumed
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
    const out = await handleExtract(
      body,
      apiKey,
      'GEMINI_API_KEY is not configured in Vercel. Please add GEMINI_API_KEY to your Vercel Project Settings > Environment Variables, and redeploy.',
    );
    return res.status(out.status).json(out.body);
  } catch (err: any) {
    console.error('Vercel extract handler error:', err);
    return res.status(500).json({ success: false, error: err?.message || 'Failed to extract quotation data.' });
  }
}
