import { Tool } from '../types';

const SEARCH_ENDPOINT = 'https://api.firecrawl.dev/v2/search';

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web and get results with titles, URLs, and descriptions',
  parameters: {
    query: {
      type: 'string',
      description: 'The search query',
      required: true,
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results to return (default: 5, max: 10)',
      required: false,
    },
  },
  async execute(params: Record<string, any>) {
    const { query, limit = 5 } = params;

    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('query must be a non-empty string');
    }

    const apiKey = process.env.FIRECRAWL_API_KEY;

    let response: Response;
    try {
      response = await fetch(SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          query,
          limit: Math.min(Math.max(Number(limit) || 5, 1), 10),
        }),
      });
    } catch (error) {
      throw new Error(
        `Failed to reach Firecrawl: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Firecrawl API error ${response.status} ${response.statusText}. ${body.slice(0, 500)}`,
      );
    }

    const data = await response.json();

    if (!data?.success || !Array.isArray(data.data?.web)) {
      throw new Error('Firecrawl returned an unexpected response shape');
    }

    const results = data.data.web.map((item: any) => ({
      title: item.title,
      url: item.url,
      description: item.description,
      position: item.position,
    }));

    return {
      query,
      count: results.length,
      results,
    };
  },
};