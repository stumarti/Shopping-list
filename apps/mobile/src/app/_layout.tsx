import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, View } from "react-native";
import { useStore } from "../lib/store";
import { colors } from "../lib/theme";

const POLL_MS = 15_000;

/** Load the Keychain token, then pull your partner's changes while the app is open and push queued ones. */
function useSession() {
  useEffect(() => {
    const sync = () => void useStore.getState().sync();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      sync();
      timer ??= setInterval(sync, POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    // Wait for the persisted list to load before the first sync, so queued ops aren't lost.
    const boot = () => void useStore.getState().loadSession().then(start);
    const unsubHydrate = useStore.persist.onFinishHydration(boot);
    if (useStore.persist.hasHydrated()) boot();
    const sub = AppState.addEventListener("change", (state) => (state === "active" ? start() : stop()));
    return () => {
      stop();
      sub.remove();
      unsubHydrate();
    };
  }, []);
}

export default function RootLayout() {
  useSession();
  // Screens call the API as soon as they mount, so hold them until the Keychain token is in memory.
  const ready = useStore((st) => st.tokenLoaded);
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.ground }} />;
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ground } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="welcome" options={{ gestureEnabled: false }} />
        <Stack.Screen name="scan" options={{ presentation: "fullScreenModal", contentStyle: { backgroundColor: colors.camera } }} />
        <Stack.Screen name="photo" options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="item/[id]" options={{ presentation: "modal" }} />
        <Stack.Screen name="lists" options={{ presentation: "modal" }} />
        <Stack.Screen name="history" />
        <Stack.Screen name="prices" />
        <Stack.Screen name="online" />
        <Stack.Screen name="link/[store]" options={{ presentation: "fullScreenModal", gestureEnabled: false }} />
        <Stack.Screen name="order/[id]" />
        <Stack.Screen name="aisles" />
        <Stack.Screen name="settings" />
      </Stack>
    </>
  );
}
