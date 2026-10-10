import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useStore } from "../lib/store";
import { colors } from "../lib/theme";

const POLL_MS = 15_000;

/** Pull your partner's changes while the app is open; push queued changes whenever we can. */
function useBackgroundSync() {
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
    const unsubHydrate = useStore.persist.onFinishHydration(start);
    if (useStore.persist.hasHydrated()) start();
    const sub = AppState.addEventListener("change", (state) => (state === "active" ? start() : stop()));
    return () => {
      stop();
      sub.remove();
      unsubHydrate();
    };
  }, []);
}

export default function RootLayout() {
  useBackgroundSync();
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ground } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="scan" options={{ presentation: "fullScreenModal", contentStyle: { backgroundColor: colors.camera } }} />
        <Stack.Screen name="photo" options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="item/[id]" options={{ presentation: "modal" }} />
        <Stack.Screen name="aisles" />
        <Stack.Screen name="settings" />
      </Stack>
    </>
  );
}
