import * as Haptics from "expo-haptics";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Card, Icon } from "../components/ui";
import { api, ApiError, type PlanSettings, type Prediction } from "../lib/api";
import { useStore } from "../lib/store";
import { colors, radius } from "../lib/theme";

const HORIZONS = [
  { days: 7, label: "This week" },
  { days: 14, label: "Two weeks" },
];

/** What you'll probably need, worked out from receipts and ticked items. */
export default function PlanScreen() {
  const insets = useSafeAreaInsets();
  const listId = useStore((st) => st.currentListId);
  const sections = useStore((st) => st.sections);
  const [predictions, setPredictions] = useState<Prediction[] | null>(null);
  const [settings, setSettings] = useState<PlanSettings | null>(null);
  const [horizon, setHorizon] = useState(7);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const conn = () => useStore.getState().connection();

  const load = useCallback(
    async (days: number) => {
      try {
        const r = await api.plan(conn(), listId, days);
        setPredictions(r.predictions);
        setSettings(r.settings);
        // Pre-tick the ones we're fairly sure about.
        setPicked(new Set(r.predictions.filter((p) => p.confidence !== "low").map((p) => p.key)));
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Couldn't reach the home server.");
      }
    },
    [listId],
  );

  useFocusEffect(
    useCallback(() => {
      void load(horizon);
    }, [load, horizon]),
  );

  function toggle(key: string) {
    void Haptics.selectionAsync();
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function add(thenShop: boolean) {
    setAdding(true);
    try {
      const { added } = await api.addPlanned(conn(), listId, [...picked], horizon);
      await useStore.getState().sync();
      if (thenShop) router.replace("/online");
      else {
        Alert.alert("Added to your list", `${added.length} item${added.length === 1 ? "" : "s"} added.`);
        router.back();
      }
    } catch (err) {
      Alert.alert("Couldn't add them", err instanceof ApiError ? err.message : "Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function setAuto(autoAdd: boolean) {
    setSettings((s) => (s ? { ...s, autoAdd } : s));
    try {
      const r = await api.planSettings(conn(), listId, { autoAdd, horizonDays: horizon });
      setSettings(r.settings);
      if (autoAdd) {
        await useStore.getState().sync();
        void load(horizon);
      }
    } catch {
      setSettings((s) => (s ? { ...s, autoAdd: !autoAdd } : s));
    }
  }

  const sure = predictions?.filter((p) => p.confidence !== "low") ?? [];
  const maybe = predictions?.filter((p) => p.confidence === "low") ?? [];
  const sectionName = (id: string) => sections.find((s) => s.id === id)?.name ?? "";

  const Row = ({ p, first }: { p: Prediction; first: boolean }) => {
    const on = picked.has(p.key);
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        onPress={() => toggle(p.key)}
        style={({ pressed }) => [styles.row, !first && styles.border, pressed && { backgroundColor: "#F7F8F5" }]}
      >
        {on ? (
          <View style={styles.checked}>
            <Icon name="checkmark" size={17} color="#FFFFFF" />
          </View>
        ) : (
          <View style={styles.unchecked} />
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.name}>
            {p.qty > 1 ? `${p.qty} × ` : ""}
            {[p.brand, p.name, p.size].filter(Boolean).join(" ")}
          </Text>
          <Text style={styles.reason}>{p.reason}</Text>
        </View>
        <Text style={styles.section}>{sectionName(p.sectionId)}</Text>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.ground }}>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 24, gap: 16 }}>
        <View style={{ gap: 8, paddingHorizontal: 4 }}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
            <Icon name="chevron-back" />
            <Text style={styles.backText}>List</Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>
            What you'll need
          </Text>
          <Text style={styles.sub}>Worked out from your receipts and what you've ticked off, including the time of year.</Text>
        </View>

        <View style={styles.segment}>
          {HORIZONS.map((h) => (
            <Pressable
              key={h.days}
              accessibilityRole="button"
              accessibilityState={{ selected: horizon === h.days }}
              onPress={() => setHorizon(h.days)}
              style={[styles.segBtn, horizon === h.days && styles.segOn]}
            >
              <Text style={[styles.segText, horizon === h.days && { color: colors.ink }]}>{h.label}</Text>
            </Pressable>
          ))}
        </View>

        {error ? <Text style={[styles.sub, { color: colors.danger }]}>{error}</Text> : null}
        {!predictions && !error ? <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} /> : null}

        {predictions && predictions.length === 0 ? (
          <Card style={{ padding: 16, gap: 10 }}>
            <Text style={styles.cardTitle}>Nothing to suggest yet</Text>
            <Text style={styles.sub}>
              Add a few receipts (or your old ones in one go) and tick things off as you shop. After a few weeks this fills itself in.
            </Text>
            <Button label="Add receipts" icon="receipt-outline" onPress={() => router.push("/receipts")} />
          </Card>
        ) : null}

        {sure.length ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.h2}>Very likely ({sure.length})</Text>
            <Card>
              {sure.map((p, i) => (
                <Row key={p.key} p={p} first={i === 0} />
              ))}
            </Card>
          </View>
        ) : null}

        {maybe.length ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.h2}>Maybe ({maybe.length})</Text>
            <Card>
              {maybe.map((p, i) => (
                <Row key={p.key} p={p} first={i === 0} />
              ))}
            </Card>
          </View>
        ) : null}

        {settings ? (
          <Card style={{ padding: 16, gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Keep my list topped up</Text>
                <Text style={styles.reason}>
                  Adds the "very likely" items automatically when they're due. Remove one and it's skipped for a week.
                </Text>
              </View>
              <Switch value={settings.autoAdd} onValueChange={setAuto} trackColor={{ true: colors.accent }} accessibilityLabel="Keep my list topped up" />
            </View>
          </Card>
        ) : null}

        <View style={styles.links}>
          <Pressable accessibilityRole="button" onPress={() => router.push("/receipts")} style={styles.link}>
            <Icon name="receipt-outline" color={colors.accent} size={20} />
            <Text style={styles.linkText}>Receipts</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.push("/trends")} style={styles.link}>
            <Icon name="stats-chart-outline" color={colors.accent} size={20} />
            <Text style={styles.linkText}>Trends</Text>
          </Pressable>
        </View>
      </ScrollView>

      {predictions?.length ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) + 4 }]}>
          <Button label={`Add ${picked.size} to list`} variant="secondary" onPress={() => add(false)} disabled={!picked.size || adding} style={{ flex: 1 }} />
          <Button label="Add & fill basket" icon="cart-outline" onPress={() => add(true)} disabled={!picked.size || adding} style={{ flex: 1.3 }} />
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
  segment: { flexDirection: "row", backgroundColor: colors.chip, borderRadius: radius.pill, padding: 4, gap: 4 },
  segBtn: { flex: 1, height: 38, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  segOn: { backgroundColor: colors.surface },
  segText: { fontSize: 15, fontWeight: "700", color: colors.muted },
  h2: { marginHorizontal: 4, fontSize: 13, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase", color: colors.muted },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  border: { borderTopWidth: 1, borderTopColor: colors.lineSoft },
  checked: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  unchecked: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: colors.unchecked },
  name: { fontSize: 16, fontWeight: "600", color: colors.ink },
  reason: { fontSize: 13, lineHeight: 18, color: colors.muted },
  section: { fontSize: 12, color: colors.faint, maxWidth: 80, textAlign: "right" },
  links: { flexDirection: "row", gap: 10 },
  link: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 48, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  linkText: { fontSize: 15, fontWeight: "700", color: colors.accent },
  footer: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.line },
});
