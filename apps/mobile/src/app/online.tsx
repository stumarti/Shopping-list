import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon } from "../components/ui";
import { api, ApiError, ConflictError, type OnlineStore, type Order, type Slot } from "../lib/api";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

interface StoreState {
  store: OnlineStore;
  loading: boolean;
  signedIn?: boolean;
  slot?: Slot | null;
  error?: string;
}

/** Shop online: compare prices, link store accounts, check the slot, start an order. */
export default function OnlineScreen() {
  const insets = useSafeAreaInsets();
  const listId = useStore((st) => st.currentListId);
  const left = useStore((st) => st.items.filter((i) => i.listId === st.currentListId && !i.done).length);
  const [stores, setStores] = useState<StoreState[] | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [resume, setResume] = useState<Order | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const conn = () => useStore.getState().connection();

  const checkStore = useCallback(async (store: OnlineStore) => {
    setStores((all) => all?.map((s) => (s.store.id === store.id ? { ...s, loading: true, error: undefined } : s)) ?? null);
    try {
      const status = await api.onlineStatus(conn(), store.id);
      setStores((all) => all?.map((s) => (s.store.id === store.id ? { ...s, loading: false, ...status } : s)) ?? null);
    } catch (err) {
      const error = err instanceof ApiError ? err.message : "Couldn't check this store.";
      setStores((all) => all?.map((s) => (s.store.id === store.id ? { ...s, loading: false, error } : s)) ?? null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      api
        .onlineStores(conn())
        .then(({ stores: list }) => {
          if (!live) return;
          setStores(list.map((store) => ({ store, loading: store.ordering })));
          list.filter((s) => s.ordering).forEach((s) => void checkStore(s));
        })
        .catch((err) => live && setUnavailable(err instanceof ApiError ? err.message : "Couldn't reach the home server."));
      api
        .latestOrder(conn(), listId)
        .then(({ order }) => live && setResume(order && ["matching", "review", "filling"].includes(order.status) ? order : null))
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [listId, checkStore]),
  );

  async function start(store: OnlineStore) {
    setStarting(store.id);
    try {
      await useStore.getState().sync();
      const { id } = await api.startOrder(conn(), listId, store.id);
      router.push({ pathname: "/order/[id]", params: { id } });
    } catch (err) {
      if (err instanceof ConflictError && err.code === "not_linked") router.push({ pathname: "/link/[store]", params: { store: store.id, name: store.name } });
      else Alert.alert("Can't start the order", err instanceof ApiError ? err.message : "Try again in a moment.");
      void checkStore(store);
    } finally {
      setStarting(null);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.ground }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Icon name="chevron-back" />
          <Text style={styles.backText}>List</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Shop online
        </Text>
        <Text style={styles.sub}>
          Fill your Tesco or Dunnes basket from this list ({left} item{left === 1 ? "" : "s"}), then check out in the store's app.
        </Text>
      </View>

      {resume ? (
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/order/[id]", params: { id: resume.id } })} style={styles.resume}>
          <Icon name="cart" color="#FFFFFF" size={20} />
          <Text style={styles.resumeText}>Continue your {resume.store === "test" ? "test" : resume.store === "tesco" ? "Tesco" : "Dunnes"} order</Text>
          <Icon name="chevron-forward" color="#FFFFFF" size={18} />
        </Pressable>
      ) : null}

      <Pressable accessibilityRole="button" onPress={() => router.push("/prices")} style={styles.compare}>
        <Icon name="pricetags-outline" color={colors.accent} size={20} />
        <View style={{ flex: 1 }}>
          <Text style={styles.compareTitle}>Compare prices first</Text>
          <Text style={styles.small}>See which store is cheaper for this list</Text>
        </View>
        <Icon name="chevron-forward" color={colors.muted} size={18} />
      </Pressable>

      {unavailable ? (
        <View style={styles.warn}>
          <Text style={styles.warnText}>{unavailable}</Text>
        </View>
      ) : null}
      {!stores && !unavailable ? <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} /> : null}

      {stores?.map(({ store, loading, signedIn, slot, error }) => (
        <Card key={store.id} style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={[styles.storeName, { flex: 1 }]}>{store.name}</Text>
            {loading ? <ActivityIndicator color={colors.accent} /> : null}
          </View>

          {!store.ordering ? (
            <Text style={styles.small}>Online ordering for {store.name} isn't set up yet. Price comparison still works.</Text>
          ) : error ? (
            <>
              <Text style={[styles.small, { color: colors.danger }]}>{error}</Text>
              <Button label="Try again" variant="secondary" onPress={() => checkStore(store)} />
            </>
          ) : loading ? (
            <Text style={styles.small}>Checking your account…</Text>
          ) : !signedIn ? (
            <>
              <Text style={styles.small}>Sign in to your {store.name} account once so the app can fill your basket.</Text>
              <Button label={`Link ${store.name} account`} icon="link-outline" onPress={() => router.push({ pathname: "/link/[store]", params: { store: store.id, name: store.name } })} />
            </>
          ) : !slot ? (
            <>
              <View style={styles.step}>
                <Icon name="checkmark-circle" color={colors.accent} size={18} />
                <Text style={styles.stepText}>Account linked</Text>
              </View>
              <View style={styles.step}>
                <Icon name="time-outline" color="#C2571A" size={18} />
                <Text style={styles.stepText}>No slot booked. Book a delivery or click & collect slot in the {store.name} app, then check again.</Text>
              </View>
              <Button label="Check again" variant="secondary" icon="refresh" onPress={() => checkStore(store)} />
            </>
          ) : (
            <>
              <View style={styles.step}>
                <Icon name="checkmark-circle" color={colors.accent} size={18} />
                <Text style={styles.stepText}>Account linked</Text>
              </View>
              <View style={styles.step}>
                <Icon name={slot.kind === "delivery" ? "bicycle-outline" : "storefront-outline"} color={colors.accent} size={18} />
                <Text style={styles.stepText}>{slot.label}</Text>
              </View>
              <Button
                label={starting === store.id ? "Starting…" : `Fill my ${store.name} basket`}
                icon="cart-outline"
                onPress={() => start(store)}
                disabled={!left || starting !== null}
              />
            </>
          )}
        </Card>
      ))}

      <Text style={styles.fine}>
        The app adds items to your basket and stops there: you check out and pay in the store's own app or website. Your store login stays on your home server
        (as a browser session); your password isn't stored.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  small: { fontSize: 14, lineHeight: 20, color: colors.muted },
  resume: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.accent, borderRadius: radius.md, paddingHorizontal: 14, height: 52 },
  resumeText: { flex: 1, color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  compare: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: 14 },
  compareTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  warn: { backgroundColor: colors.warnBg, borderColor: colors.warnLine, borderWidth: 1, borderRadius: radius.md, padding: 12 },
  warnText: { fontSize: 14, lineHeight: 20, color: colors.warnInk },
  storeName: { fontSize: 20, fontWeight: "800", color: colors.ink },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  stepText: { flex: 1, fontSize: 15, lineHeight: 20, color: colors.ink },
  fine: { fontSize: 12, lineHeight: 17, color: colors.muted, paddingHorizontal: 4 },
});
