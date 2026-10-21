import { expect, it, vi } from 'vitest';
import { connectEngine, disconnectEngine, engineCache, engineCall } from '../src/lib/engine/client';

it('reads bounded instance pages with an encoded cursor without caching the collection', async () => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  });
  let invalid = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) => {
      if (url.pathname === '/v1/info')
        return Response.json({
          protocol: 'knotra.desktop/1',
          engineId: 'pages',
          principalId: 'local',
          version: '1',
          capabilities: [],
        });

      expect(url.pathname).toBe('/v1/runs/run%2F1/instances');
      expect(url.searchParams.get('cursor')).toBe('map[1]/child');

      return Response.json({
        items: [
          {
            id: 'map[2]/child',
            nodeId: 'child',
            scope: 'pipeline.yaml',
            status: invalid ? 'unknown' : 'succeeded',
          },
        ],
        nextCursor: null,
      });
    }),
  );
  try {
    await connectEngine('http://localhost:8080');
    const page = await engineCall<{ items: { id: string }[] }>({
      op: 'instances',
      runId: 'run/1',
      cursor: 'map[1]/child',
    });

    expect(page.items[0].id).toBe('map[2]/child');
    expect((await engineCache()).cache).toEqual({});
    invalid = true;
    await expect(
      engineCall({ op: 'instances', runId: 'run/1', cursor: 'map[1]/child' }),
    ).rejects.toThrow('invalid Instance');
  } finally {
    await disconnectEngine();
    vi.unstubAllGlobals();
  }
});
