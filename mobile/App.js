import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { WebView } from 'react-native-webview';

/** Live DSP site (no backend required for pitch). Override with EXPO_PUBLIC_APP_URL. */
const APP_URL =
  process.env.EXPO_PUBLIC_APP_URL?.trim() || 'https://badlovoice.vercel.app';
const SOURCE = { uri: APP_URL };

// scheme://host[:port] of the site. Nothing else may load in the WebView, so
// nothing else can reach the microphone or hand files to this app.
const APP_ORIGIN = (APP_URL.match(/^https?:\/\/[^/?#]+/i) || [''])[0].toLowerCase();

function isAppUrl(url) {
  const text = String(url);
  if (!APP_ORIGIN || !text.toLowerCase().startsWith(APP_ORIGIN)) return false;
  // The origin must end here: rejects app.example.evil.com, user@host and other ports.
  const next = text[APP_ORIGIN.length];
  return next === undefined || next === '/' || next === '?' || next === '#';
}

// A finished take arrives from the page as base64 parts (frontend/src/lib/saveRecording.js).
const PART_CHARS = 512 * 1024; // one 384 KB part, base64 encoded
const MAX_PARTS = 1400; // about 512 MB of audio

export default function App() {
  const [session, setSession] = useState(0); // bump to load the site afresh
  const [error, setError] = useState(null);
  const take = useRef(null); // { file, next } while a take is arriving

  const reload = useCallback(() => {
    setError(null);
    setSession((n) => n + 1);
  }, []);

  // The WebView cannot download a blob: link, and Android WebView has no Web
  // Share API, so the page posts the take here and we open the share sheet.
  const onMessage = useCallback(async ({ nativeEvent }) => {
    if (!isAppUrl(nativeEvent.url)) return;
    let message;
    try {
      message = JSON.parse(nativeEvent.data);
    } catch {
      return;
    }
    if (message?.type !== 'badlovoice-take') return;

    const { part, parts, data } = message;
    try {
      if (
        !Number.isInteger(part) ||
        !Number.isInteger(parts) ||
        parts < 1 ||
        parts > MAX_PARTS ||
        typeof data !== 'string' ||
        data.length > PART_CHARS
      ) {
        throw new Error('unexpected data from the page');
      }
      if (part === 0) {
        // One take on disk at a time; the file name is chosen here, not by the page.
        const folder = new Directory(Paths.cache, 'takes');
        if (folder.exists) folder.delete();
        folder.create();
        const file = new File(folder, `badlovoice-${Date.now()}.wav`);
        file.create();
        take.current = { file, next: 0 };
      }
      const current = take.current;
      if (!current || part !== current.next) throw new Error('the take arrived out of order');
      current.file.write(data, { encoding: 'base64', append: part > 0 });
      current.next += 1;
      if (current.next === parts) {
        take.current = null;
        await Sharing.shareAsync(current.file.uri, { mimeType: 'audio/wav' });
      }
    } catch (err) {
      take.current = null;
      setError(`Could not share the recording: ${err?.message || err}`);
    }
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.brand}>BadloVoice</Text>
        <Text style={styles.sub} numberOfLines={1}>
          Expo · {APP_URL.replace(/^https?:\/\//, '')}
        </Text>
        <Pressable style={styles.reload} onPress={reload}>
          <Text style={styles.reloadText}>Reload</Text>
        </Pressable>
      </View>

      {error && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      )}

      <WebView
        key={session}
        source={SOURCE}
        style={styles.web}
        containerStyle={styles.webWrap}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.cover}>
            <ActivityIndicator size="large" color="#e05528" />
          </View>
        )}
        renderError={(_domain, _code, description) => (
          <View style={styles.cover}>
            <Text style={styles.coverTitle}>Can't reach BadloVoice</Text>
            <Text style={styles.hint}>Check your internet connection, then try again.</Text>
            {description ? <Text style={styles.hint}>{description}</Text> : null}
            <Pressable style={styles.reload} onPress={reload}>
              <Text style={styles.reloadText}>Try again</Text>
            </Pressable>
          </View>
        )}
        onHttpError={({ nativeEvent }) =>
          setError(`The site answered with an error (${nativeEvent.statusCode}).`)
        }
        // A WebView whose process was killed stays blank until it is rebuilt.
        onRenderProcessGone={reload}
        onContentProcessDidTerminate={reload}
        // Other sites open in the browser; the exact check also stops look-alike hosts.
        originWhitelist={[APP_ORIGIN]}
        onShouldStartLoadWithRequest={(request) =>
          request.isTopFrame === false || isAppUrl(request.url)
        }
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        setSupportMultipleWindows={false}
        // The WebView asks for the microphone when the page does (Android: system
        // dialog; iOS: system dialog, then granted to our own host only).
        mediaCapturePermissionGrantType="grantIfSameHostElseDeny"
        applicationNameForUserAgent="BadloVoiceExpo"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#efe4d4',
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight || 0 : 0,
  },
  header: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(42,35,28,0.14)',
    backgroundColor: '#f7f0e6',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brand: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2a231c',
  },
  sub: {
    flex: 1,
    fontSize: 11,
    color: 'rgba(42,35,28,0.55)',
  },
  reload: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(224,85,40,0.45)',
    backgroundColor: 'rgba(224,85,40,0.12)',
  },
  reloadText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#c4471f',
  },
  banner: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: 'rgba(224,85,40,0.12)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(224,85,40,0.35)',
  },
  bannerText: {
    fontSize: 12,
    color: '#2a231c',
  },
  webWrap: {
    flex: 1,
    backgroundColor: '#efe4d4',
  },
  web: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  cover: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: '#efe4d4',
  },
  coverTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#2a231c',
  },
  hint: {
    fontSize: 13,
    textAlign: 'center',
    color: 'rgba(42,35,28,0.55)',
  },
});
