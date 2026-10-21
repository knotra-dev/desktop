import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef } from 'react';
import { DesktopControlError } from '../lib/desktopControl';
import { desktop } from '../lib/native';

interface ControlRequest {
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
}

export function useDesktopControl(
  execute: (
    operation: string,
    args: Record<string, unknown>,
    requestId: string,
  ) => Promise<unknown>,
) {
  const handler = useRef(execute);
  handler.current = execute;
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let release: (() => void)[] = [];
    let queue = Promise.resolve();
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const subscriptions = await Promise.all([
          listen<ControlRequest>('knotra-control-request', ({ payload }) => {
            queue = queue
              .catch(() => {})
              .then(async () => {
                let reply: Record<string, unknown>;
                try {
                  if (disposed)
                    throw new Error('Knotra is closing. Reconnect after opening the app.');
                  reply = {
                    id: payload.id,
                    result: await handler.current(payload.operation, payload.arguments, payload.id),
                  };
                } catch (error) {
                  reply = {
                    id: payload.id,
                    error: {
                      code: error instanceof DesktopControlError ? error.code : 'desktop_control',
                      message:
                        error instanceof Error
                          ? error.message
                          : 'Knotra could not complete this operation.',
                    },
                  };
                }
                await invoke('desktop_control_reply', reply).catch(() => {});
              });
          }),
          listen<{ connectionsChanged?: boolean; engineChanged?: boolean }>(
            'knotra-control-changed',
            ({ payload }) => {
              if (disposed) return;
              if (payload.connectionsChanged)
                window.dispatchEvent(new Event('knotra-connections-changed'));
              if (payload.engineChanged) window.dispatchEvent(new Event('knotra-engine-changed'));
            },
          ),
        ]);
        if (disposed) {
          subscriptions.forEach((unlisten) => {
            unlisten();
          });
          return;
        }
        release = subscriptions;
        await invoke('desktop_control_ready', { ready: true });
      })
      .catch(() => {});
    return () => {
      disposed = true;
      release.forEach((unlisten) => {
        unlisten();
      });
      void invoke('desktop_control_ready', { ready: false }).catch(() => {});
    };
  }, []);
}
