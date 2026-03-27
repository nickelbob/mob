import { createLogger } from './util/logger.js';

const log = createLogger('jira');

export async function fetchJiraStatus(
  baseUrl: string,
  email: string,
  apiToken: string,
  issueKey: string,
): Promise<string | null> {
  const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      log.error(`JIRA API returned ${res.status} for ${issueKey}`);
      return null;
    }

    const data = await res.json();
    return data?.fields?.status?.name ?? null;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      log.error(`JIRA API timeout for ${issueKey}`);
    } else {
      log.error(`JIRA API error for ${issueKey}:`, err.message);
    }
    return null;
  }
}
