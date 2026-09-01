import { handleVerification } from './verify_keys.js';
import openai from './openai.mjs';

export async function handleRequest(request) {

  const url = new URL(request.url);
  const pathname = url.pathname;
  const search = url.search;

  if (pathname === '/' || pathname === '/index.html') {
    return new Response('Proxy is Running!  More Details: https://github.com/tech-shrimp/gemini-balance-lite', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  if (pathname === '/verify' && request.method === 'POST') {
    return handleVerification(request);
  }

  // Audio Output (TTS) probe: forwards a canned Audio->Audio test request
  // through the openai handler. Returns 200 with an output_audio part + base64 data,
  // or 4xx/5xx with diagnostic if the model/voices are not available.
  if (pathname === '/verify-audio' && request.method === 'POST') {
    const errHandler = (err) => {
      console.error('[verify-audio] error:', err?.message ?? err);
      const status = err?.status ?? 500;
      const msg = err?.message ?? String(err);
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const fakeReq = new Request(request.url + '/chat/completions', {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify({
        model: 'gemini-2.5-flash-preview-tts',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: "Say 'audio output works' in Mandarin Chinese." }]
        }],
        // FIX 2026-09-01: TTS model (gemini-2.5-flash-preview-tts) only accepts
        // AUDIO modality; requesting both TEXT + AUDIO returns 400 INVALID_ARGUMENT
        // from the upstream Gemini API. See Gemini API docs:
        //   responseModalities: ["AUDIO"] is the only supported combo for TTS models.
        modalities: ['audio'],
        audio: { voice: 'Kore', format: 'wav' },
      }),
    });
    try {
      return await openai.fetch(fakeReq);
    } catch (err) {
      return errHandler(err);
    }
  }

  // 处理OpenAI格式请求
  if (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/completions") || url.pathname.endsWith("/embeddings") || url.pathname.endsWith("/models")) {
    return openai.fetch(request);
  }

  const targetUrl = `https://generativelanguage.googleapis.com${pathname}${search}`;

  try {
    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (key.trim().toLowerCase() === 'x-goog-api-key') {
        const apiKeys = value.split(',').map(k => k.trim()).filter(k => k);
        if (apiKeys.length > 0) {
          const selectedKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
          console.log(`Gemini Selected API Key: ${selectedKey}`);
          headers.set('x-goog-api-key', selectedKey);
        }
      } else {
        if (key.trim().toLowerCase()==='content-type')
        {
           headers.set(key, value);
        }
      }
    }

    console.log('Request Sending to Gemini')
    console.log('targetUrl:'+targetUrl)
    console.log(headers)

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body
    });

    console.log("Call Gemini Success")

    const responseHeaders = new Headers(response.headers);

    console.log('Header from Gemini:')
    console.log(responseHeaders)

    responseHeaders.delete('transfer-encoding');
    responseHeaders.delete('connection');
    responseHeaders.delete('keep-alive');
    responseHeaders.delete('content-encoding');
    responseHeaders.set('Referrer-Policy', 'no-referrer');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });

  } catch (error) {
   console.error('Failed to fetch:', error);
   return new Response('Internal Server Error\n' + error?.stack, {
    status: 500,
    headers: { 'Content-Type': 'text/plain' }
   });
}
};
