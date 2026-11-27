import { useCallback, useState, useSyncExternalStore } from 'react';
import { checkServer, getServerState, subscribeServerState } from '../lib/api';

/**
 * Whether the desktop server is there. Panels that need it read this instead
 * of each discovering it through a failed request.
 *
 * `state` is 'checking' | 'online' | 'unreachable' | 'none' (see lib/api.js).
 * `recheck()` asks again right now; `rechecking` is true while it does.
 */
export default function useServerStatus() {
  const state = useSyncExternalStore(subscribeServerState, getServerState);
  const [rechecking, setRechecking] = useState(false);

  const recheck = useCallback(async () => {
    setRechecking(true);
    try {
      return await checkServer();
    } finally {
      setRechecking(false);
    }
  }, []);

  return {
    state,
    online: state === 'online',
    offline: state === 'none' || state === 'unreachable',
    recheck,
    rechecking,
  };
}
