import * as Linking from "expo-linking";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon, Stepper, s as ui } from "../../components/ui";
import { api, ApiError, type Order, type OrderLine, type StoreProduct } from "../../lib/api";
import { useStore } from "../../lib/store";
import { colors, radius } from "../../lib/theme";

const STORE_NAMES: Record<string, string> = { tesco: "Tesco", dunnes: "Dunnes Stores", test: "Test Store" };
const euro = (n: number | null) => (n == null ? "" : `€${n.toFixed(2)}`);
const priceOf = (p: StoreProduct) => (p.memberPrice != null && p.price != null && p.memberPrice < p.price ? `${euro(p.memberPrice)} member` : euro(p.price));
const wanted = (l: OrderLine) => [l.brand, l.name, l.size].filter(Boolean).join(" ");

/** Review matches, pick substitutes, fill the basket, then hand over to the store's app to check out. */
export default function OrderScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [searching, setSearching] = useState<Record<string, string>>({});
  const [showExact, setShowExact] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conn = () => useStore.getState().connection();

  const load = useCallback(async () => {
    try {
      const { order: next } = await api.order(conn(), id);
      setOrder(next);
      if (next.status === "matching" || next.status === "filling") timer.current = setTimeout(load, 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the order.");
      timer.current = setTimeout(load, 3000);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  async function change(line: OrderLine, c: { choose: string } | { skip: true } | { qty: number } | { search: string }) {
    setBusyLine(line.itemId);
    try {
      setOrder((await api.changeLine(conn(), id, line.itemId, c)).order);
    } catch (err) {
      Alert.alert("Couldn't change that", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setBusyLine(null);
    }
  }

  async function fill() {
    try {
      await api.fillBasket(conn(), id);
      if (timer.current) clearTimeout(timer.current);
      await load();
    } catch (err) {
      Alert.alert("Not yet", err instanceof ApiError ? err.message : "Try again.");
    }
  }

  function tickOrdered() {
    const added = order?.lines.filter((l) => l.status === "added").map((l) => l.itemId) ?? [];
    const st = useStore.getState();
    for (const itemId of added) {
      const item = st.items.find((i) => i.id === itemId);
      if (item && !item.done) st.toggle(itemId);
    }
    router.dismissTo("/");
  }

  const storeName = order ? (STORE_NAMES[order.store] ?? order.store) : "";
  const lines = order?.lines ?? [];
  const choose = lines.filter((l) => l.status === "choose");
  const notFound = lines.filter((l) => l.status === "not_found");
  const ready = lines.filter((l) => l.status === "exact" || l.status === "chosen");
  const skipped = lines.filter((l) => l.status === "skipped");
  const added = lines.filter((l) => l.status === "added");
  const failed = lines.filter((l) => l.status === "failed");
  const matched = lines.filter((l) => l.status !== "pending").length;
  const total = ready.reduce((sum, l) => sum + (l.chosen?.memberPrice ?? l.chosen?.price ?? 0) * l.qty, 0);

  const SearchAgain = ({ line }: { line: OrderLine }) =>
    searching[line.itemId] !== undefined ? (
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
        <TextInput
          accessibilityLabel={`Search ${storeName} for ${line.name}`}
          autoFocus
          value={searching[line.itemId]}
          onChangeText={(t) => setSearching((s) => ({ ...s, [line.itemId]: t }))}
          onSubmitEditing={() => {
            const q = searching[line.itemId].trim();
            if (q) void change(line, { search: q });
            setSearching(({ [line.itemId]: _, ...rest }) => rest);
          }}
          returnKeyType="search"
          style={[ui.input, { flex: 1 }]}
        />
      </View>
    ) : null;

  const LineActions = ({ line }: { line: OrderLine }) => (
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" onPress={() => setSearching((s) => ({ ...s, [line.itemId]: line.name }))} style={styles.action}>
        <Icon name="search" size={16} color={colors.ink} />
        <Text style={styles.actionText}>Search again</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => change(line, { skip: true })} style={styles.action}>
        <Icon name="close" size={16} color={colors.ink} />
        <Text style={styles.actionText}>Skip</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.ground }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 8, paddingHorizontal: 4 }}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
            <Icon name="chevron-back" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>
            {storeName || "Order"} basket
          </Text>
          {order ? (
            <View style={styles.slot}>
              <Icon name={order.slot.kind === "delivery" ? "bicycle-outline" : "storefront-outline"} size={16} color={colors.accentInk} />
              <Text style={styles.slotText}>{order.slot.label}</Text>
            </View>
          ) : null}
        </View>

        {!order && !error ? <ActivityIndicator color={colors.accent} style={{ marginTop: 32 }} /> : null}
        {error && !order ? <Text style={styles.sub}>{error}</Text> : null}

        {order?.status === "matching" ? (
          <Card style={{ padding: 16, gap: 10 }}>
            <Text style={styles.cardTitle}>
              Finding your items at {storeName}… {matched} of {lines.length}
            </Text>
            <View style={styles.bar}>
              <View style={[styles.barFill, { width: `${lines.length ? (100 * matched) / lines.length : 0}%` }]} />
            </View>
            <Text style={styles.small}>Exact matches go straight in. Anything without one will be waiting for you to choose.</Text>
          </Card>
        ) : null}

        {order?.status === "filling" ? (
          <Card style={{ padding: 16, gap: 10, alignItems: "center" }}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.cardTitle}>Adding {ready.length} items to your {storeName} basket…</Text>
            <Text style={[styles.small, { textAlign: "center" }]}>This takes a few seconds per item. You can leave this screen.</Text>
          </Card>
        ) : null}

        {order?.status === "failed" ? <Text style={[styles.small, { color: colors.danger }]}>Something went wrong: {order.error}</Text> : null}

        {order?.status === "done" ? (
          <Card style={{ padding: 16, gap: 12, borderColor: colors.accent }}>
            <Text style={styles.headline}>
              {added.length} item{added.length === 1 ? "" : "s"} in your {storeName} basket
            </Text>
            {failed.length ? (
              <View style={{ gap: 4 }}>
                <Text style={[styles.small, { color: colors.danger, fontWeight: "700" }]}>Couldn't add {failed.length}:</Text>
                {failed.map((l) => (
                  <Text key={l.itemId} style={styles.small}>
                    • {l.chosen?.name ?? l.name}
                    {l.error ? `: ${l.error}` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
            {skipped.length || notFound.length ? (
              <Text style={styles.small}>Not added: {[...notFound, ...skipped].map((l) => l.name).join(", ")}. They stay on your list.</Text>
            ) : null}
            <Button label={`Check out in ${storeName}`} icon="open-outline" onPress={() => Linking.openURL(order.basketUrl)} />
            <Button label="Tick ordered items off the list" variant="secondary" onPress={tickOrdered} disabled={!added.length} />
          </Card>
        ) : null}

        {order?.status === "review" && choose.length ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.h2}>Choose a substitute ({choose.length})</Text>
            {choose.map((line) => (
              <Card key={line.itemId}>
                <View style={styles.lineHead}>
                  <Text style={styles.lineTitle}>
                    {line.qty > 1 ? `${line.qty} × ` : ""}
                    {wanted(line)}
                  </Text>
                  <Text style={styles.small}>No exact match. Pick one:</Text>
                </View>
                {line.options.map((p) => (
                  <Pressable
                    key={p.ref}
                    accessibilityRole="button"
                    disabled={busyLine === line.itemId}
                    onPress={() => change(line, { choose: p.ref })}
                    style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.accentTint }]}
                  >
                    <View style={styles.radio} />
                    <Text style={styles.optionName}>{p.name}</Text>
                    <Text style={styles.optionPrice}>{priceOf(p)}</Text>
                  </Pressable>
                ))}
                <SearchAgain line={line} />
                <LineActions line={line} />
              </Card>
            ))}
          </View>
        ) : null}

        {order?.status === "review" && notFound.length ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.h2}>Not found ({notFound.length})</Text>
            {notFound.map((line) => (
              <Card key={line.itemId}>
                <View style={styles.lineHead}>
                  <Text style={styles.lineTitle}>{wanted(line)}</Text>
                  <Text style={styles.small}>{line.error ? "The store search didn't work for this one." : `Nothing similar at ${storeName}. It won't be added unless you search again.`}</Text>
                </View>
                <SearchAgain line={line} />
                <LineActions line={line} />
              </Card>
            ))}
          </View>
        ) : null}

        {order && ready.length && order.status !== "done" ? (
          <View style={{ gap: 8 }}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showExact }} onPress={() => setShowExact(!showExact)} style={styles.h2Row}>
              <Text style={styles.h2}>Going in the basket ({ready.length})</Text>
              <View style={{ transform: [{ rotate: showExact ? "0deg" : "-90deg" }] }}>
                <Icon name="chevron-down" size={18} color={colors.muted} />
              </View>
            </Pressable>
            {showExact ? (
              <Card>
                {ready.map((line, i) => (
                  <View key={line.itemId} style={[styles.readyRow, i > 0 && styles.border]}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.optionName}>{line.chosen?.name}</Text>
                      <Text style={styles.small}>
                        {line.status === "chosen" ? `Your pick for ${line.name}` : `Exact match for ${line.name}`} · {priceOf(line.chosen!)}
                      </Text>
                    </View>
                    {order.status === "review" ? <Stepper value={line.qty} onChange={(qty) => change(line, { qty })} /> : <Text style={styles.optionPrice}>×{line.qty}</Text>}
                  </View>
                ))}
              </Card>
            ) : null}
          </View>
        ) : null}

        {skipped.length && order?.status !== "matching" ? (
          <Text style={styles.small}>
            Skipped: {skipped.map((l) => l.name).join(", ")}
          </Text>
        ) : null}
      </ScrollView>

      {order?.status === "review" ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
          <Text style={styles.small}>
            {choose.length ? `Choose or skip ${choose.length} more` : `About ${euro(total)} for ${ready.length} items, before offers and fees`}
          </Text>
          <Button label={`Add ${ready.length} to ${storeName} basket`} icon="cart" onPress={fill} disabled={choose.length > 0 || ready.length === 0} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", height: 44, alignSelf: "flex-start", marginLeft: -6 },
  backText: { fontSize: 16, fontWeight: "600", color: colors.ink },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5, color: colors.ink },
  sub: { fontSize: 15, lineHeight: 21, color: colors.muted },
  small: { fontSize: 13, lineHeight: 18, color: colors.muted },
  slot: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: colors.accentTint, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  slotText: { fontSize: 14, fontWeight: "700", color: colors.accentInk },
  cardTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  headline: { fontSize: 20, fontWeight: "800", color: colors.accentInk },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.chip, overflow: "hidden" },
  barFill: { height: 8, backgroundColor: colors.accent },
  h2: { marginHorizontal: 4, fontSize: 13, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", color: colors.muted },
  h2Row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 32, paddingRight: 4 },
  lineHead: { padding: 14, paddingBottom: 8, gap: 2 },
  lineTitle: { fontSize: 16, fontWeight: "700", color: colors.ink },
  option: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52, borderTopWidth: 1, borderTopColor: colors.lineSoft },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.unchecked },
  optionName: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.ink },
  optionPrice: { fontSize: 14, fontWeight: "700", color: colors.ink },
  actions: { flexDirection: "row", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.lineSoft },
  action: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 40, borderRadius: radius.sm, backgroundColor: colors.chip },
  actionText: { fontSize: 14, fontWeight: "700", color: colors.ink },
  readyRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  border: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  footer: { paddingHorizontal: 16, paddingTop: 12, gap: 8, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line },
});
