import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, s as ui } from "../../components/ui";
import { api, ApiError, type RemoteInput } from "../../lib/api";
import { useStore } from "../../lib/store";
import { colors, radius } from "../../lib/theme";

const REFRESH_MS = 700;

/**
 * A live view of the home server's browser on the store's sign-in page. Tap to click, type with the
 * box underneath. You sign in yourself (including any codes the store texts you); the server keeps the
 * session, not your password.
 */
export default function LinkScreen() {
  const insets = useSafeAreaInsets();
  const { store, name } = useLocalSearchParams<{ store: string; name?: string }>();
  const storeName = name ?? store;
  const [view, setView] = useState<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [box, setBox] = useState({ width: 1, height: 1 });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const conn = () => useStore.getState().connection();

  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const uri = await api.linkScreenshot(conn(), store);
        if (live.current) setFrame(uri);
      } catch {
        // The page may be mid-navigation; try again next tick.
      }
      if (live.current) timer = setTimeout(tick, REFRESH_MS);
    };
    // Start showing the page once the server has opened it.
    api
      .linkStart(conn(), store)
      .then(({ view: v }) => {
        if (!live.current) return;
        setView(v);
        void tick();
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't open the store's sign-in page."));
    return () => {
      live.current = false;
      clearTimeout(timer);
    };
  }, [store]);

  async function send(event: RemoteInput) {
    try {
      await api.linkInput(conn(), store, event);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't reach the store page.");
    }
  }

  function tap(e: { nativeEvent: { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number } }) {
    if (!view) return;
    // Where on the picture you tapped (iOS reports locationX/Y; the web build reports offsetX/Y).
    const lx = e.nativeEvent.locationX ?? e.nativeEvent.offsetX;
    const ly = e.nativeEvent.locationY ?? e.nativeEvent.offsetY;
    if (lx == null || ly == null) return;
    // Map the tap from the picture on screen to the browser's own coordinates.
    void send({ type: "click", x: (lx * view.width) / box.width, y: (ly * view.height) / box.height });
  }

  async function typeText() {
    if (!text) return;
    await send({ type: "type", text });
    setText("");
  }

  async function done() {
    setBusy(true);
    try {
      const status = await api.linkDone(conn(), store);
      if (status.signedIn) {
        router.back();
      } else {
        Alert.alert("Not signed in yet", `The ${storeName} site doesn't show you as signed in. Finish signing in, then tap Done again.`);
        await api.linkStart(conn(), store);
      }
    } catch (err) {
      Alert.alert("Couldn't check", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  const onLayout = (e: LayoutChangeEvent) => setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>Cancel</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
          Sign in to {storeName}
        </Text>
        <Pressable accessibilityRole="button" onPress={done} disabled={busy} style={[styles.headerBtn, { alignItems: "flex-end" }]}>
          {busy ? <ActivityIndicator color={colors.accent} /> : <Text style={[styles.headerBtnText, { color: colors.accent, fontWeight: "800" }]}>Done</Text>}
        </Pressable>
      </View>

      <Text style={styles.hint}>Tap the page to click, type below, then tap Done once you're signed in.</Text>

      <View style={{ flex: 1, paddingHorizontal: 12 }}>
        <View style={[styles.screen, view ? { aspectRatio: view.width / view.height } : { flex: 1 }]}>
          {frame && view ? (
            <Pressable accessibilityLabel={`${storeName} sign-in page. Tap to click.`} onPress={tap} onLayout={onLayout} style={StyleSheet.absoluteFill}>
              <Image source={{ uri: frame }} style={StyleSheet.absoluteFill} resizeMode="stretch" />
            </Pressable>
          ) : (
            <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center", gap: 10 }]}>
              {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.accent} />}
            </View>
          )}
        </View>
      </View>

      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) + 4 }]}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            accessibilityLabel="Text to type into the page"
            value={text}
            onChangeText={setText}
            onSubmitEditing={typeText}
            placeholder="Type into the selected field"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={false}
            returnKeyType="send"
            style={[ui.input, { flex: 1 }]}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Type it" onPress={typeText} style={styles.send}>
            <Icon name="arrow-up" color="#FFFFFF" size={20} />
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(
            [
              ["Enter", { type: "key", key: "Enter" }],
              ["Delete", { type: "key", key: "Backspace" }],
              ["Back", { type: "back" }],
              ["Scroll ↓", { type: "scroll", dy: 400 }],
              ["Scroll ↑", { type: "scroll", dy: -400 }],
            ] as Array<[string, RemoteInput]>
          ).map(([label, ev]) => (
            <Pressable key={label} accessibilityRole="button" onPress={() => send(ev)} style={styles.key}>
              <Text style={styles.keyText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingBottom: 8 },
  headerBtn: { width: 70, height: 44, justifyContent: "center" },
  headerBtnText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "700", color: colors.ink },
  hint: { fontSize: 13, color: colors.muted, textAlign: "center", paddingHorizontal: 20, paddingBottom: 8 },
  screen: { width: "100%", maxHeight: "100%", alignSelf: "center", borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  error: { color: colors.danger, fontSize: 14, textAlign: "center", paddingHorizontal: 20 },
  bar: { paddingHorizontal: 12, paddingTop: 10, gap: 8, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line },
  send: { width: 46, height: 46, borderRadius: radius.sm, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  key: { flex: 1, height: 38, borderRadius: radius.sm, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  keyText: { fontSize: 13, fontWeight: "700", color: colors.ink },
});
