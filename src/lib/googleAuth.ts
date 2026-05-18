// Thin wrapper around Google Identity Services (loaded from accounts.google.com/gsi/client
// via index.html). Handles obtaining an OAuth 2.0 access token via the implicit
// flow — no backend, no client secret, just a popup. The token lasts ~1 hour
// which is plenty for one picker + stitch round trip.

const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'

interface GisTokenResponse {
  access_token?: string
  error?: string
  error_description?: string
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void
}

interface GisOAuth2 {
  initTokenClient: (config: {
    client_id: string
    scope: string
    callback: (response: GisTokenResponse) => void
    error_callback?: (err: { type: string; message?: string }) => void
  }) => GisTokenClient
}

interface GoogleAccountsNamespace {
  oauth2: GisOAuth2
}

interface GoogleNamespace {
  accounts: GoogleAccountsNamespace
}

declare global {
  interface Window {
    google?: GoogleNamespace
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null

function getClientId(): string {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
  if (!id) {
    throw new Error(
      'VITE_GOOGLE_CLIENT_ID is not set. Copy .env.example to .env.local and ' +
        'fill in the OAuth Client ID from Google Cloud Console.',
    )
  }
  return id
}

async function waitForGis(timeoutMs = 8_000): Promise<GoogleNamespace> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
      return window.google
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(
    'Google Identity Services script did not load. Check your network or that ' +
      '<script src="https://accounts.google.com/gsi/client"> is in index.html.',
  )
}

// Kick off GIS load as soon as this module is imported. By the time the user
// clicks the sign-in button, gisLoaded is almost always set, which lets us
// call requestAccessToken synchronously inside the click gesture — critical
// for iOS Safari, which blocks popups opened after any microtask yield.
let gisPromise: Promise<GoogleNamespace> | null = null
let gisLoaded: GoogleNamespace | null = null
function ensureGisLoading(): Promise<GoogleNamespace> {
  if (!gisPromise) {
    gisPromise = waitForGis()
    gisPromise.then((g) => { gisLoaded = g }).catch(() => {})
  }
  return gisPromise
}
if (typeof window !== 'undefined') {
  ensureGisLoading().catch(() => {})
}

// Request a fresh access token, opening Google's sign-in popup. Resolves with
// the token string. Rejects if the user cancels or denies the scope.
export async function getAccessToken(forceConsent = false): Promise<string> {
  if (!forceConsent && cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value
  }

  const clientId = getClientId()
  // Prefer the synchronously-available reference. Awaiting here would cross a
  // microtask boundary and kill the iOS user-gesture context — so the OAuth
  // popup would never open.
  const gis = gisLoaded ?? await ensureGisLoading()

  return await new Promise<string>((resolve, reject) => {
    const tokenClient = gis.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (response) => {
        if (response.error) {
          reject(new Error(`OAuth error: ${response.error_description ?? response.error}`))
          return
        }
        const token = response.access_token
        if (!token) {
          reject(new Error('OAuth response missing access_token'))
          return
        }
        // Google access tokens default to 3600s; cache for slightly less.
        cachedToken = { value: token, expiresAt: Date.now() + 50 * 60 * 1000 }
        resolve(token)
      },
      error_callback: (err) => {
        reject(new Error(`OAuth error: ${err.message ?? err.type}`))
      },
    })
    tokenClient.requestAccessToken({ prompt: forceConsent ? 'consent' : '' })
  })
}

export function clearCachedToken(): void {
  cachedToken = null
}
