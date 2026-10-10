import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, Icon } from "../components/ui";
import { api, ApiError, type PastTrip } from "../lib/api";
import { useStore } from "../lib/store";
import { colors } from "../lib/theme";

function when(t: number): string {
  return new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const listId = useStore((st) => st.currentListId);
  const listName = useStore((st) => st.lists.find((l) => l.id === st.currentListId)?.name ?? "Shopping");
  const [trips, setTrips] = useState<PastTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api
      .history(useStore.getState().connection(), listId)
      .then((r) => setTrips(r.trips))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load past trips."));
  }, [listId]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.ground }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Icon name="chevron-back" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Past trips
        </Text>
        <Text style={styles.sub}>{listName}</Text>
      </View>

      {!trips && !error ? <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} /> : null}
      {error ? <Text style={styles.sub}>{error}</Text> : null}
      {trips && trips.length === 0 ? (
        <Text style={styles.sub}>No trips yet. Tap "Start shopping" when you're in the shop, and everything you tick is saved here.</Text>
      ) : null}

      {trips?.map((t) => {
        const expanded = open === t.id;
        return (
          <Card key={t.id}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setOpen(expanded ? null : t.id)} style={styles.tripRow}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.tripTitle}>{when(t.startedAt)}</Text>
                <Text style={styles.meta}>
                  {t.shopper} · {t.count} item{t.count === 1 ? "" : "s"}
                </Text>
              </View>
              <View style={{ transform: [{ rotate: expanded ? "0deg" : "-90deg" }] }}>
                <Icon name="chevron-down" size={18} color={colors.muted} />
              </View>
            </Pressable>
            {expanded
              ? t.items.map((it, i) => (
                  <View key={i} style={styles.itemRow}>
                    <Text style={styles.itemName}>{it.name}</Text>
                    <Text style={styles.meta}>{[it.qty > 1 ? `×${it.qty}` : null, it.brand, it.size].filter(Boolean).join(" · ")}</Text>
                  </View>
                ))
              : null}
          </Card>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  tripRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, minHeight: 60 },
  tripTitle: { fontSize: 16, fontWeight: "600", color: colors.ink },
  meta: { fontSize: 13, color: colors.muted },
  itemRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.lineSoft },
  itemName: { fontSize: 15, color: colors.ink, flexShrink: 1 },
});
