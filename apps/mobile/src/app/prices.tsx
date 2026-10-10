import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon } from "../components/ui";
import { api, ApiError, type PriceCheck } from "../lib/api";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

const euro = (n: number) => `€${n.toFixed(2)}`;

function ago(t: number): string {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export default function PricesScreen() {
  const insets = useSafeAreaInsets();
  const listId = useStore((st) => st.currentListId);
  const listName = useStore((st) => st.lists.find((l) => l.id === st.currentListId)?.name ?? "Shopping");
  const left = useStore((st) => st.items.filter((i) => i.listId === st.currentListId && !i.done).length);
  const [check, setCheck] = useState<PriceCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openStore, setOpenStore] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback((id: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { check: next } = await api.priceCheck(useStore.getState().connection(), id);
        setCheck(next);
        if (next.status === "running") poll(id);
      } catch {
        poll(id);
      }
    }, 2000);
  }, []);

  useEffect(() => {
    api
      .latestPriceCheck(useStore.getState().connection(), listId)
      .then(({ check: latest }) => {
        setCheck(latest);
        if (latest?.status === "running") poll(latest.id);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't reach the home server."))
      .finally(() => setLoading(false));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [listId, poll]);

  async function start() {
    setError(null);
    try {
      // Make sure the server has the latest list before it starts searching.
      await useStore.getState().sync();
      const { id } = await api.startPriceCheck(useStore.getState().connection(), listId);
      const { check: started } = await api.priceCheck(useStore.getState().connection(), id);
      setCheck(started);
      poll(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the price check.");
    }
  }

  const running = check?.status === "running";
  const cmp = check?.comparison;
  const cheapest = cmp?.cheapest ? check?.stores.find((s) => s.id === cmp.cheapest) : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.ground }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <View style={{ gap: 8, paddingHorizontal: 4 }}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Icon name="chevron-back" />
          <Text style={styles.backText}>List</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Compare prices
        </Text>
        <Text style={styles.sub}>
          {listName} · {left} item{left === 1 ? "" : "s"} to buy
        </Text>
      </View>

      {loading ? <ActivityIndicator color={colors.accent} style={{ marginTop: 32 }} /> : null}

      {error ? (
        <View style={styles.warn}>
          <Text style={styles.warnText}>{error}</Text>
        </View>
      ) : null}

      {running ? (
        <Card style={{ padding: 16, gap: 10 }}>
          <Text style={styles.cardTitle}>Checking Tesco and Dunnes…</Text>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${check.progress.total ? (100 * check.progress.done) / check.progress.total : 0}%` }]} />
          </View>
          <Text style={styles.small}>
            {check.progress.done} of {check.progress.total} searches. Searches are spaced a few seconds apart, so a long list takes a few minutes. You can leave this screen.
          </Text>
        </Card>
      ) : null}

      {cheapest && cmp && !running ? (
        <Card style={{ padding: 16, gap: 6, borderColor: colors.accent }}>
          <Text style={styles.headline}>
            {cheapest.name} is {euro(cmp.saving)} cheaper
          </Text>
          <Text style={styles.small}>
            On the {cmp.items} item{cmp.items === 1 ? "" : "s"} both stores have:{" "}
            {check!.stores.map((s) => `${s.name} ${euro(cmp.totals[s.id] ?? 0)}`).join(" · ")}
          </Text>
        </Card>
      ) : null}

      {check && check.stores.some((s) => s.items.length) ? (
        check.stores.map((s) => {
          const open = openStore === s.id;
          return (
            <Card key={s.id}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpenStore(open ? null : s.id)} style={styles.storeRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.cardTitle}>{s.name}</Text>
                  <Text style={styles.small}>
                    {s.found} found{s.missing ? ` · ${s.missing} not found` : ""}
                  </Text>
                </View>
                <Text style={styles.total}>{euro(s.total)}</Text>
                <View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
                  <Icon name="chevron-down" size={18} color={colors.muted} />
                </View>
              </Pressable>
              {open
                ? s.items.map((it) => (
                    <View key={it.itemId} style={styles.itemRow}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.itemName}>
                          {it.qty > 1 ? `${it.qty} × ` : ""}
                          {it.name}
                        </Text>
                        {it.match ? (
                          <Text style={styles.small}>
                            {it.match.name}
                            {it.match.memberPrice != null && it.match.memberPrice < it.match.price ? ` · member price ${euro(it.match.memberPrice)} (shelf ${euro(it.match.price)})` : ""}
                            {it.match.promo ? ` · ${it.match.promo}` : ""}
                            {it.confidence === "low" ? " · unsure match" : ""}
                          </Text>
                        ) : (
                          <Text style={[styles.small, { color: it.error ? colors.danger : colors.muted }]}>{it.error ? "Couldn't load the store page" : "Not found"}</Text>
                        )}
                      </View>
                      <Text style={styles.price}>{it.lineTotal != null ? euro(it.lineTotal) : "–"}</Text>
                    </View>
                  ))
                : null}
            </Card>
          );
        })
      ) : !loading && !running ? (
        <Text style={styles.sub}>See what this list would cost at Tesco and Dunnes. The server searches each store's website for every item still to buy.</Text>
      ) : null}

      {check?.status === "failed" ? <Text style={[styles.small, { color: colors.danger }]}>The last check failed: {check.error}</Text> : null}

      {!running && !loading ? (
        <Button label={check ? "Check again" : "Check prices"} icon="pricetags-outline" onPress={start} disabled={left === 0} />
      ) : null}
      {check?.finishedAt && !running ? <Text style={[styles.small, { textAlign: "center" }]}>Last checked {ago(check.finishedAt)}. Results are reused for 12 hours.</Text> : null}

      <Text style={styles.fine}>
        Read-only: nothing is added to a basket and the app never signs in to your store accounts. Prices come from the stores' websites and are
        matched automatically, so check before you buy. Member prices (e.g. Clubcard) are used where shown.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  warn: { backgroundColor: colors.warnBg, borderColor: colors.warnLine, borderWidth: 1, borderRadius: radius.md, padding: 12 },
  warnText: { fontSize: 14, lineHeight: 20, color: colors.warnInk },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.ink },
  headline: { fontSize: 20, fontWeight: "800", color: colors.accentInk },
  small: { fontSize: 13, lineHeight: 18, color: colors.muted },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.chip, overflow: "hidden" },
  barFill: { height: 8, backgroundColor: colors.accent },
  storeRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, minHeight: 64 },
  total: { fontSize: 20, fontWeight: "800", color: colors.ink },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.lineSoft },
  itemName: { fontSize: 15, fontWeight: "600", color: colors.ink },
  price: { fontSize: 15, fontWeight: "700", color: colors.ink, minWidth: 60, textAlign: "right" },
  fine: { fontSize: 12, lineHeight: 17, color: colors.muted, paddingHorizontal: 4 },
});
