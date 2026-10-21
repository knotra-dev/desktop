import { useEffect, useMemo, useState } from 'react';
import { engineCall, engineError } from '../../../lib/engine/client';
import { mergeEvents, observationWindow } from '../../../lib/engine/observation';
import type { EngineEvent, Page } from '../../../lib/engine/types';

export function useInstanceHistory(
  runId: string,
  id: string | undefined,
  events: EngineEvent[],
  connected: boolean,
) {
  const [history, setHistory] = useState<EngineEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyLimited, setHistoryLimited] = useState(false);

  useEffect(() => {
    if (!id || !connected) return;

    let active = true;
    setLoading(true);
    void (async () => {
      let next: string | null = null;
      let loaded: EngineEvent[] = [];
      try {
        // Retrieve ordinary runs completely; larger histories remain explicitly paginated.
        for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
          const page: Page<EngineEvent> = await engineCall({
            op: 'history',
            runId,
            instanceId: id,
            cursor: next,
          });
          if (!active) return;

          loaded = mergeEvents(loaded, page.items);
          next = page.nextCursor;
          setHistory((current) => observationWindow(mergeEvents(current, page.items)));
          setCursor(next);
          setHistoryError('');
          if (!next || loaded.length >= 4000 || JSON.stringify(loaded).length > 3 * 1024 * 1024)
            break;
        }
      } catch (error) {
        if (active) setHistoryError(engineError(error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [id, runId, connected]);

  useEffect(() => {
    if (!id) return;

    const incoming = events.filter((event) => event.instanceId === id);
    if (!incoming.length) return;

    setHistory((current) => {
      const merged = mergeEvents(current, incoming);
      const bounded = observationWindow(merged);
      if (bounded.length !== merged.length) setHistoryLimited(true);
      return bounded;
    });
  }, [events, id]);

  async function loadMore() {
    if (!id || !cursor || loading) return;

    setLoading(true);

    try {
      const page = await engineCall<Page<EngineEvent>>({
        op: 'history',
        runId,
        instanceId: id,
        cursor,
      });
      setHistory((current) => {
        const merged = mergeEvents(current, page.items);
        const bounded = observationWindow(merged);
        if (bounded.length !== merged.length) setHistoryLimited(true);
        return bounded;
      });
      setCursor(page.nextCursor);
      setHistoryError('');
    } catch (error) {
      setHistoryError(engineError(error).message);
    } finally {
      setLoading(false);
    }
  }

  const ownEvents = useMemo(
    () =>
      mergeEvents(
        history,
        events.filter((event) => id && event.instanceId === id),
      ),
    [history, events, id],
  );

  return { ownEvents, cursor, loading, historyError, historyLimited, loadMore };
}
