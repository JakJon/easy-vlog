// CORS proxy for Google Photos Picker API media downloads.
//
// The Picker API serves photo bytes from lh3.googleusercontent.com (which sends
// proper CORS headers) but videos are 302-redirected to video-downloads.
// googleusercontent.com, whose responses lack Access-Control-Allow-Origin.
// Browsers block reading the body from a cross-origin response without that
// header, so we proxy through this Edge Function:
//
//   client → /api/photos-proxy?url=<google url> (with Authorization header)
//     → fetches Google server-side (no CORS rules apply on a server fetch)
//     → streams the body back to the client with proper CORS headers.
//
// The function is whitelist-locked to *.googleusercontent.com to prevent it
// from being abused as an open proxy.

const ALLOWED_HOST_SUFFIXES = ['.googleusercontent.com']

export default async (req: Request): Promise<Response> => {
  // Allow CORS preflight from any origin.
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders() })
  }

  const url = new URL(req.url)
  const target = url.searchParams.get('url')
  if (!target) {
    return new Response('Missing ?url=', { status: 400, headers: corsHeaders() })
  }

  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return new Response('Invalid url', { status: 400, headers: corsHeaders() })
  }

  if (parsed.protocol !== 'https:') {
    return new Response('Only https targets allowed', { status: 400, headers: corsHeaders() })
  }
  const hostOk = ALLOWED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix))
  if (!hostOk) {
    return new Response('Target host not allowed', { status: 403, headers: corsHeaders() })
  }

  const auth = req.headers.get('authorization')
  if (!auth) {
    return new Response('Missing Authorization', { status: 401, headers: corsHeaders() })
  }

  // Fetch upstream. Edge runtime fetch follows redirects automatically, so the
  // lh3 → video-downloads hop happens here transparently.
  const upstream = await fetch(parsed.toString(), {
    headers: { Authorization: auth },
    redirect: 'follow',
  })

  // Forward status + relevant headers, override CORS so the browser accepts it.
  const headers = corsHeaders()
  const contentType = upstream.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) headers.set('Content-Length', contentLength)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

function corsHeaders(): Headers {
  const h = new Headers()
  h.set('Access-Control-Allow-Origin', '*')
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  h.set('Access-Control-Max-Age', '86400')
  return h
}
