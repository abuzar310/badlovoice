import { useCallback, useEffect, useState } from 'react';
import useServerStatus from './useServerStatus';

/**
 * A list of named settings (presets or profiles) that works with and without
 * the server. With a server, items are saved there. Without one they are saved
 * in this browser. Both sets are shown, so nothing saved offline disappears
 * once a server turns up.
 *
 * `local`  — a store from lib/savedSettings.js
 * `remote` — { list(), save(name, settings), remove(id) } calling the API
 */
export default function useSavedItems(local, remote) {
  const { online } = useServerStatus();
  const [onServer, setOnServer] = useState([]);
  const [onDevice, setOnDevice] = useState(local.list);
  const [loadError, setLoadError] = useState(null);

  const reload = useCallback(async () => {
    try {
      const items = await remote.list();
      setOnServer(Array.isArray(items) ? items : []);
      setLoadError(null);
    } catch (err) {
      // No server is a normal state here, not an error to show.
      setLoadError(err.offline ? null : err.message);
    }
  }, [remote]);

  useEffect(() => {
    if (online) reload();
  }, [online, reload]);

  /** Resolves to { item, where: 'server' | 'device' }. Throws with a message to show. */
  const save = useCallback(
    async (name, settings) => {
      if (online) {
        try {
          const item = await remote.save(name, settings);
          await reload();
          return { item, where: 'server' };
        } catch (err) {
          // The server went away mid-click: keep the settings here instead.
          if (!err.offline) throw err;
        }
      }
      const item = local.save(name, settings);
      setOnDevice(local.list());
      return { item, where: 'device' };
    },
    [online, local, remote, reload]
  );

  const remove = useCallback(
    async (item) => {
      if (item.local) {
        local.remove(item.id);
        setOnDevice(local.list());
      } else {
        await remote.remove(item.id);
        await reload();
      }
    },
    [local, remote, reload]
  );

  return { items: [...onServer, ...onDevice], save, remove, loadError, reload };
}
