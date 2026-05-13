import { createLogger } from './util/logger.js';

const log = createLogger('jira');

export interface JiraIssueInfo {
  status: string | null;
  assignee: string | null;
  title: string | null;
}

export interface JiraAuthBasic {
  type: 'basic';
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraAuthOAuth {
  type: 'oauth';
  cloudId: string;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenExpiry: number;
  onTokenRefresh?: (tokens: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
}

export type JiraAuth = JiraAuthBasic | JiraAuthOAuth;

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com';
const ATLASSIAN_API_URL = 'https://api.atlassian.com';

/**
 * Refresh an OAuth access token using the refresh token.
 */
async function refreshOAuthToken(auth: JiraAuthOAuth): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  try {
    const res = await fetch(`${ATLASSIAN_AUTH_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        refresh_token: auth.refreshToken,
      }),
    });

    if (!res.ok) {
      log.error(`OAuth token refresh failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || auth.refreshToken,
      expiresIn: data.expires_in,
    };
  } catch (err: any) {
    log.error('OAuth token refresh error:', err.message);
    return null;
  }
}

/**
 * Get a valid access token, refreshing if necessary.
 */
async function getValidAccessToken(auth: JiraAuthOAuth): Promise<string | null> {
  // Refresh if token expires within 60 seconds
  if (Date.now() >= auth.tokenExpiry - 60_000) {
    log.info('OAuth token expired or expiring soon, refreshing...');
    const tokens = await refreshOAuthToken(auth);
    if (!tokens) return null;

    auth.accessToken = tokens.accessToken;
    auth.refreshToken = tokens.refreshToken;
    auth.tokenExpiry = Date.now() + tokens.expiresIn * 1000;
    auth.onTokenRefresh?.(tokens);
    return tokens.accessToken;
  }
  return auth.accessToken;
}

/**
 * Build the URL and headers for a JIRA API request depending on auth type.
 */
async function buildRequest(auth: JiraAuth, apiPath: string): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (auth.type === 'basic') {
    const encoded = Buffer.from(`${auth.email}:${auth.apiToken}`).toString('base64');
    return {
      url: `${auth.baseUrl}/rest/api/3/${apiPath}`,
      headers: {
        Authorization: `Basic ${encoded}`,
        Accept: 'application/json',
      },
    };
  }

  // OAuth
  const accessToken = await getValidAccessToken(auth);
  if (!accessToken) return null;

  return {
    url: `${ATLASSIAN_API_URL}/ex/jira/${auth.cloudId}/rest/api/3/${apiPath}`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  };
}

export async function fetchJiraIssue(auth: JiraAuth, issueKey: string): Promise<JiraIssueInfo | null> {
  const req = await buildRequest(auth, `issue/${encodeURIComponent(issueKey)}?fields=status,assignee,summary`);
  if (!req) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(req.url, {
      headers: req.headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      log.error(`JIRA API returned ${res.status} for ${issueKey}`);
      return null;
    }

    const data = await res.json();
    return {
      status: data?.fields?.status?.name ?? null,
      assignee: data?.fields?.assignee?.displayName ?? null,
      title: data?.fields?.summary ?? null,
    };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      log.error(`JIRA API timeout for ${issueKey}`);
    } else {
      log.error(`JIRA API error for ${issueKey}:`, err.message);
    }
    return null;
  }
}

/**
 * Build the Atlassian OAuth authorization URL.
 */
export function buildOAuthAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: 'read:jira-work offline_access',
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `${ATLASSIAN_AUTH_URL}/authorize?${params}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  try {
    const res = await fetch(`${ATLASSIAN_AUTH_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error(`OAuth code exchange failed: ${res.status} ${body}`);
      return null;
    }

    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  } catch (err: any) {
    log.error('OAuth code exchange error:', err.message);
    return null;
  }
}

/**
 * Fetch the cloud ID for the user's Atlassian site.
 */
export async function fetchCloudId(accessToken: string): Promise<{ cloudId: string; baseUrl: string } | null> {
  try {
    const res = await fetch(`${ATLASSIAN_API_URL}/oauth/token/accessible-resources`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      log.error(`Failed to fetch accessible resources: ${res.status}`);
      return null;
    }

    const sites = await res.json();
    if (!Array.isArray(sites) || sites.length === 0) {
      log.error('No accessible Atlassian sites found');
      return null;
    }

    // Use the first site
    return {
      cloudId: sites[0].id,
      baseUrl: sites[0].url,
    };
  } catch (err: any) {
    log.error('Failed to fetch cloud ID:', err.message);
    return null;
  }
}
